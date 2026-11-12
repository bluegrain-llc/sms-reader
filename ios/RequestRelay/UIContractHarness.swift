#if DEBUG
import SwiftUI

/// Offline simulator fixtures. They contain synthetic data and are absent from release builds.
struct UIContractHarness: View {
    @StateObject private var codeDraft = ResponseDraft()
    @StateObject private var formDraft = ResponseDraft()
    private let expiry = (Date().timeIntervalSince1970 + 300) * 1000
    var body: some View {
        NavigationStack {
            List {
                NavigationLink("Manual code") {
                    CodeEditor(request: SMSRequest(requestId: "fixture-code", callerName: "Synthetic agent", title: "Test sign-in", purpose: "Share only by tapping Send.", status: "ready", expiresAt: expiry, manualEntryDeadline: expiry), draft: codeDraft)
                }
                NavigationLink("Wizard request") {
                    FormEditor(request: FormRequest(requestId: "fixture-wizard", callerName: "Synthetic agent", title: "Test wizard", body: "Choose what to share.", status: "pending", expiresAt: expiry,
                        fields: [.init(id: "include", label: "Include details", type: "checkbox", required: false), .init(id: "details", label: "Details", type: "text", required: true)],
                        actions: [.init(id: "send", label: "Send response", type: "submit")],
                        steps: [.init(id: "choice", title: "Choose", fieldIds: ["include"]), .init(id: "details", title: "Details", fieldIds: ["details"], when: .init(fieldId: "include", equals: .boolean(true)))]), draft: formDraft)
                }
            }.navigationTitle("Simulator contracts")
        }
    }
}
#endif
