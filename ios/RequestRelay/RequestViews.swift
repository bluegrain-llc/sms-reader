import SwiftUI
import UniformTypeIdentifiers

struct RequestInbox: View {
    @EnvironmentObject var model: RelayModel
    var body: some View {
        List {
            if let sms = model.sms, sms.active {
                Section("Verification code") { NavigationLink { CodeResponse(id: sms.id) } label: { RequestLabel(caller: sms.callerName, title: sms.title, expiry: sms.expiresAt) } }
            }
            Section("Information and decisions") {
                ForEach(model.inbox) { row in NavigationLink { FormResponse(id: row.id) } label: { RequestLabel(caller: row.callerName, title: row.title, expiry: row.expiresAt) } }
                if model.inbox.isEmpty { Text("No pending requests.").foregroundStyle(.secondary) }
            }
            if !model.devices.contains(where: { $0.id == model.deviceID }) {
                Section { Button("Connect this device") { Task { await model.perform { try await model.registerDevice() } } } }
            }
        }.navigationTitle("Inbox").refreshable { await model.refresh() }
    }
}
struct RequestLabel: View {
    let caller: String; let title: String; let expiry: Double
    var body: some View { VStack(alignment: .leading, spacing: 6) {
        Text(caller).font(.headline); Text(title)
        Text("Expires \(Date(timeIntervalSince1970: expiry / 1000), style: .relative)").font(.caption).foregroundStyle(.secondary)
    }.padding(.vertical, 4) }
}
struct CodeResponse: View {
    @EnvironmentObject var model: RelayModel
    let id: String
    @State private var request: SMSRequest?
    @State private var draft: ResponseDraft?
    @State private var failed = false
    @State private var attempt = 0
    var body: some View {
        VStack {
            if failed { Button("Refresh request") { attempt += 1 } }
            if let request, let draft { CodeEditor(request: request, draft: draft) }
            else if !failed { ProgressView("Opening request…") }
        }.navigationTitle("Verification code")
        .task(id: "\(id)-\(attempt)") {
            failed = false
            while !Task.isCancelled {
                do {
                    let result = try await model.loadSMS(id); request = result
                    draft = model.draft(id, expiresAt: result.manualEntryDeadline ?? result.expiresAt)
                    if !result.active { draft?.clear(); break }
                } catch { failed = true; model.error = (error as? RelayFailure)?.localizedDescription ?? "Could not open the request. Try again."; break }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}
struct CodeEditor: View {
    @EnvironmentObject var model: RelayModel
    let request: SMSRequest
    @ObservedObject var draft: ResponseDraft
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let deadline = request.manualEntryDeadline ?? request.expiresAt
            let available = request.status == "ready" && deadline > context.date.timeIntervalSince1970 * 1000
            Form {
                Section { Text(request.callerName).font(.title2.weight(.semibold)); Text(request.title).font(.headline); Text(.init(request.purpose)) }
                if request.active {
                    Section("Enter the code you want to share") {
                        TextField("SMS code", text: $draft.code).textContentType(.oneTimeCode)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive().accessibilityIdentifier("code-input")
                            .onChange(of: draft.code) { _, value in draft.code = String(value.prefix(10)) }
                        Text("Type or deliberately paste a code. AutoFill is offered only when iOS allows it. Nothing is sent until you tap Send.").font(.footnote).foregroundStyle(.secondary)
                        Text(available ? "Entry closes \(Date(timeIntervalSince1970: deadline / 1000).formatted(date: .omitted, time: .standard))." : "The entry window has closed.")
                        Button("Send") { Task { await model.perform { try await model.submitSMS(request, code: draft.code) } } }
                            .disabled(!available || !validCode(draft.code) || model.busy).accessibilityIdentifier("send-code")
                        Button("Decline", role: .destructive) { Task { await model.perform { try await model.submitSMS(request, code: "", deny: true) } } }.disabled(model.busy)
                    }
                } else { Text(request.reason == "handled_on_another_device" ? "Handled on another device." : "This request is \(request.status).") }
            }.onChange(of: available) { _, active in if !active { draft.code = "" } }
        }
    }
}
struct FormResponse: View {
    @EnvironmentObject var model: RelayModel
    let id: String
    var fromNotification = false
    @State private var request: FormRequest?
    @State private var draft: ResponseDraft?
    @State private var failed = false
    @State private var attempt = 0
    var body: some View {
        VStack {
            if failed { Button("Refresh request") { attempt += 1 } }
            if let request, let draft { FormEditor(request: request, draft: draft) }
            else if !failed { ProgressView("Opening request…") }
        }.navigationTitle(request?.title ?? "Request").navigationBarTitleDisplayMode(.inline)
        .task(id: "\(id)-\(attempt)") {
            failed = false
            while !Task.isCancelled {
                do {
                    let result: FormRequest = try await model.api.call("/v2/devices/\(model.deviceID)/requests/\(id)")
                    let first = request == nil; request = result; draft = model.formDraft(result)
                    if result.status != "pending" { break }
                    if first && fromNotification { let _: EmptyReply = try await model.api.call("/v2/devices/\(model.deviceID)/requests/\(id)/events", method: "POST", body: ["type":"notification.tapped"]) }
                    if first { let _: EmptyReply = try await model.api.call("/v2/devices/\(model.deviceID)/requests/\(id)/events", method: "POST", body: ["type":"request.opened"]) }
                } catch { failed = true; model.error = (error as? RelayFailure)?.localizedDescription ?? "Could not refresh the request. Try again."; break }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}
struct FormEditor: View {
    @EnvironmentObject var model: RelayModel
    let request: FormRequest
    @ObservedObject var draft: ResponseDraft
    @State private var validation: [String] = []
    @State private var confirmation: FormAction?
    private var steps: [FormStep] { request.visibleSteps(draft.values) }
    private var current: Int { steps.firstIndex(where: { $0.id == draft.stepID }) ?? 0 }
    private var fields: [FormField] {
        guard request.steps != nil else { return request.fields }
        guard !steps.isEmpty else { return [] }; let ids = Set(steps[current].fieldIds); return request.fields.filter { ids.contains($0.id) }
    }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let active = request.status == "pending" && request.expiresAt > context.date.timeIntervalSince1970 * 1000
            Form {
                Section { Text(request.callerName).font(.title2.weight(.semibold)); Text(.init(request.body)) }
                if active {
                    if draft.review {
                        Section("Review your response") {
                            ForEach(request.visibleFields(draft.values)) { field in
                                LabeledContent(field.label, value: display(field)).privacySensitive()
                            }
                            Button("Edit response") { draft.review = false }
                        }
                        Section("Send to \(request.callerName)") {
                            ForEach(request.actions) { action in
                                Button(action.label, role: action.type == "decline" ? .destructive : nil) { validateAndConfirm(action) }.disabled(model.busy)
                            }
                        }
                    } else {
                        Section(request.steps == nil || steps.isEmpty ? "Your response" : "\(current + 1) of \(steps.count) · \(steps[current].title)") {
                            if request.steps != nil, !steps.isEmpty, let body = steps[current].body { Text(.init(body)) }
                            ForEach(fields) { field in NativeField(field: field, values: $draft.values) }
                        }
                        Section {
                            if current > 0 { Button("Previous") { draft.stepID = steps[current - 1].id; validation = [] } }
                            Button(request.steps != nil && current + 1 < steps.count ? "Next" : "Review response") {
                                validation = request.errors(draft.values, fields: fields)
                                if validation.isEmpty {
                                    if request.steps != nil && current + 1 < steps.count { draft.stepID = steps[current + 1].id }
                                    else { draft.review = true }
                                }
                            }.accessibilityIdentifier("review-response")
                            ForEach(request.actions.filter { $0.type == "decline" }) { action in Button(action.label, role: .destructive) { confirmation = action } }
                        }
                    }
                    ForEach(validation, id: \.self) { Text($0).foregroundStyle(.red) }
                } else { Text(request.status == "pending" ? "This request expired." : "This request is \(request.status).") }
            }
            .onChange(of: active) { _, active in if !active { draft.clear() } }
            .onChange(of: draft.values) { _, _ in
                let visible = Set(request.visibleFields(draft.values).map(\.id)); draft.values = draft.values.filter { visible.contains($0.key) }
                if let id = draft.stepID, !steps.contains(where: { $0.id == id }) { draft.stepID = steps.first?.id; draft.review = false }
            }
            .confirmationDialog("Send this response to \(request.callerName)?", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
                if let action = confirmation { Button(action.label, role: action.type == "decline" ? .destructive : nil) { Task { await model.perform { _ = try await model.submitForm(request, action: action, draft: draft) } }; confirmation = nil } }
            }
        }
    }
    private func validateAndConfirm(_ action: FormAction) {
        validation = action.type == "decline" ? [] : request.errors(draft.values)
        if validation.isEmpty { confirmation = action }
    }
    private func display(_ field: FormField) -> String {
        guard let value = draft.values[field.id] else { return "—" }
        if field.type == "single_choice" { return field.options?.first(where: { $0.id == value.text })?.label ?? "—" }
        if field.type == "multiple_choice" { return (field.options ?? []).filter { value.choices.contains($0.id) }.map(\.label).joined(separator: ", ") }
        return value.text
    }
}
struct NativeField: View {
    let field: FormField
    @Binding var values: [String: Answer]
    @State private var numberText = ""
    private var text: Binding<String> { Binding(get: { field.type == "number" ? numberText : values[field.id]?.text ?? "" }, set: { newValue in
        if field.type == "number" { numberText = newValue; if newValue.isEmpty { values.removeValue(forKey: field.id) } else if let number = Double(newValue), number.isFinite { values[field.id] = .number(number) } else { values[field.id] = .text(newValue) } }
        else if field.type == "single_choice" && newValue.isEmpty { values.removeValue(forKey: field.id) }
        else { values[field.id] = .text(String(newValue.prefix(field.maxLength ?? 4000))) }
    }) }
    var body: some View {
        Group {
            switch field.type {
            case "checkbox": Toggle(field.label, isOn: Binding(get: { values[field.id]?.bool ?? false }, set: { values[field.id] = .boolean($0) }))
            case "single_choice": Picker(field.label, selection: text) { Text("Choose…").tag(""); ForEach(field.options ?? []) { Text($0.label).tag($0.id) } }
            case "multiple_choice":
                VStack(alignment: .leading) { Text(field.label).font(.headline); ForEach(field.options ?? []) { option in
                    Toggle(option.label, isOn: Binding(get: { values[field.id]?.choices.contains(option.id) ?? false }, set: { selected in
                        var choices = values[field.id]?.choices ?? []; choices.removeAll { $0 == option.id }; if selected { choices.append(option.id) }; values[field.id] = .choices(choices)
                    }))
                } }
            case "date": DatePicker(field.label, selection: Binding(get: { Self.formatter.date(from: text.wrappedValue) ?? Date() }, set: { text.wrappedValue = Self.formatter.string(from: $0) }), displayedComponents: .date)
                Button("Use selected date") { if text.wrappedValue.isEmpty { text.wrappedValue = Self.formatter.string(from: Date()) } }
            default:
                VStack(alignment: .leading, spacing: 8) {
                    Text(field.label + (field.required ? " · Required" : ""))
                    if field.type == "multiline" { TextField(field.label, text: text, axis: .vertical).lineLimit(3...8) }
                    else { TextField(field.label, text: text).keyboardType(field.type == "number" ? .numbersAndPunctuation : .default).textContentType(field.input == "sms_code" ? .oneTimeCode : nil).textInputAutocapitalization(field.input == "sms_code" ? .never : .sentences).autocorrectionDisabled(field.input == "sms_code") }
                    if field.input == "sms_code" { Text("Type or paste deliberately. AutoFill depends on the code’s domain. Review and send explicitly.").font(.footnote).foregroundStyle(.secondary) }
                }
            }
        }.privacySensitive().onAppear { if field.type == "number" { numberText = values[field.id]?.text ?? "" } }
    }
    private static let formatter: DateFormatter = { let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"; return f }()
}
