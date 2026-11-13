#if DEBUG
import SwiftUI

/// Offline simulator fixtures. They contain synthetic data and are absent from release builds.
struct UIContractHarness: View {
    @StateObject private var codeDraft = ResponseDraft()
    @StateObject private var formDraft = ResponseDraft()
    @StateObject private var numberDraft = ResponseDraft()
    @State private var privacySheet = false
    @State private var previewPhase: ScenePhase = .active
    @State private var codeExpiry = (Date().timeIntervalSince1970 + 300) * 1000
    private let expiry = (Date().timeIntervalSince1970 + 300) * 1000
    var body: some View {
        NavigationStack {
            List {
                Button("Private modal") { previewPhase = .active; privacySheet = true }
                NavigationLink("Code submission without polling") { TerminalSubmissionHarness(form: false) }
                NavigationLink("Form submission without polling") { TerminalSubmissionHarness(form: true) }
                NavigationLink("Cancelled code without polling") { TerminalSubmissionHarness(form: false, external: true) }
                NavigationLink("Cancelled form without polling") { TerminalSubmissionHarness(form: true, external: true) }
                NavigationLink("Manual code") {
                    VStack {
                        CodeEditor(request: SMSRequest(requestId: "fixture-code", callerName: "Synthetic agent", title: "Test sign-in", purpose: "Share only by tapping Send.", status: "ready", expiresAt: expiry, manualEntryDeadline: codeExpiry), draft: codeDraft)
                        Button("Expire entry window") { codeExpiry = 0 }
                    }
                }
                NavigationLink("Numeric draft") {
                    VStack {
                        NativeField(field: .init(id: "number", label: "Private number", type: "number", required: false), values: $numberDraft.values, numberInputs: $numberDraft.numberInputs)
                        Button("Clear retained draft") { numberDraft.clear() }
                    }.padding()
                }
                NavigationLink("Wizard request") {
                    FormEditor(request: FormRequest(requestId: "fixture-wizard", callerName: "Synthetic agent", title: "Test wizard", body: "Choose what to share.", status: "pending", expiresAt: expiry,
                        fields: [.init(id: "include", label: "Include details", type: "checkbox", required: false), .init(id: "details", label: "Details", type: "text", required: true)],
                        actions: [.init(id: "send", label: "Send response", type: "submit")],
                        steps: [.init(id: "choice", title: "Choose", fieldIds: ["include"]), .init(id: "details", title: "Details", fieldIds: ["details"], when: .init(fieldId: "include", equals: .boolean(true)))]), draft: formDraft)
                }
            }.navigationTitle("Simulator contracts")
        }.sheet(isPresented: $privacySheet) {
            VStack {
                Text("Synthetic private response").accessibilityIdentifier("private-modal-response")
                Button("Hide preview") { previewPhase = .inactive }
            }.modifier(ResponsePrivacyCover(phase: previewPhase))
        }
    }
}

struct TerminalSubmissionHarness: View {
    let form: Bool
    let external: Bool
    @StateObject private var api: TerminalSubmissionAPI
    @StateObject private var model: RelayModel
    @StateObject private var draft: ResponseDraft
    private let expiry: Double
    init(form: Bool, external: Bool = false) {
        self.form = form; self.external = external
        let expiry = (Date().timeIntervalSince1970 + 300) * 1000
        self.expiry = expiry
        let api = TerminalSubmissionAPI(), model = RelayModel(api: api)
        model.signedIn = true
        _api = StateObject(wrappedValue: api); _model = StateObject(wrappedValue: model)
        _draft = StateObject(wrappedValue: model.draft(form ? "fixture-form" : "fixture-code", expiresAt: expiry))
    }
    var body: some View {
        VStack {
            if form {
                FormEditor(request: FormRequest(requestId: "fixture-form", callerName: "Synthetic agent", title: "Response", body: "Test terminal submission.", status: "pending", expiresAt: expiry,
                    fields: [.init(id: "answer", label: "Answer", type: "text", required: true)], actions: [.init(id: "send", label: "Send response", type: "submit")]), draft: draft)
            } else {
                CodeEditor(request: SMSRequest(requestId: "fixture-code", callerName: "Synthetic agent", title: "Code", purpose: "Test terminal submission.", status: "ready", expiresAt: expiry), draft: draft)
            }
            if external { Button("Cancel request on relay") { model.discard(form ? "fixture-form" : "fixture-code", status: "cancelled") } }
            if api.refreshPending {
                Text("Refresh is waiting").accessibilityIdentifier("terminal-refresh-pending")
                Button("Finish refresh") { api.finishRefresh() }
            }
        }.environmentObject(model).onDisappear { api.finishRefresh() }
    }
}

@MainActor
private final class TerminalSubmissionAPI: ObservableObject, RelayCalling {
    let origin = URL(string: "https://relay.example")!
    @Published private(set) var refreshPending = false
    private var releaseRefresh = false
    private var refreshContinuation: CheckedContinuation<Void, Never>?
    func finishRefresh() {
        releaseRefresh = true
        refreshContinuation?.resume(); refreshContinuation = nil
    }
    func call<T: Decodable>(_ path: String, method: String, body: [String: Any]?) async throws -> T {
        if path == "/v1/devices", method == "GET" {
            refreshPending = true
            defer { refreshPending = false }
            await withTaskCancellationHandler {
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    if releaseRefresh || Task.isCancelled { continuation.resume() }
                    else { refreshContinuation = continuation }
                }
            } onCancel: { Task { @MainActor in self.finishRefresh() } }
            try Task.checkCancellation()
            throw RelayFailure.unavailable
        }
        guard method == "POST" else { throw RelayFailure.unavailable }
        let response: [String: Any]
        if path.hasSuffix("/submissions") {
            response = ["requestId":"fixture-form", "callerName":"Synthetic agent", "title":"Response", "body":"Test terminal submission.", "status":"submitted", "expiresAt":2000000000000, "fields":[], "actions":[]]
        } else if path.hasSuffix("/events") {
            response = ["requestId":"fixture-code", "callerName":"Synthetic agent", "title":"Code", "purpose":"Test terminal submission.", "status":"completed", "expiresAt":2000000000000]
        } else { throw RelayFailure.unavailable }
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: response))
    }
}
#endif
