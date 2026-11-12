import Foundation

indirect enum Answer: Codable, Equatable {
    case text(String), number(Double), boolean(Bool), choices([String])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { self = .boolean(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String].self) { self = .choices(v) }
        else { self = .text(try c.decode(String.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .text(let v): try c.encode(v); case .number(let v): try c.encode(v); case .boolean(let v): try c.encode(v); case .choices(let v): try c.encode(v) }
    }
    var text: String { switch self { case .text(let v): return v; case .number(let v): return String(v); case .boolean(let v): return v ? "Yes" : "No"; case .choices(let v): return v.joined(separator: ", ") } }
    var bool: Bool { self == .boolean(true) }
    var choices: [String] { if case .choices(let v) = self { return v }; return [] }
}
struct Choice: Codable, Identifiable { let id: String; let label: String }
struct FormField: Codable, Identifiable {
    let id: String; let label: String; let type: String; let required: Bool
    var maxLength: Int?; var min: Double?; var max: Double?; var input: String?; var options: [Choice]?
}
struct FormAction: Codable, Identifiable { let id: String; let label: String; let type: String }
struct Condition: Codable { let fieldId: String; var equals: Answer?; var contains: String? }
struct FormStep: Codable, Identifiable { let id: String; let title: String; var body: String?; let fieldIds: [String]; var when: Condition? }
struct FormRequest: Codable, Identifiable {
    let requestId: String; let callerName: String; let title: String; let body: String; let status: String
    let expiresAt: Double; let fields: [FormField]; let actions: [FormAction]; var steps: [FormStep]?
    var completedByDeviceId: String?
    var id: String { requestId }
    func visibleSteps(_ values: [String: Answer]) -> [FormStep] {
        var available = Set<String>()
        return (steps ?? []).filter { step in
            if let c = step.when {
                guard available.contains(c.fieldId) else { return false }
                let source = fields.first { $0.id == c.fieldId }
                let v = values[c.fieldId] ?? (source?.type == "checkbox" ? .boolean(false) : nil)
                if let equals = c.equals, v != equals { return false }
                if let contains = c.contains, !(v?.choices.contains(contains) ?? false) { return false }
            }
            available.formUnion(step.fieldIds); return true
        }
    }
    func visibleFields(_ values: [String: Answer]) -> [FormField] {
        guard steps != nil else { return fields }
        let ids = Set(visibleSteps(values).flatMap(\.fieldIds)); return fields.filter { ids.contains($0.id) }
    }
    func errors(_ values: [String: Answer], fields selected: [FormField]? = nil) -> [String] {
        (selected ?? visibleFields(values)).compactMap { f in
            let v = values[f.id]
            let missing = v == nil || v == .text("") || v == .choices([])
            if f.required && (missing || (f.type == "checkbox" && v != .boolean(true))) { return "\(f.label) is required." }
            guard let v, !missing else { return nil }
            switch f.type {
            case "text", "multiline":
                guard case .text = v else { return "Check \(f.label)." }
                if v.text.utf16.count > (f.maxLength ?? 1000) { return "\(f.label) is too long." }
                if f.input == "sms_code" && !validCode(v.text) { return "Enter a valid code for \(f.label)." }
            case "number":
                guard case .number(let n) = v, n.isFinite, n >= (f.min ?? -.infinity), n <= (f.max ?? .infinity) else { return "Check \(f.label)." }
            case "checkbox":
                guard case .boolean = v else { return "Check \(f.label)." }
            case "single_choice":
                guard case .text(let id) = v, (f.options ?? []).contains(where: { $0.id == id }) else { return "Choose \(f.label)." }
            case "multiple_choice":
                guard case .choices(let ids) = v, Set(ids).count == ids.count,
                      ids.allSatisfy({ id in (f.options ?? []).contains(where: { $0.id == id }) }) else { return "Check \(f.label)." }
            case "date":
                guard case .text(let date) = v, validDate(date) else { return "Check \(f.label)." }
            default: break
            }
            return nil
        }
    }
}
private func validDate(_ value: String) -> Bool {
    guard value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { return false }
    let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
    guard let date = formatter.date(from: value) else { return false }; return formatter.string(from: date) == value
}
func validCode(_ code: String) -> Bool { code.range(of: "^(?=[A-Za-z0-9]{4,10}$)(?=.*[0-9])[A-Za-z0-9]+$", options: .regularExpression) != nil }
struct InboxRow: Codable, Identifiable { let requestId: String; let callerName: String; let title: String; let expiresAt: Double; var id: String { requestId } }
struct Device: Codable, Identifiable { let deviceId: String; let name: String; let paused: Bool; var activeRequestId: String?; var platform: String?; var id: String { deviceId } }
struct Grant: Codable, Identifiable { let grantId: String; let callerName: String; let revoked: Bool; let expiresAt: Double; var connectionId: String?; var capabilities: [String]?; var formsApproved: Bool?; var id: String { grantId } }
struct HistoryRow: Codable, Identifiable { let requestId: String; let callerName: String; let status: String; var reason: String?; var id: String { requestId } }
struct SMSRequest: Codable, Identifiable {
    let requestId: String; let callerName: String; let title: String; let purpose: String; let status: String; let expiresAt: Double
    var manualEntryDeadline: Double?; var reason: String?; var id: String { requestId }
    var active: Bool { ["pending_phone","ready","awaiting_consent"].contains(status) }
}
struct Agent: Codable, Identifiable { let serviceId: String; let name: String; let purpose: String; let capabilities: [String]; let active: Bool; let servicePath: String; var deliveryKeyId: String?; var id: String { serviceId } }
struct Approval: Codable {
    var sessionId: String?; var connectionId: String?; var name: String; var purpose: String
    var capabilities: [String]; var availableCapabilities: [String]?; var status: String?; var revoked: Bool?; var expiresAt: Double?
    var expiresInDays: Int?; var comparisonCode: String?; var clientName: String?; var clientOrigin: String?
}
struct RelayDestination: Codable, Equatable, Identifiable {
    let kind: String; let value: String; var id: String { kind + "/" + value }
    static func parse(_ url: URL, origin: URL) -> RelayDestination? {
        guard url.scheme == "https", url.host?.lowercased() == origin.host?.lowercased(), url.port == nil || url.port == 443,
              url.user == nil, url.password == nil, url.fragment == nil else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        if parts == ["owned-services"] {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if items.isEmpty { return .init(kind: "agents", value: "") }
            if items.count == 1, items[0].name == "service", let value = items[0].value, value.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil { return .init(kind: "agents", value: value) }
            return nil
        }
        if parts == ["connect"], let c = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
           c.count == 1, c.first?.name == "code", let value = c.first?.value {
            let code = value.uppercased().replacingOccurrences(of: "-", with: "").replacingOccurrences(of: " ", with: "")
            if code.range(of: "^[A-HJ-NP-Z2-9]{10}$", options: .regularExpression) != nil { return .init(kind: "legacy", value: code) }; return nil
        }
        guard url.query == nil else { return nil }
        let kind: String, value: String
        if parts.count == 3 && parts[0] == "oauth" && parts[1] == "consent" { kind = "oauth"; value = parts[2] }
        else if parts.count == 2 && ["register","pair","services","connections"].contains(parts[0]) { kind = parts[0]; value = parts[1] }
        else { return nil }
        guard value.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil else { return nil }
        return .init(kind: kind, value: value)
    }
}
