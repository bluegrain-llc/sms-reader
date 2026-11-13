import Foundation
import Security
import CryptoKit

/// Keys and provisioning state use device-only Keychain storage. Responses never enter this store.
enum PrivateStorage {
    static func read(_ name: String) throws -> Data? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrService: "com.bluegrain.smsrelay.tickets", kSecAttrAccount: name, kSecReturnData: true] as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw RelayFailure.keychain(status) }
        guard let data = result as? Data else { throw RelayFailure.storage }
        return data
    }
    static func write(_ name: String, _ data: Data) throws {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "com.bluegrain.smsrelay.tickets", kSecAttrAccount: name]
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status == errSecItemNotFound {
            var value = query; value[kSecValueData] = data; value[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let added = SecItemAdd(value as CFDictionary, nil)
            guard added == errSecSuccess else { throw RelayFailure.keychain(added) }
        } else if status != errSecSuccess { throw RelayFailure.keychain(status) }
    }
    static func writeNew(_ name: String, _ data: Data) throws {
        let value: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "com.bluegrain.smsrelay.tickets", kSecAttrAccount: name,
            kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemAdd(value as CFDictionary, nil)
        guard status == errSecSuccess else { throw RelayFailure.keychain(status) }
    }
    static func remove(_ name: String) { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: "com.bluegrain.smsrelay.tickets", kSecAttrAccount: name] as CFDictionary) }
}
struct JWK: Codable { let kty: String; let crv: String; let x: String; let y: String; var d: String? }
struct TicketKey: Codable { let id: String; let publicKey: JWK; let privateKey: JWK }
struct AgentDeclaration: Codable {
    let name: String; let purpose: String; let capabilities: [String]
    var validText: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.utf16.count <= 80 && !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && purpose.utf16.count <= 240 }
    static func boundedText(_ value: String, limit: Int) -> String {
        var result = "", count = 0
        for character in value {
            let text = String(character), size = text.utf16.count
            guard count + size <= limit else { break }
            result += text; count += size
        }
        return result
    }
}
struct SessionTicket: Codable {
    let version: Int; let relayOrigin: String; let agent: AgentDeclaration; let serviceCredential: String; let deliveryKeys: [TicketKey]
    static func create(origin: URL, agent: AgentDeclaration) throws -> SessionTicket {
        guard agent.validText else { throw RelayFailure.rejected("invalid_agent") }
        let key = P256.KeyAgreement.PrivateKey(), raw = key.publicKey.x963Representation
        let x = raw.subdata(in: 1..<33).base64url, y = raw.subdata(in: 33..<65).base64url
        let pub = JWK(kty: "EC", crv: "P-256", x: x, y: y)
        let canonical = "{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"\(x)\",\"y\":\"\(y)\"}"
        var bytes = Data(count: 32)
        guard bytes.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { throw RelayFailure.storage }
        return .init(version: 1, relayOrigin: origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), agent: agent,
                     serviceCredential: "smss_" + bytes.base64url,
                     deliveryKeys: [.init(id: Data(SHA256.hash(data: Data(canonical.utf8))).hex, publicKey: pub,
                        privateKey: .init(kty: "EC", crv: "P-256", x: x, y: y, d: key.rawRepresentation.base64url))])
    }
    var declaration: [String: Any] { ["name":agent.name,"purpose":agent.purpose,"capabilities":agent.capabilities,
        "credentialHash":Data(SHA256.hash(data: Data(serviceCredential.utf8))).hex,
        "deliveryPublicKey":["kty":"EC","crv":"P-256","x":deliveryKeys[0].publicKey.x,"y":deliveryKeys[0].publicKey.y]] }
}
extension Data {
    var base64url: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

@MainActor
enum RetainedTicketStore {
    static func read(owner: String) throws -> SessionTicket? {
        try PrivateStorage.read("provision:\(owner)").map { try JSONDecoder().decode(SessionTicket.self, from: $0) }
    }
    static func saveNew(_ ticket: SessionTicket, owner: String) throws {
        try PrivateStorage.writeNew("provision:\(owner)", JSONEncoder().encode(ticket))
    }
    static func verify(_ ticket: SessionTicket, owner: String) throws {
        guard try read(owner: owner)?.serviceCredential == ticket.serviceCredential else { throw RelayFailure.storage }
    }
    static func clear(_ ticket: SessionTicket, owner: String) throws {
        try verify(ticket, owner: owner)
        PrivateStorage.remove("provision:\(owner)")
    }
}
