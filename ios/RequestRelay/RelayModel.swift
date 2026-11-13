import Foundation
import UIKit
import SwiftUI
import FirebaseAuth
import FirebaseCore
import FirebaseMessaging
import UserNotifications

enum RelayFailure: LocalizedError {
    case configuration, authentication, storage, keychain(Int32), unavailable, expired, rejected(String)
    var errorDescription: String? {
        switch self {
        case .configuration: return "Install a configured build to connect to this relay."
        case .authentication: return "Sign-in was not completed. Use the same account and try again. Accounts are linked only through Link account."
        case .storage, .keychain: return "Private storage is unavailable. Retry before continuing."
        case .unavailable: return "The relay is unavailable. Try again."
        case .expired: return "This request or link expired. Ask for a new one."
        case .rejected(let reason):
            if ["session_expired","authorization_finished"].contains(reason) { return "This link expired. Reopen or rescan a fresh link." }
            if reason == "service_unavailable" { return "This agent is unavailable." }
            return "The relay could not accept this action. Refresh its current state and try again."
        }
    }
}
struct EmptyReply: Decodable {}
@MainActor
protocol RelayCalling {
    var origin: URL { get }
    func call<T: Decodable>(_ path: String, method: String, body: [String: Any]?) async throws -> T
}
extension RelayCalling {
    func call<T: Decodable>(_ path: String) async throws -> T { try await call(path, method: "GET", body: nil) }
    func call<T: Decodable>(_ path: String, method: String) async throws -> T { try await call(path, method: method, body: nil) }
}
@MainActor
final class RelayAPI: RelayCalling {
    let origin: URL
    private let session: URLSession
    init(origin: URL) {
        self.origin = origin
        let config = URLSessionConfiguration.ephemeral; config.urlCache = nil; config.httpCookieStorage = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData; config.timeoutIntervalForRequest = 20
        session = URLSession(configuration: config, delegate: RejectRedirects(), delegateQueue: nil)
    }
    func call<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        guard FirebaseApp.app() != nil, origin.scheme == "https", origin.user == nil, origin.password == nil,
              path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: path, relativeTo: origin), url.host == origin.host,
              let user = Auth.auth().currentUser else { throw RelayFailure.authentication }
        let uid = user.uid, token = try await user.getIDToken()
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard Auth.auth().currentUser?.uid == uid else { throw RelayFailure.authentication }
        guard let http = response as? HTTPURLResponse else { throw RelayFailure.unavailable }
        guard (200..<300).contains(http.statusCode) else {
            let reason = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? "unavailable"
            throw RelayFailure.rejected(reason)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor
final class ResponseDraft: ObservableObject {
    @Published var values: [String: Answer] = [:]
    @Published var code = ""
    @Published var numberInputs: [String: String] = [:]
    @Published var stepID: String?
    @Published var review = false
    let submissionID = UUID().uuidString
    func clear() { values = [:]; code = ""; numberInputs = [:]; stepID = nil; review = false }
}
@MainActor
final class FormOpeningObservations: ObservableObject {
    private var accepted = Set<String>()
    func report(fromNotification: Bool, observe: (String) async throws -> Void) async throws {
        var failure: Error?
        for event in (fromNotification ? ["notification.tapped", "request.opened"] : ["request.opened"]) where !accepted.contains(event) {
            do { try await observe(event); accepted.insert(event) }
            catch { if failure == nil { failure = error } }
        }
        if let failure { throw failure }
    }
}
@MainActor
final class RelayModel: ObservableObject {
    let authentication = Authentication()
    let api: any RelayCalling
    @Published var signedIn = false
    @Published var identity = ""
    @Published var inbox: [InboxRow] = []
    @Published var devices: [Device] = []
    @Published var grants: [Grant] = []
    @Published var agents: [Agent] = []
    @Published var history: [HistoryRow] = []
    @Published var sms: SMSRequest?
    @Published var destination: RelayDestination?
    @Published var selectedTab = 0
    @Published var error: String?
    @Published var notice: String?
    @Published var busy = false
    @Published var notificationRequest: String?
    private var resumeWhenConnected = false
    private var removingDevices = Set<String>()
    private var registrationRevision = 0
    private var refreshRevision = 0
    private var pushTokenRevision = 0
    private var synchronizedPushTokenRevision = -1
    private var pushUpdateInProgress = false
    private var requestedPushRegistration = false
    private var cachedDeviceID: String?
    var deviceID: String {
        if let cachedDeviceID { return cachedDeviceID }
        let key = "installation:\(authentication.user?.uid ?? "signed-out")"
        do {
            if let data = try PrivateStorage.read(key), let value = String(data: data, encoding: .utf8) { cachedDeviceID = value; return value }
            let value = UUID().uuidString; try PrivateStorage.write(key, Data(value.utf8)); cachedDeviceID = value; return value
        } catch { self.error = RelayFailure.storage.localizedDescription; return "" }
    }
    private var authListener: AuthStateDidChangeListenerHandle?
    private var owner: String?
    private var drafts: [String: ResponseDraft] = [:]
    private var expiries: [String: Double] = [:]
    private var formDraftIDs = Set<String>()
    init(api: (any RelayCalling)? = nil) {
        let origin = URL(string: Bundle.main.object(forInfoDictionaryKey: "RelayURL") as? String ?? "https://relay.invalid")!
        self.api = api ?? RelayAPI(origin: origin)
        if authentication.configured {
            authListener = Auth.auth().addStateDidChangeListener { [weak self] _, user in
                Task { @MainActor in
                    guard let self else { return }
                    if self.owner != user?.uid { self.clearResponses(); self.cachedDeviceID = nil; self.resumeWhenConnected = false; self.registrationRevision += 1; self.synchronizedPushTokenRevision = -1; self.requestedPushRegistration = false; self.owner = user?.uid; self.inbox = []; self.devices = []; self.grants = []; self.history = []; self.agents = []; self.sms = nil }
                    self.signedIn = user != nil; self.identity = user?.email ?? "Your account"
                    if user != nil { await self.refresh() }
                }
            }
        }
        if let saved = UserDefaults.standard.data(forKey: "public-destination") { destination = try? JSONDecoder().decode(RelayDestination.self, from: saved) }
    }
    func open(_ url: URL) {
        guard let target = RelayDestination.parse(url, origin: api.origin) else { error = "This relay link is not supported."; return }
        UserDefaults.standard.set(try? JSONEncoder().encode(target), forKey: "public-destination"); destination = target
    }
    func closeDestination() { destination = nil; UserDefaults.standard.removeObject(forKey: "public-destination") }
    func draft(_ id: String, expiresAt: Double) -> ResponseDraft {
        expiries[id] = expiresAt
        if let draft = drafts[id] { return draft }
        let draft = ResponseDraft(); drafts[id] = draft; return draft
    }
    func formDraft(_ request: FormRequest) -> ResponseDraft {
        let value = draft(request.id, expiresAt: request.expiresAt)
        formDraftIDs.insert(request.id)
        if request.status != "pending" { discard(request.id) }
        return value
    }
    func prepareFormResponse(_ request: FormRequest, observations: FormOpeningObservations, fromNotification: Bool, receive: (ResponseDraft) -> Void = { _ in }, observe: (String) async throws -> Void) async throws -> ResponseDraft {
        let value = formDraft(request)
        receive(value)
        guard request.status == "pending" else { return value }
        try await observations.report(fromNotification: fromNotification, observe: observe)
        return value
    }
    func updateSMS(_ request: SMSRequest?) {
        if let old = sms, old.id != request?.id { discard(old.id) }
        sms = request
        if let request, !request.active { discard(request.id) }
    }
    func receiveSMS(_ request: SMSRequest) {
        // Only active-request discovery can replace another request's draft.
        if sms?.id == request.id { sms = request }
        if !request.active || (request.manualEntryDeadline ?? request.expiresAt) <= Date().timeIntervalSince1970 * 1000 { discard(request.id) }
    }
    func reconcileFormDrafts(pendingIDs: Set<String>, isCurrent: () -> Bool = { true }, fetch: (String) async throws -> FormRequest) async {
        for id in formDraftIDs.subtracting(pendingIDs) {
            guard isCurrent() else { return }
            guard let retained = drafts[id] else { continue }
            // Absence alone is not terminal: the inbox has a bounded result set.
            if let request = try? await fetch(id), isCurrent(), request.status != "pending", drafts[id] === retained { discard(id) }
        }
    }
    func discard(_ id: String) { drafts[id]?.clear(); drafts.removeValue(forKey: id); expiries.removeValue(forKey: id); formDraftIDs.remove(id) }
    func clearResponses() { drafts.values.forEach { $0.clear() }; drafts = [:]; expiries = [:]; formDraftIDs = [] }
    func expireDrafts() { for (id, expiry) in expiries where expiry <= Date().timeIntervalSince1970 * 1000 { discard(id) } }
    @discardableResult
    func reportResponseFailure(_ failure: Error, fallback: String) -> Bool {
        guard !Task.isCancelled else { return false }
        error = (failure as? RelayFailure)?.localizedDescription ?? fallback
        return true
    }
    func perform(_ action: () async throws -> Void) async {
        guard !busy else { return }; busy = true; error = nil
        defer { busy = false }
        do { try await action() } catch { self.error = (error as? RelayFailure)?.localizedDescription ?? "Could not complete this step. Retry to check its current state." }
    }
    func signIn(_ provider: String, action: AuthAction = .signIn) async {
        await perform { _ = try await authentication.authenticate(provider: provider, action: action); await refresh() }
    }
    func refresh() async {
        guard signedIn else { return }; expireDrafts()
        refreshRevision += 1
        let revision = refreshRevision, registration = registrationRevision, uid = authentication.user?.uid, installation = deviceID
        func isCurrent() -> Bool {
            signedIn && refreshRevision == revision && registrationRevision == registration &&
                authentication.user?.uid == uid && deviceID == installation && !Task.isCancelled
        }
        do {
            let fetched: [Device] = try await api.call("/v1/devices")
            guard isCurrent() else { return }; devices = fetched
            if authentication.configured, acceptsPushUpdates(for: installation) {
                if !requestedPushRegistration { requestedPushRegistration = true; UIApplication.shared.registerForRemoteNotifications() }
                if Messaging.messaging().apnsToken != nil { try? await retryPushTokenUpdate { try await self.registerPushToken() } }
            }
            guard isCurrent() else { return }
            if let device = fetched.first(where: { $0.id == installation }), !device.paused {
                let rows: [InboxRow] = try await api.call("/v2/devices/\(installation)/inbox")
                guard isCurrent() else { return }; inbox = rows
                await reconcileFormDrafts(pendingIDs: Set(rows.map(\.id)), isCurrent: isCurrent) { id in
                    try await self.api.call("/v2/devices/\(installation)/requests/\(id)")
                }
                guard isCurrent() else { return }
                if let id = device.activeRequestId {
                    let request: SMSRequest = try await api.call("/v1/devices/\(installation)/requests/\(id)")
                    guard isCurrent() else { return }; updateSMS(request)
                } else { updateSMS(nil) }
            } else { inbox = []; sms = nil; clearResponses() }
            let fetchedGrants: [Grant] = try await api.call("/v1/callers")
            guard isCurrent() else { return }; grants = fetchedGrants
            let fetchedAgents: [Agent] = try await api.call("/v3/services")
            guard isCurrent() else { return }; agents = fetchedAgents
            let fetchedHistory: [HistoryRow] = try await api.call("/v1/history")
            guard isCurrent() else { return }; history = fetchedHistory
        } catch {
            guard isCurrent() else { return }
            self.error = (error as? RelayFailure)?.localizedDescription ?? "Could not refresh. Pull to try again."
        }
    }
    func registerDevice() async throws {
        guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert,.badge,.sound]) else { throw RelayFailure.rejected("notifications_disabled") }
        resumeWhenConnected = true; requestedPushRegistration = true
        UIApplication.shared.registerForRemoteNotifications()
        // The FCM delegate retries registration when APNs supplies a token.
        if Messaging.messaging().apnsToken != nil { try await updatePushToken() }
    }
    func acceptsPushUpdates(for id: String) -> Bool {
        signedIn && !removingDevices.contains(id) && (resumeWhenConnected || devices.contains { $0.id == id })
    }
    func updatePushToken() async throws {
        pushTokenRevision += 1
        try await retryPushTokenUpdate { try await self.registerPushToken() }
    }
    func retryPushTokenUpdate(update: () async throws -> Void) async throws {
        guard signedIn, !pushUpdateInProgress, synchronizedPushTokenRevision != pushTokenRevision,
              acceptsPushUpdates(for: deviceID) else { return }
        let revision = pushTokenRevision, registration = registrationRevision
        pushUpdateInProgress = true
        defer { pushUpdateInProgress = false }
        try await update()
        if registration == registrationRevision { synchronizedPushTokenRevision = revision }
    }
    private func registerPushToken() async throws {
        guard signedIn else { return }
        let id = deviceID
        guard acceptsPushUpdates(for: id) else { return }
        let revision = registrationRevision, uid = authentication.user?.uid
        let token = try await Messaging.messaging().token()
        guard registrationRevision == revision, authentication.user?.uid == uid, acceptsPushUpdates(for: id) else { return }
        let registeredID = try await registerInstallation(allowReplacement: resumeWhenConnected) { installation in
            let _: EmptyReply = try await self.api.call("/v1/devices/\(installation)", method: "PUT", body: ["name":UIDevice.current.name,"fcmToken":token,"wizardVersion":1,"platform":"ios"])
        }
        let registeredRevision = registrationRevision
        if resumeWhenConnected, authentication.user?.uid == uid, registeredID == deviceID, acceptsPushUpdates(for: registeredID) {
            let _: EmptyReply = try await api.call("/v1/devices/\(registeredID)", method: "PATCH", body: ["paused":false])
            if registrationRevision == registeredRevision { resumeWhenConnected = false }
        }
        await refresh()
    }
    func registerInstallation(allowReplacement: Bool, register: (String) async throws -> Void) async throws -> String {
        let id = deviceID, revision = registrationRevision, uid = authentication.user?.uid
        do { try await register(id); return id }
        catch RelayFailure.rejected(let reason) where reason == "installation_id_unavailable" {
            guard allowReplacement, registrationRevision == revision, authentication.user?.uid == uid else { throw RelayFailure.rejected(reason) }
            let replacement = UUID().uuidString
            try PrivateStorage.write("installation:\(uid ?? "signed-out")", Data(replacement.utf8))
            cachedDeviceID = replacement; registrationRevision += 1; clearResponses()
            try await register(replacement)
            return replacement
        }
    }
    func removeDevice(_ id: String) async throws {
        let current = id == deviceID
        removingDevices.insert(id); registrationRevision += 1
        defer { removingDevices.remove(id) }
        let _: EmptyReply = try await api.call("/v1/devices/\(id)", method: "DELETE")
        if current {
            PrivateStorage.remove("installation:\(authentication.user?.uid ?? "")"); cachedDeviceID = nil; resumeWhenConnected = false; clearResponses()
        }
        await refresh()
    }
    func loadSMS(_ id: String) async throws -> SMSRequest {
        var request: SMSRequest = try await api.call("/v1/devices/\(deviceID)/requests/\(id)")
        if request.status == "pending_phone" {
            request = try await api.call("/v1/devices/\(deviceID)/requests/\(id)/events", method: "POST", body: ["status":"ready","mode":"manual"])
        }
        receiveSMS(request)
        return request
    }
    func submitSMS(_ request: SMSRequest, code: String, deny: Bool = false) async throws {
        guard deny || validCode(code) else { throw RelayFailure.rejected("invalid_code") }
        let body: [String: Any] = deny ? ["status":"denied"] : ["status":"completed","source":"manual","code":code]
        let state: SMSRequest = try await api.call("/v1/devices/\(deviceID)/requests/\(request.id)/events", method: "POST", body: body)
        if !state.active {
            discard(request.id)
            if state.reason == "handled_on_another_device" { notice = "Handled on another device." }
            else if state.status == "completed" { notice = "Response accepted." }
            else if state.status == "denied" { notice = "Request declined." }
            else { notice = "This request is \(state.status). Your code was not sent." }
        }
        receiveSMS(state); await refresh()
    }
    func submitForm(_ request: FormRequest, action: FormAction, draft: ResponseDraft) async throws -> FormRequest {
        let fields = request.visibleFields(draft.values), ids = Set(fields.map(\.id))
        let values = action.type == "decline" ? [:] : draft.values.filter { ids.contains($0.key) }
        guard action.type == "decline" || request.errors(values).isEmpty else { throw RelayFailure.rejected("invalid_form") }
        let encoded = try JSONEncoder().encode(values), object = try JSONSerialization.jsonObject(with: encoded)
        let result: FormRequest = try await api.call("/v2/devices/\(deviceID)/requests/\(request.id)/submissions", method: "POST", body: ["submissionId":draft.submissionID,"action":action.id,"values":object])
        if result.status != "pending" {
            discard(request.id)
            if ["submitted", "declined"].contains(result.status), let winner = result.completedByDeviceId {
                notice = winner != deviceID ? "Handled on another device." : result.status == "submitted" ? "Response accepted." : "Request declined."
            } else { notice = "This request is \(result.status). Your response was not sent." }
        }
        await refresh(); return result
    }
    func deleteAccount() async throws {
        try await authentication.prepareDeletion()
        let _: EmptyReply = try await api.call("/v1/account", method: "DELETE")
        if let uid = authentication.user?.uid { PrivateStorage.remove("provision:\(uid)"); PrivateStorage.remove("installation:\(uid)") }
        clearResponses(); try Auth.auth().signOut(); notice = "Account deletion accepted. Cleanup continues on the server."
    }
}
