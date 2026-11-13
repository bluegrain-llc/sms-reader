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
#endif
