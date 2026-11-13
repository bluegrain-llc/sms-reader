import XCTest
import CryptoKit
import CoreImage
@testable import RequestRelay

final class RelayTests: XCTestCase {
    func testPublicRoutesRejectWrongOriginsAndCredentials() throws {
        let origin = URL(string: "https://relay.example")!
        for path in ["register/id", "pair/id", "services/id", "connections/id", "oauth/consent/id", "owned-services"] {
            XCTAssertNotNil(RelayDestination.parse(URL(string: "https://relay.example/\(path)")!, origin: origin))
        }
        for link in ["https://evil.example/pair/id", "http://relay.example/pair/id", "https://relay.example/pair/id?ticket=private", "https://user@relay.example/pair/id", "https://relay.example/pair/id#private", "https://relay.example:444/pair/id"] {
            XCTAssertNil(RelayDestination.parse(URL(string: link)!, origin: origin))
        }
    }
    func testTicketKeyMatchesPrivateMaterialAndContainsNoRecipient() throws {
        let ticket = try SessionTicket.create(origin: URL(string: "https://relay.example")!, agent: .init(name: "Agent", purpose: "Decisions", capabilities: ["forms"]))
        let key = ticket.deliveryKeys[0], d = key.privateKey.d!
        let raw = Data(base64Encoded: d.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=")!
        let privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
        XCTAssertEqual(privateKey.publicKey.x963Representation.subdata(in: 1..<33).base64url, key.publicKey.x)
        XCTAssertEqual(ticket.serviceCredential.count, 48)
        XCTAssertNil(key.publicKey.d)
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ticket)) as! [String: Any]
        XCTAssertEqual(Set(object.keys), Set(["version","relayOrigin","agent","serviceCredential","deliveryKeys"]))
    }
    func testConditionalWizardPrunesDependentStepsAndRequiresReviewValues() throws {
        let data = Data(#"{"requestId":"form","callerName":"Agent","title":"Choose","body":"Review","status":"pending","expiresAt":2000000000000,"fields":[{"id":"agree","label":"Agree","type":"checkbox","required":false},{"id":"detail","label":"Details","type":"text","required":true}],"actions":[{"id":"send","label":"Send","type":"submit"}],"steps":[{"id":"first","title":"Choice","fieldIds":["agree"]},{"id":"details","title":"Details","fieldIds":["detail"],"when":{"fieldId":"agree","equals":true}}]}"#.utf8)
        let form = try JSONDecoder().decode(FormRequest.self, from: data)
        XCTAssertEqual(form.visibleFields([:]).map(\.id), ["agree"])
        XCTAssertEqual(form.visibleSteps(["agree":.boolean(true)]).count, 2)
        XCTAssertEqual(form.errors(["agree":.boolean(true)]), ["Details is required."])
        XCTAssertTrue(form.errors(["agree":.boolean(false)]).isEmpty)
        XCTAssertFalse(validCode("secret")); XCTAssertTrue(validCode("123456"))
    }
    @MainActor func testDraftClearErasesResponses() {
        let draft = ResponseDraft(); draft.code = "123456"; draft.values = ["answer":.text("private")]; draft.review = true
        draft.clear(); XCTAssertTrue(draft.code.isEmpty); XCTAssertTrue(draft.values.isEmpty); XCTAssertFalse(draft.review)
    }
    func testFormValidationRejectsInvalidDatesAndChoices() throws {
        let form = try JSONDecoder().decode(FormRequest.self, from: Data(#"{"requestId":"form","callerName":"Agent","title":"Choose","body":"Review","status":"pending","expiresAt":2000000000000,"fields":[{"id":"date","label":"Date","type":"date","required":true},{"id":"choices","label":"Choices","type":"multiple_choice","required":false,"options":[{"id":"a","label":"A"}]}],"actions":[{"id":"send","label":"Send","type":"submit"}]}"#.utf8))
        XCTAssertTrue(form.errors(["date":.text("2028-02-29"),"choices":.choices(["a"])]).isEmpty)
        XCTAssertEqual(form.errors(["date":.text("2027-02-29"),"choices":.choices(["a","a"])]).count, 2)
        XCTAssertEqual(form.errors(["date":.text("2028-02-29"),"choices":.choices(["unknown"])]), ["Check Choices."])
    }
}


extension RelayTests {
    @MainActor func testQRDecodesOnlyPublicRegistrationAndPairingURLs() throws {
        for path in ["register/public-session", "pair/public-session"] {
            let url = URL(string: "https://relay.example/" + path)!
            let image = try XCTUnwrap(PublicQRCode(url: url).qrImage()?.cgImage)
            let detector = try XCTUnwrap(CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(), options: [CIDetectorAccuracy:CIDetectorAccuracyHigh]))
            let result = detector.features(in: CIImage(cgImage: image)).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
            XCTAssertEqual(result, [url.absoluteString])
            let decoded = try XCTUnwrap(result.first)
            XCTAssertFalse(decoded.contains("smss_")); XCTAssertFalse(decoded.contains("privateKey"))
        }
    }
}

extension RelayTests {
    func testFinitePermissionsUseIntegerMillisecondsAndDenialCanReturn() throws {
        let now = Date(timeIntervalSince1970: 1794570000.1235)
        let expiry = try XCTUnwrap(connectionExpiry(days: 7, now: now))
        let payload = try JSONSerialization.data(withJSONObject: ["expiresAt": expiry])
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: NSNumber])
        XCTAssertEqual(object["expiresAt"]?.int64Value, 1795174800123)
        XCTAssertNil(connectionExpiry(days: 0, now: now))
        XCTAssertTrue(oauthResponseAvailable("denied")); XCTAssertTrue(oauthResponseAvailable("approved"))
        XCTAssertFalse(oauthResponseAvailable("pending")); XCTAssertFalse(oauthResponseAvailable("expired"))
    }
    @MainActor func testClosedDraftReconcilesTerminalStateWithoutTreatingInboxLimitAsTerminal() async {
        let model = RelayModel(), pending = formState("pending")
        let retained = model.formDraft(pending); retained.values = ["answer": .text("private")]
        await model.reconcileFormDrafts(pendingIDs: []) { _ in pending }
        XCTAssertEqual(retained.values["answer"], .text("private"))
        await model.reconcileFormDrafts(pendingIDs: []) { _ in throw RelayFailure.unavailable }
        XCTAssertEqual(retained.values["answer"], .text("private"))
        await model.reconcileFormDrafts(pendingIDs: []) { _ in self.formState("completed") }
        XCTAssertTrue(retained.values.isEmpty)
        XCTAssertFalse(model.formDraft(pending) === retained)
        model.clearResponses()
    }
    @MainActor func testTerminalFormLoadClearsBeforeAnyOpeningObservation() {
        let model = RelayModel(), retained = model.formDraft(formState("pending"))
        retained.values = ["answer": .text("private")]
        let terminal = model.formDraft(formState("cancelled"))
        XCTAssertTrue(terminal === retained); XCTAssertTrue(terminal.values.isEmpty)
        // The response loader checks terminal status before issuing any observation POST.
        XCTAssertFalse(model.formDraft(formState("pending")) === retained)
        model.clearResponses()
    }
    @MainActor func testPushRefreshRequiresAnExistingConnection() {
        let model = RelayModel(); model.signedIn = true
        XCTAssertFalse(model.acceptsPushUpdates(for: "installation"))
        model.devices = [.init(deviceId: "installation", name: "Phone", paused: true)]
        XCTAssertTrue(model.acceptsPushUpdates(for: "installation"))
        model.devices = []
        XCTAssertFalse(model.acceptsPushUpdates(for: "replacement"))
        model.signedIn = false
    }
    @MainActor func testRetainedTicketRejectsStaleReplacementAndClearing() throws {
        let owner = "test-\(UUID().uuidString)", origin = URL(string: "https://relay.example")!
        defer { PrivateStorage.remove("provision:\(owner)") }
        let first = try SessionTicket.create(origin: origin, agent: .init(name: "First", purpose: "Test", capabilities: ["forms"]))
        let second = try SessionTicket.create(origin: origin, agent: .init(name: "Second", purpose: "Test", capabilities: ["forms"]))
        try RetainedTicketStore.saveNew(first, owner: owner)
        XCTAssertThrowsError(try RetainedTicketStore.saveNew(second, owner: owner))
        XCTAssertEqual(try RetainedTicketStore.read(owner: owner)?.serviceCredential, first.serviceCredential)
        try RetainedTicketStore.clear(first, owner: owner)
        try RetainedTicketStore.saveNew(second, owner: owner)
        XCTAssertThrowsError(try RetainedTicketStore.clear(first, owner: owner))
        XCTAssertThrowsError(try RetainedTicketStore.verify(first, owner: owner))
        XCTAssertEqual(try RetainedTicketStore.read(owner: owner)?.serviceCredential, second.serviceCredential)
        try RetainedTicketStore.clear(second, owner: owner)
        XCTAssertNil(try RetainedTicketStore.read(owner: owner))
    }
    private func formState(_ status: String) -> FormRequest {
        .init(requestId: "form", callerName: "Agent", title: "Response", body: "Test", status: status,
              expiresAt: 2000000000000, fields: [.init(id: "answer", label: "Answer", type: "text", required: false)], actions: [])
    }
}
