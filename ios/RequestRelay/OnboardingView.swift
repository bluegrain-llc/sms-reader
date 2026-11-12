import SwiftUI
import FirebaseAuth
import CoreImage.CIFilterBuiltins

struct OnboardingView: View {
    @EnvironmentObject var model: RelayModel
    let target: RelayDestination
    @State private var approval: Approval?
    @State private var forms = true
    @State private var sms = false
    @State private var days = 0
    @State private var attempt = UUID().uuidString
    @State private var status = ""
    @State private var failed = false
    @State private var needsDevice = false
    @Environment(\.openURL) private var openURL
    private var registration: Bool { target.kind == "register" }
    private var management: Bool { target.kind == "connections" }
    private var prefix: String { target.kind == "oauth" ? "/v3/oauth/sessions" : registration ? "/v3/registration-sessions" : "/v3/pairing-sessions" }
    var body: some View {
        NavigationStack {
            Form {
                if !model.signedIn { SignInPanel() }
                else if let approval {
                    Section {
                        Text(approval.name).font(.title.weight(.semibold)); Text(approval.purpose)
                        Text("Signed in as \(model.identity)").font(.footnote).foregroundStyle(.secondary)
                        Button("Use a different account") { model.clearResponses(); try? Auth.auth().signOut() }
                        Text("The agent name is supplied by its operator. Registration is not verification or endorsement.").font(.footnote).foregroundStyle(.secondary)
                        if let client = approval.clientName { Text("Requested by \(client) (\(approval.clientOrigin ?? "")).") }
                        if let code = approval.comparisonCode { Text("Compare code").foregroundStyle(.secondary); Text(code).font(.largeTitle.monospacedDigit()).accessibilityLabel("Comparison code \(code)") }
                    }
                    if approval.status == "pending" || (management && approval.revoked == false) {
                        if registration { Section { Text("Registering grants no account access. Connect to this agent separately to share responses.") } }
                        else if target.kind == "legacy" { Section("Requested access") { Text("Upcoming SMS codes, with your approval."); Text("Duration: \(approval.expiresInDays ?? 0) days") } }
                        else {
                            Section("Allow requests for") {
                                if (approval.availableCapabilities ?? approval.capabilities).contains("forms") { Toggle("Forms and decisions", isOn: $forms) }
                                if (approval.availableCapabilities ?? approval.capabilities).contains("sms") { Toggle("Upcoming SMS codes, with approval", isOn: $sms) }
                                Picker("Duration", selection: $days) {
                                    ForEach(durations(approval), id: \.self) { value in Text(value == 0 ? "Until disconnected" : "\(value) days").tag(value) }
                                }
                                Text("Every response still needs your approval.").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        Section {
                            Button(registration ? "Register agent" : management ? "Save permissions" : "Connect") { Task { await model.perform { try await decide(true) } } }.disabled(!registration && !forms && !sms)
                            Button(management ? "Disconnect" : "Cancel", role: .destructive) { Task { await model.perform { try await decide(false) } } }
                        }
                    }
                    Text(status)
                    if target.kind == "services", approval.status == "expired" || approval.status == "denied" {
                        Button("Start a new connection") { UserDefaults.standard.removeObject(forKey: "pair-attempt:\(model.authentication.user?.uid ?? ""):\(target.value)"); attempt = UUID().uuidString; Task { await load() } }
                    }
                    if approval.status == "approved", !registration, let id = approval.connectionId {
                        Button("Manage permissions") { model.destination = .init(kind: "connections", value: id) }
                        if needsDevice { Button("Connect this device") { Task { await model.perform { try await model.registerDevice() } } } }
                        if target.kind == "oauth" { Button("Continue to requesting app") { Task { await model.perform {
                            struct Redirect: Decodable { let redirect: String }
                            let result: Redirect = try await model.api.call("/v3/oauth/sessions/\(target.value)/response", method: "POST", body: [:])
                            guard let url = URL(string: result.redirect), ["https","http"].contains(url.scheme ?? "") else { throw RelayFailure.unavailable }
                            openURL(url)
                        } } } }
                    }
                } else if !failed { ProgressView("Loading approval…") }
                if failed { Text(status); Button("Try again") { Task { await load() } } }
            }.disabled(model.busy).navigationTitle(registration ? "Register agent" : management ? "Manage connection" : "Connect to agent")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { model.closeDestination() } } }
            .task(id: model.signedIn) { if model.signedIn { await load() } }
            .task(id: approval?.connectionId) {
                guard approval?.status == "approved", !registration, let id = approval?.connectionId else { return }
                while !Task.isCancelled {
                    do {
                        struct Setup: Decodable { let setup: String; let receivingDeviceAvailable: Bool; let revoked: Bool }
                        let state: Setup = try await model.api.call("/v3/connections/\(id)")
                        needsDevice = !state.receivingDeviceAvailable && !state.revoked
                        status = state.revoked ? "Disconnected." : needsDevice ? "Access approved. Connect a device to receive requests." : state.setup == "setup_complete" ? "Setup complete. The agent can request your approval." : "Access approved. Waiting for the agent to save its connection…"
                        if state.revoked || state.setup == "setup_complete" { break }
                    } catch { status = "Access was approved. Could not refresh setup; reopen this link to check again."; break }
                    try? await Task.sleep(for: .seconds(5))
                }
            }
        }
    }
    private func durations(_ a: Approval) -> [Int] {
        let values = Set([0,1,7,30,90,days] + (a.expiresInDays.map { [$0] } ?? []))
        return values.filter { management || a.expiresInDays == nil || ($0 != 0 && $0 <= a.expiresInDays!) }.sorted()
    }
    private func load() async {
        failed = false
        do {
            if target.kind == "legacy" {
                struct Legacy: Decodable { let callerName: String; let purpose: String; let status: String; let expiresAt: Double; let expiresInDays: Int }
                let value: Legacy = try await model.api.call("/v1/connections/review", method: "POST", body: ["userCode":target.value])
                approval = Approval(name: value.callerName, purpose: value.purpose, capabilities: ["sms"], status: value.status, expiresAt: value.expiresAt, expiresInDays: value.expiresInDays, comparisonCode: target.value)
            }
            else if management { approval = try await model.api.call("/v3/connections/\(target.value)") }
            else if target.kind == "services" {
                let service: Agent = try await model.api.call("/v3/services/\(target.value)")
                let key = "pair-attempt:\(model.authentication.user?.uid ?? ""):\(target.value)"
                attempt = UserDefaults.standard.string(forKey: key) ?? attempt; UserDefaults.standard.set(attempt, forKey: key)
                approval = try await model.api.call("/v3/services/\(target.value)/connections", method: "POST", body: ["capabilities":service.capabilities,"expiresInDays":NSNull(),"idempotencyKey":attempt])
            } else { approval = try await model.api.call("\(prefix)/\(target.value)") }
            if let a = approval { forms = a.capabilities.contains("forms"); sms = a.capabilities.contains("sms"); days = a.expiresInDays ?? (management ? a.expiresAt.map { Swift.max(1, Int(ceil(($0 - Date().timeIntervalSince1970 * 1000) / 86400000))) } ?? 0 : 0)
                if management { status = a.revoked == true ? "Disconnected." : "Review and save permissions explicitly." }
                else { status = label(a.status) }
            }
        } catch { failed = true; status = (error as? RelayFailure)?.localizedDescription ?? "Could not load this link. Retry." }
    }
    private func label(_ state: String?) -> String {
        switch state { case "approved": return registration ? "Agent registered. Return to your agent to finish saving its session. No account access was granted." : "Access approved. The agent must save its connection before requesting responses."
        case "expired": return "This session expired. Reopen or rescan a fresh link."
        case "denied": return "Cancelled. No new access was granted."
        default: return "Review identity, permissions and duration before approving." }
    }
    private func decide(_ approved: Bool) async throws {
        guard let a = approval else { return }
        let caps = registration ? a.capabilities : (forms ? ["forms"] : []) + (sms ? ["sms"] : [])
        if target.kind == "legacy" {
            let _: EmptyReply = try await model.api.call("/v1/connections/decision", method: "POST", body: ["userCode":target.value,"decision":approved ? "approved" : "denied"])
            await load(); return
        }
        if management {
            if approved {
                let _: EmptyReply = try await model.api.call("/v3/connections/\(target.value)", method: "PATCH", body: ["capabilities":caps,"expiresAt":days == 0 ? NSNull() : NSNumber(value: Date().timeIntervalSince1970 * 1000 + Double(days) * 86400000)])
                status = "Permissions saved."
            } else { let _: EmptyReply = try await model.api.call("/v3/connections/\(target.value)", method: "DELETE"); await load() }
        } else {
            guard let id = a.sessionId else { throw RelayFailure.unavailable }
            var body: [String: Any] = ["decision":approved ? "approved" : "denied","capabilities":caps.isEmpty ? a.capabilities : caps,"expiresInDays":days == 0 ? NSNull() : NSNumber(value: days)]
            if registration { body["selfAccess"] = false }
            let _: EmptyReply = try await model.api.call("\(prefix)/\(id)/decision", method: "POST", body: body)
            if target.kind == "services" { approval = try await model.api.call("/v3/pairing-sessions/\(id)"); status = label(approval?.status) }
            else { await load() }
            if target.kind == "services", approval?.status == "approved" { UserDefaults.standard.removeObject(forKey: "pair-attempt:\(model.authentication.user?.uid ?? ""):\(target.value)") }
        }
    }
}
struct PublicQRCode: View {
    let url: URL
    var body: some View {
        if let image = qrImage() { Image(uiImage: image).interpolation(.none).resizable().scaledToFit().frame(maxWidth: 240).padding(12).background(.white).accessibilityLabel("Connect to agent QR code") }
    }
    func qrImage() -> UIImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(url.absoluteString.utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage, let cg = CIContext().createCGImage(output.transformed(by: .init(scaleX: 8, y: 8)), from: output.extent.applying(.init(scaleX: 8, y: 8))) else { return nil }
        return UIImage(cgImage: cg)
    }
}
