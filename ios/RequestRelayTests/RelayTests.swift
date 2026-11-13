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
    func testAgentTicketRejectsBackendIncompatibleUnicodeBeforeRetention() throws {
        let origin = URL(string: "https://relay.example")!
        let tooLongName = String(repeating: "🚀", count: 41), tooLongPurpose = String(repeating: "🚀", count: 121)
        for agent in [AgentDeclaration(name: tooLongName, purpose: "Test", capabilities: ["forms"]), AgentDeclaration(name: "Agent", purpose: tooLongPurpose, capabilities: ["forms"])] {
            XCTAssertThrowsError(try SessionTicket.create(origin: origin, agent: agent))
        }
        let name = AgentDeclaration.boundedText(tooLongName, limit: 80), purpose = AgentDeclaration.boundedText(tooLongPurpose, limit: 240)
        XCTAssertEqual(name, String(repeating: "🚀", count: 40)); XCTAssertEqual(purpose, String(repeating: "🚀", count: 120))
        XCTAssertNoThrow(try SessionTicket.create(origin: origin, agent: .init(name: name, purpose: purpose, capabilities: ["forms"])))
        XCTAssertEqual(AgentDeclaration.boundedText("A👨‍👩‍👧‍👦B", limit: 10), "A")
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
    @MainActor func testTerminalSubmissionClosesRetainedDraftBeforeAuthenticatedRefreshReturns() async throws {
        let key = "installation:signed-out", original = try PrivateStorage.read("installation:signed-out")
        defer { if let original { try? PrivateStorage.write(key, original) } else { PrivateStorage.remove(key) } }
        for form in [false, true] {
            let gate = SuspendedRelayReply(), api = FixtureRelayAPI(), model = RelayModel(api: api)
            model.signedIn = true
            let sms = SMSRequest(requestId: "sms", callerName: "Agent", title: "Code", purpose: "Test", status: "ready", expiresAt: 2000000000000)
            let request = formState("pending")
            let draft = form ? model.formDraft(request) : model.draft(sms.id, expiresAt: sms.expiresAt)
            draft.code = "123456"; draft.values = ["answer": .text("private")]; draft.numberInputs = ["number": "123."]
            api.respond = { path, method, _ in
                if path == "/v1/devices", method == "GET" { return try await gate.reply() }
                XCTAssertEqual(method, "POST")
                if form { return try JSONEncoder().encode(self.formState("submitted")) }
                return try JSONEncoder().encode(SMSRequest(requestId: sms.id, callerName: sms.callerName, title: sms.title, purpose: sms.purpose, status: "completed", expiresAt: sms.expiresAt))
            }
            let submission = Task {
                if form { _ = try await model.submitForm(request, action: .init(id: "send", label: "Send", type: "submit"), draft: draft) }
                else { _ = try await model.submitSMS(sms, code: draft.code) }
            }
            defer { gate.resume(.failure(CancellationError())); submission.cancel(); model.clearResponses() }
            await fulfillment(of: [gate.entered], timeout: 2)
            XCTAssertEqual(draft.closedStatus, form ? "submitted" : "completed")
            XCTAssertTrue(draft.code.isEmpty); XCTAssertTrue(draft.values.isEmpty); XCTAssertTrue(draft.numberInputs.isEmpty)
            model.signedIn = false
            gate.resume(.failure(RelayFailure.unavailable))
            try await submission.value
        }
    }
    @MainActor func testExpiryAndAccountClearingCloseRetainedDraftOwnership() {
        let model = RelayModel()
        let expired = model.draft("expired", expiresAt: 0); expired.code = "123456"
        model.expireDrafts()
        XCTAssertEqual(expired.closedStatus, "expired"); XCTAssertTrue(expired.code.isEmpty)
        let account = model.formDraft(formState("pending")); account.values = ["answer": .text("private")]
        model.clearResponses()
        XCTAssertEqual(account.closedStatus, "closed"); XCTAssertTrue(account.values.isEmpty)
        let reopened = model.formDraft(formState("pending"))
        XCTAssertFalse(reopened === account); XCTAssertNil(reopened.closedStatus)
        model.clearResponses()
    }
    @MainActor func testDelayedDetailLoadsCannotReopenClosedOrReplacedResponseOwnership() async throws {
        let key = "installation:signed-out", original = try PrivateStorage.read("installation:signed-out")
        defer { if let original { try? PrivateStorage.write(key, original) } else { PrivateStorage.remove(key) } }
        for form in [false, true] {
            for transition in ["submission", "discard", "account-clear", "newer-load", "task-cancel"] {
                let gate = SuspendedRelayReply(), api = FixtureRelayAPI(), model = RelayModel(api: api)
                model.signedIn = true
                let sms = SMSRequest(requestId: "sms", callerName: "Agent", title: "Code", purpose: "Test", status: "ready", expiresAt: 2000000000000)
                let request = formState("pending"), id = form ? request.id : sms.id
                let retained = form ? model.formDraft(request) : model.draft(id, expiresAt: sms.expiresAt)
                retained.code = "123456"; retained.values = ["answer": .text("private")]
                let pending: Data
                if form { pending = try JSONEncoder().encode(request) }
                else { pending = try JSONEncoder().encode(sms) }
                var detailReads = 0, installed = false, observations = 0
                api.respond = { path, method, _ in
                    if method == "GET", path.hasSuffix("/requests/\(id)") {
                        detailReads += 1
                        if detailReads == 1 { return try await gate.reply() }
                        return pending
                    }
                    if path == "/v1/devices" { throw RelayFailure.unavailable }
                    if form, path.hasSuffix("/events") { observations += 1; return Data("{}".utf8) }
                    XCTAssertEqual(method, "POST")
                    if form { return try JSONEncoder().encode(self.formState("submitted")) }
                    return try JSONEncoder().encode(SMSRequest(requestId: id, callerName: "Agent", title: "Code", purpose: "Test", status: "completed", expiresAt: sms.expiresAt))
                }
                let load = Task {
                    do {
                        if form {
                            try await model.loadFormResponse(id, observations: FormOpeningObservations(), fromNotification: true) { _, _ in installed = true }
                        } else { _ = try await model.loadSMS(id); installed = true }
                        return false
                    } catch is CancellationError { return true }
                    catch { XCTFail("Expected obsolete detail load cancellation: \(error)"); return false }
                }
                defer { gate.resume(.failure(CancellationError())); load.cancel(); model.clearResponses() }
                await fulfillment(of: [gate.entered], timeout: 2)
                switch transition {
                case "submission":
                    if form { _ = try await model.submitForm(request, action: .init(id: "send", label: "Send", type: "submit"), draft: retained) }
                    else { _ = try await model.submitSMS(sms, code: retained.code) }
                case "discard": model.discard(id, status: "cancelled")
                case "account-clear": model.clearResponses()
                case "newer-load":
                    if form { try await model.loadFormResponse(id, observations: FormOpeningObservations(), fromNotification: false) { _, _ in } }
                    else { _ = try await model.loadSMS(id) }
                default: load.cancel()
                }
                let acceptedObservations = observations
                gate.resume(.success(pending))
                let cancelled = await load.value
                XCTAssertTrue(cancelled, "\(form): \(transition)")
                XCTAssertFalse(installed, "\(form): \(transition)")
                XCTAssertEqual(observations, acceptedObservations)
                if ["submission", "discard"].contains(transition) {
                    let expected = transition == "discard" ? "cancelled" : form ? "submitted" : "completed"
                    XCTAssertEqual(retained.closedStatus, expected)
                    XCTAssertTrue(retained.code.isEmpty); XCTAssertTrue(retained.values.isEmpty)
                    if form {
                        try await model.loadFormResponse(id, observations: FormOpeningObservations(), fromNotification: true) { _, draft in XCTAssertEqual(draft.closedStatus, expected) }
                    } else { let result = try await model.loadSMS(id); XCTAssertEqual(result.draft.closedStatus, expected) }
                    XCTAssertEqual(observations, acceptedObservations)
                    XCTAssertNil(model.draft("different-request", expiresAt: sms.expiresAt).closedStatus)
                } else if transition == "account-clear" {
                    XCTAssertEqual(retained.closedStatus, "closed")
                    XCTAssertNil(model.draft(id, expiresAt: sms.expiresAt).closedStatus)
                } else { XCTAssertNil(retained.closedStatus); XCTAssertEqual(retained.code, "123456") }
            }
        }
    }
    @MainActor func testSMSSubmissionReportsTheReturnedTerminalOutcome() async throws {
        let key = "installation:signed-out", original = try PrivateStorage.read("installation:signed-out")
        defer { if let original { try? PrivateStorage.write(key, original) } else { PrivateStorage.remove(key) } }
        let request = SMSRequest(requestId: "sms", callerName: "Agent", title: "Code", purpose: "Test", status: "ready", expiresAt: 2000000000000)
        let cases: [(String, String?, String)] = [
            ("expired", "request_timeout", "This request is expired. Your code was not sent."),
            ("cancelled", nil, "This request is cancelled. Your code was not sent."),
            ("failed", nil, "This request is failed. Your code was not sent."),
            ("denied", nil, "Request declined."),
            ("completed", nil, "Response accepted."),
            ("cancelled", "handled_on_another_device", "Handled on another device.")
        ]
        for (status, reason, expected) in cases {
            let api = FixtureRelayAPI()
            let subject = RelayModel(api: api), installation = subject.deviceID
            XCTAssertFalse(installation.isEmpty)
            defer { subject.clearResponses() }
            let draft = subject.draft(request.id, expiresAt: request.expiresAt); draft.code = "123456"
            api.respond = { path, method, body in
                XCTAssertEqual(path, "/v1/devices/\(installation)/requests/sms/events"); XCTAssertEqual(method, "POST")
                XCTAssertEqual(body?["code"] as? String, "123456")
                return try JSONEncoder().encode(SMSRequest(requestId: request.id, callerName: request.callerName, title: request.title, purpose: request.purpose, status: status, expiresAt: request.expiresAt, reason: reason))
            }
            let result = try await subject.submitSMS(request, code: draft.code)
            XCTAssertEqual(result.status, status); XCTAssertEqual(result.reason, reason)
            XCTAssertEqual(subject.notice, expected, status); XCTAssertTrue(draft.code.isEmpty, status)
        }
    }
    @MainActor func testFormSubmissionReportsExpiryCancellationAndActualWinners() async throws {
        let key = "installation:signed-out", original = try PrivateStorage.read("installation:signed-out")
        defer { if let original { try? PrivateStorage.write(key, original) } else { PrivateStorage.remove(key) } }
        let cases: [(String, String?, String)] = [
            ("expired", nil, "This request is expired. Your response was not sent."),
            ("cancelled", nil, "This request is cancelled. Your response was not sent."),
            ("submitted", "self", "Response accepted."),
            ("declined", "self", "Request declined."),
            ("submitted", "other", "Handled on another device."),
            ("declined", "other", "Handled on another device.")
        ]
        for (status, winner, expected) in cases {
            let api = FixtureRelayAPI(), subject = RelayModel(api: api), request = formState("pending")
            let installation = subject.deviceID, draft = subject.formDraft(request)
            XCTAssertFalse(installation.isEmpty)
            defer { subject.clearResponses() }
            draft.values = ["answer": .text("private")]
            var result = formState(status); result.completedByDeviceId = winner == "self" ? installation : winner
            api.respond = { path, method, body in
                XCTAssertEqual(path, "/v2/devices/\(installation)/requests/form/submissions"); XCTAssertEqual(method, "POST")
                XCTAssertEqual(body?["submissionId"] as? String, draft.submissionID)
                return try JSONEncoder().encode(result)
            }
            _ = try await subject.submitForm(request, action: .init(id: "send", label: "Send", type: "submit"), draft: draft)
            XCTAssertEqual(subject.notice, expected, status); XCTAssertTrue(draft.values.isEmpty, status)
        }
    }
    @MainActor func testResponsePollingCancellationDoesNotPublishNavigationErrors() async {
        for cancelled in [false, true] {
            let gate = SuspendedRelayReply(), api = FixtureRelayAPI(), model = RelayModel()
            api.respond = { _, _, _ in try await gate.reply() }
            let poll = Task {
                do { let _: EmptyReply = try await api.call("/response"); XCTFail("The suspended request must fail") }
                catch { return model.reportResponseFailure(error, fallback: "Could not refresh the request. Try again.") }
                return false
            }
            defer { gate.resume(.failure(CancellationError())); poll.cancel() }
            await fulfillment(of: [gate.entered], timeout: 2)
            if cancelled { poll.cancel() }
            gate.resume(.failure(RelayFailure.unavailable))
            let failed = await poll.value
            XCTAssertEqual(failed, !cancelled)
            if cancelled { XCTAssertNil(model.error) } else { XCTAssertEqual(model.error, RelayFailure.unavailable.localizedDescription) }
        }
    }
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
        XCTAssertNil(retained.closedStatus)
        await model.reconcileFormDrafts(pendingIDs: []) { _ in throw RelayFailure.unavailable }
        XCTAssertEqual(retained.values["answer"], .text("private"))
        await model.reconcileFormDrafts(pendingIDs: []) { _ in self.formState("completed") }
        XCTAssertTrue(retained.values.isEmpty)
        XCTAssertEqual(retained.closedStatus, "completed")
        XCTAssertFalse(model.formDraft(pending) === retained)
        XCTAssertEqual(model.formDraft(pending).closedStatus, "completed")
        model.clearResponses()
    }
    @MainActor func testTerminalFormLoadClearsBeforeAnyOpeningObservation() async throws {
        let model = RelayModel(), retained = model.formDraft(formState("pending"))
        retained.values = ["answer": .text("private")]
        retained.numberInputs = ["number": "123."]
        let terminal = try await model.prepareFormResponse(formState("cancelled"), observations: FormOpeningObservations(), fromNotification: true) { _ in
            XCTFail("Terminal loads must not issue opening observations")
            throw RelayFailure.unavailable
        }
        XCTAssertTrue(terminal === retained); XCTAssertTrue(terminal.values.isEmpty); XCTAssertTrue(terminal.numberInputs.isEmpty)
        XCTAssertFalse(model.formDraft(formState("pending")) === retained)
        XCTAssertEqual(model.formDraft(formState("pending")).closedStatus, "cancelled")
        model.clearResponses()
        var observations: [String] = []
        var received = false
        do {
            _ = try await model.prepareFormResponse(formState("pending"), observations: FormOpeningObservations(), fromNotification: true, receive: { _ in received = true }) { event in
                XCTAssertTrue(received)
                observations.append(event); throw RelayFailure.unavailable
            }
            XCTFail("The failing observation must propagate")
        } catch { XCTAssertEqual(observations, ["notification.tapped", "request.opened"]) }
        model.clearResponses()
    }
    @MainActor func testOpeningRetriesOnlyFailedObservationsAfterContentWasReceived() async throws {
        for failedEvent in ["notification.tapped", "request.opened"] {
            let model = RelayModel(), observations = FormOpeningObservations()
            var received = false, events: [String] = []
            do {
                _ = try await model.prepareFormResponse(formState("pending"), observations: observations, fromNotification: true, receive: { _ in received = true }) { event in
                    XCTAssertTrue(received); events.append(event)
                    if event == failedEvent { throw RelayFailure.unavailable }
                }
                XCTFail("The failed observation must offer retry")
            } catch {}
            XCTAssertEqual(events, ["notification.tapped", "request.opened"])
            events = []
            _ = try await model.prepareFormResponse(formState("pending"), observations: observations, fromNotification: true) { events.append($0) }
            XCTAssertEqual(events, [failedEvent])
            _ = try await model.prepareFormResponse(formState("pending"), observations: observations, fromNotification: true) { _ in XCTFail("Accepted observations must not repeat on polling") }
            model.clearResponses()
        }
    }
    func testRequesterMarkdownRemovesNavigationWithoutRemovingFormatting() {
        let text = inertRequestMarkdown("[Review details](https://operator.example/track) and **careful**.")
        XCTAssertEqual(String(text.characters), "Review details and careful.")
        XCTAssertTrue(text.runs.allSatisfy { $0.link == nil })
        XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    }
    @MainActor func testRetainedSMSReadsDoNotReplaceTheActiveRequestOrItsDraft() {
        let model = RelayModel()
        let current = SMSRequest(requestId: "current", callerName: "Agent", title: "Code", purpose: "Test", status: "ready", expiresAt: 2000000000000)
        model.updateSMS(current)
        let draft = model.draft(current.id, expiresAt: current.expiresAt); draft.code = "123456"
        let oldDraft = model.draft("old", expiresAt: current.expiresAt); oldDraft.code = "654321"
        for status in ["completed", "ready"] {
            model.receiveSMS(.init(requestId: "old", callerName: "Agent", title: "Old", purpose: "Test", status: status, expiresAt: current.expiresAt))
            XCTAssertEqual(model.sms?.id, current.id)
            XCTAssertEqual(draft.code, "123456")
        }
        XCTAssertTrue(oldDraft.code.isEmpty)
        model.receiveSMS(.init(requestId: current.id, callerName: "Agent", title: "Code", purpose: "Test", status: "completed", expiresAt: current.expiresAt))
        XCTAssertTrue(draft.code.isEmpty); XCTAssertEqual(model.sms?.status, "completed")
        XCTAssertEqual(draft.closedStatus, "completed")
        model.clearResponses()
    }
    @MainActor func testOnlyExplicitRegistrationReplacesARemotelyDeletedInstallation() async throws {
        let model = RelayModel(), key = "installation:signed-out"
        let original = try PrivateStorage.read(key)
        defer { if let original { try? PrivateStorage.write(key, original) } else { PrivateStorage.remove(key) } }
        let deletedID = model.deviceID
        XCTAssertFalse(deletedID.isEmpty)
        var attempts: [String] = []
        do {
            _ = try await model.registerInstallation(allowReplacement: false) { id in
                attempts.append(id); throw RelayFailure.rejected("installation_id_unavailable")
            }
            XCTFail("Automatic token refresh must not reconnect a removed device")
        } catch {}
        XCTAssertEqual(attempts, [deletedID]); XCTAssertEqual(model.deviceID, deletedID)
        attempts = []
        let replacement = try await model.registerInstallation(allowReplacement: true) { id in
            attempts.append(id)
            if id == deletedID { throw RelayFailure.rejected("installation_id_unavailable") }
        }
        XCTAssertEqual(attempts, [deletedID, replacement]); XCTAssertNotEqual(replacement, deletedID)
        XCTAssertEqual(model.deviceID, replacement)
        XCTAssertEqual(try PrivateStorage.read(key), Data(replacement.utf8))
        attempts = []
        do {
            _ = try await model.registerInstallation(allowReplacement: true) { id in
                attempts.append(id); throw RelayFailure.unavailable
            }
            XCTFail("Unrelated failures must propagate without rotating the installation")
        } catch {}
        XCTAssertEqual(attempts, [replacement]); XCTAssertEqual(model.deviceID, replacement)
    }
    @MainActor func testSMSSuccessorErasesPriorPrivateDraft() {
        let model = RelayModel()
        func request(_ id: String) -> SMSRequest {
            .init(requestId: id, callerName: "Agent", title: "Code", purpose: "Test", status: "ready", expiresAt: 2000000000000)
        }
        model.updateSMS(request("first"))
        let first = model.draft("first", expiresAt: 2000000000000); first.code = "123456"
        model.updateSMS(request("second"))
        XCTAssertTrue(first.code.isEmpty)
        XCTAssertEqual(first.closedStatus, "closed")
        XCTAssertFalse(model.draft("first", expiresAt: 2000000000000) === first)
        XCTAssertEqual(model.draft("first", expiresAt: 2000000000000).closedStatus, "closed")
        let second = model.draft("second", expiresAt: 2000000000000); second.code = "654321"
        model.updateSMS(request("second")); XCTAssertEqual(second.code, "654321")
        model.updateSMS(nil); XCTAssertTrue(second.code.isEmpty)
        model.clearResponses()
    }
    @MainActor func testOlderRefreshCannotReplaceSuccessorFromInboxOrSMSWait() async throws {
        let key = "installation:signed-out", original = try PrivateStorage.read("installation:signed-out")
        defer { if let original { try? PrivateStorage.write(key, original) } else { PrivateStorage.remove(key) } }
        for suspendedPath in ["inbox", "sms", "empty", "devices", "failure", "form"] {
            let gate = SuspendedRelayReply()
            let api = FixtureRelayAPI(), model = RelayModel(api: api)
            model.signedIn = true
            let installation = model.deviceID
            XCTAssertFalse(installation.isEmpty)
            let old = SMSRequest(requestId: "old", callerName: "Agent", title: "Old", purpose: "Test", status: "ready", expiresAt: 2000000000000)
            let successor = SMSRequest(requestId: "new", callerName: "Agent", title: "New", purpose: "Test", status: "ready", expiresAt: old.expiresAt)
            let oldDevice = Device(deviceId: installation, name: "Phone", paused: false, activeRequestId: suspendedPath == "empty" ? nil : old.id)
            let newDevice = Device(deviceId: installation, name: "Phone", paused: false, activeRequestId: successor.id)
            model.updateSMS(old)
            if suspendedPath == "form" { model.formDraft(formState("pending")).values = ["answer": .text("retain me")] }
            var newer = false
            api.respond = { path, _, _ in
                if path == "/v1/devices" {
                    if !newer && suspendedPath == "devices" { return try await gate.reply() }
                    return try JSONEncoder().encode([newer ? newDevice : oldDevice])
                }
                if path.hasSuffix("/inbox") {
                    if !newer && ["inbox", "empty", "failure"].contains(suspendedPath) { return try await gate.reply() }
                    return Data("[]".utf8)
                }
                if path == "/v2/devices/\(installation)/requests/form" {
                    if !newer { return try await gate.reply() }
                    return try JSONEncoder().encode(self.formState("pending"))
                }
                if path == "/v1/devices/\(installation)/requests/old" {
                    if suspendedPath == "sms" { return try await gate.reply() }
                    return try JSONEncoder().encode(old)
                }
                if path == "/v1/devices/\(installation)/requests/new" { return try JSONEncoder().encode(successor) }
                return Data("[]".utf8)
            }
            let olderRefresh = Task { await model.refresh() }
            defer { gate.resume(.failure(CancellationError())); olderRefresh.cancel(); model.clearResponses() }
            await fulfillment(of: [gate.entered], timeout: 2)
            newer = true
            await model.refresh()
            XCTAssertEqual(model.sms?.id, successor.id)
            let draft = model.draft(successor.id, expiresAt: successor.expiresAt); draft.code = "123456"
            let retainedForm = model.formDraft(formState("pending")); retainedForm.values = ["answer": .text("retain me")]
            if suspendedPath == "failure" { gate.resume(.failure(RelayFailure.unavailable)) }
            else if suspendedPath == "devices" { gate.resume(.success(try JSONEncoder().encode([oldDevice]))) }
            else if suspendedPath == "sms" {
                let terminal = SMSRequest(requestId: old.id, callerName: old.callerName, title: old.title, purpose: old.purpose, status: "completed", expiresAt: old.expiresAt)
                gate.resume(.success(try JSONEncoder().encode(terminal)))
            } else if suspendedPath == "form" { gate.resume(.success(try JSONEncoder().encode(formState("completed")))) }
            else { gate.resume(.success(Data("[]".utf8))) }
            await olderRefresh.value
            XCTAssertEqual(model.sms?.id, successor.id, suspendedPath)
            XCTAssertEqual(model.devices.first?.activeRequestId, successor.id, suspendedPath)
            XCTAssertEqual(draft.code, "123456", suspendedPath)
            XCTAssertEqual(retainedForm.values["answer"], .text("retain me"), suspendedPath)
            XCTAssertNil(model.error, suspendedPath)
        }
    }
    @MainActor func testRefreshCannotPublishAfterSignOutReplacementOrCancellation() async throws {
        let key = "installation:signed-out", original = try PrivateStorage.read("installation:signed-out")
        defer { if let original { try? PrivateStorage.write(key, original) } else { PrivateStorage.remove(key) } }
        for invalidation in ["sign-out", "replacement", "cancel"] {
            let gate = SuspendedRelayReply(), api = FixtureRelayAPI()
            let model = RelayModel(api: api); model.signedIn = true
            let installation = model.deviceID
            XCTAssertFalse(installation.isEmpty)
            api.respond = { path, _, _ in
                XCTAssertEqual(path, "/v1/devices", "Invalidated refresh must stop before another API request")
                return try await gate.reply()
            }
            let refresh = Task { await model.refresh() }
            defer { gate.resume(.failure(CancellationError())); refresh.cancel(); model.clearResponses() }
            await fulfillment(of: [gate.entered], timeout: 2)
            if invalidation == "sign-out" { model.signedIn = false; model.clearResponses() }
            else if invalidation == "cancel" { refresh.cancel() }
            else {
                _ = try await model.registerInstallation(allowReplacement: true) { id in
                    if id == installation { throw RelayFailure.rejected("installation_id_unavailable") }
                }
                XCTAssertNotEqual(model.deviceID, installation)
            }
            gate.resume(.success(try JSONEncoder().encode([Device(deviceId: installation, name: "Old phone", paused: false)])))
            await refresh.value
            XCTAssertTrue(model.devices.isEmpty, invalidation)
            XCTAssertNil(model.error, invalidation)
        }
    }
    @MainActor func testPushUpdateRetriesAfterAuthenticationAndConnectionRestoration() async throws {
        let model = RelayModel()
        var updates = 0
        try await model.updatePushToken()
        model.signedIn = true
        try await model.retryPushTokenUpdate { updates += 1 }
        XCTAssertEqual(updates, 0)
        model.devices = [.init(deviceId: model.deviceID, name: "Phone", paused: true)]
        do {
            try await model.retryPushTokenUpdate { throw RelayFailure.unavailable }
            XCTFail("Failed token upload must propagate")
        } catch {}
        try await model.retryPushTokenUpdate {
            updates += 1
            try await model.retryPushTokenUpdate { XCTFail("A refresh must not recursively synchronize") }
        }
        try await model.retryPushTokenUpdate { updates += 1 }
        XCTAssertEqual(updates, 1)
        model.signedIn = false
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

@MainActor
private final class FixtureRelayAPI: RelayCalling {
    let origin = URL(string: "https://relay.example")!
    var respond: (String, String, [String: Any]?) async throws -> Data = { _, _, _ in throw RelayFailure.unavailable }
    func call<T: Decodable>(_ path: String, method: String, body: [String: Any]?) async throws -> T {
        let data = try await respond(path, method, body)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

@MainActor
private final class SuspendedRelayReply {
    let entered = XCTestExpectation(description: "Older refresh suspended at the requested API boundary")
    private var continuation: CheckedContinuation<Data, Error>?
    private var result: Result<Data, Error>?
    func reply() async throws -> Data {
        entered.fulfill()
        return try await withCheckedThrowingContinuation { continuation in
            if let result { continuation.resume(with: result) }
            else { self.continuation = continuation }
        }
    }
    func resume(_ result: Result<Data, Error>) {
        guard self.result == nil else { return }
        self.result = result
        continuation?.resume(with: result); continuation = nil
    }
}
