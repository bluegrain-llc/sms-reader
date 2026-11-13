import XCTest

final class RelayUITests: XCTestCase {
    func testUnconfiguredBuildShowsSetupWithoutRequestingData() {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.staticTexts["Your approval, every time."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Install a build configured with this relay’s Firebase project and HTTPS origin."].exists)
        XCTAssertFalse(app.buttons["Send"].exists)
    }
}

extension RelayUITests {
    func testManualCodeWaitsForExplicitSend() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-contract"]; app.launch()
        app.buttons["Manual code"].tap()
        let send = app.buttons["send-code"], input = app.textFields["code-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); XCTAssertFalse(send.isEnabled)
        input.tap(); input.typeText("123456")
        XCTAssertTrue(send.isEnabled); XCTAssertFalse(app.alerts.firstMatch.exists)
        send.tap()
        XCTAssertTrue(app.alerts["Request Relay"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.alerts.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Sign-in was not completed")).firstMatch.exists)
    }
    func testConditionalWizardKeepsAReviewStep() {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launchArguments = ["--ui-contract"]; app.launch()
        app.buttons["Wizard request"].tap()
        let include = app.switches["field-include"]
        XCTAssertTrue(include.waitForExistence(timeout: 5))
        XCTAssertLessThan(include.frame.width, 100, "The query must target the switch control, not the whole labeled row")
        include.tap()
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: include)
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed)
        let next = app.buttons["review-response"]
        XCTAssertTrue(next.waitForExistence(timeout: 5)); XCTAssertEqual(next.label, "Next"); next.tap()
        let details = app.textFields["Details"]; XCTAssertTrue(details.waitForExistence(timeout: 5))
        details.tap(); details.typeText("Synthetic response")
        app.buttons["review-response"].tap()
        XCTAssertTrue(app.staticTexts["form-review-heading"].waitForExistence(timeout: 5))
        let privateAnswer = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Synthetic response")).firstMatch
        XCTAssertTrue(privateAnswer.exists)
        XCTAssertTrue(app.buttons["Send response"].exists)
        XCTAssertFalse(app.alerts.firstMatch.exists)
        app.buttons["Edit response"].tap(); app.buttons["Previous"].tap()
        include.tap()
        let deselected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "0"), object: include)
        XCTAssertEqual(XCTWaiter.wait(for: [deselected], timeout: 5), .completed)
        XCTAssertTrue(app.buttons["review-response"].exists)
        app.buttons["review-response"].tap()
        XCTAssertTrue(app.staticTexts["form-review-heading"].waitForExistence(timeout: 5))
        XCTAssertFalse(privateAnswer.exists)
    }
}

extension RelayUITests {
    func testTerminalCodeSubmissionClosesEditorWithoutPolling() {
        continueAfterFailure = false
        executionTimeAllowance = 60
        let app = XCUIApplication(); app.launchArguments = ["--ui-contract"]; app.launch()
        defer { app.terminate() }
        app.buttons["Code submission without polling"].tap()
        let input = app.textFields["code-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap(); input.typeText("123456")
        app.buttons["send-code"].tap()
        XCTAssertTrue(app.staticTexts["terminal-refresh-pending"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["This request is completed."].waitForExistence(timeout: 5))
        XCTAssertFalse(input.exists); XCTAssertFalse(app.buttons["send-code"].exists); XCTAssertFalse(app.buttons["Decline"].exists)
        XCTAssertTrue(app.staticTexts["terminal-refresh-pending"].exists)
        app.buttons["Finish refresh"].tap()
    }
    func testTerminalFormSubmissionClosesEditorWithoutPolling() {
        continueAfterFailure = false
        executionTimeAllowance = 60
        let app = XCUIApplication(); app.launchArguments = ["--ui-contract"]; app.launch()
        defer { app.terminate() }
        app.buttons["Form submission without polling"].tap()
        let input = app.textFields["Answer"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap(); input.typeText("Synthetic answer")
        app.buttons["review-response"].tap(); app.buttons["Send response"].tap()
        let confirm = app.sheets.buttons["Send response"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5)); confirm.tap()
        XCTAssertTrue(app.staticTexts["terminal-refresh-pending"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["This request is submitted."].waitForExistence(timeout: 5))
        XCTAssertFalse(input.exists); XCTAssertFalse(app.buttons["Edit response"].exists); XCTAssertFalse(app.buttons["review-response"].exists)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Synthetic answer")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["terminal-refresh-pending"].exists)
        app.buttons["Finish refresh"].tap()
    }
    func testExternalCancellationClosesBothMountedEditorsWithoutPolling() {
        continueAfterFailure = false
        for form in [false, true] {
            let app = XCUIApplication(); app.launchArguments = ["--ui-contract"]; app.launch()
            app.buttons[form ? "Cancelled form without polling" : "Cancelled code without polling"].tap()
            let input = app.textFields[form ? "Answer" : "code-input"]
            XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap(); input.typeText(form ? "Synthetic answer" : "123456")
            app.buttons["Cancel request on relay"].tap()
            XCTAssertTrue(app.staticTexts["This request is cancelled."].waitForExistence(timeout: 5))
            XCTAssertFalse(input.exists); XCTAssertFalse(app.buttons["review-response"].exists); XCTAssertFalse(app.buttons["send-code"].exists)
            XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Synthetic answer")).firstMatch.exists)
            app.terminate()
        }
    }
    func testExpiredSMSCannotAcceptAnotherPrivateCode() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-contract"]; app.launch()
        app.buttons["Manual code"].tap()
        let input = app.textFields["code-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap(); input.typeText("123456")
        app.buttons["Expire entry window"].tap()
        XCTAssertTrue(app.staticTexts["The entry window has closed."].waitForExistence(timeout: 5))
        XCTAssertFalse(input.exists); XCTAssertFalse(app.buttons["send-code"].exists)
        XCTAssertFalse(app.staticTexts["123456"].exists)
    }
    func testClearingDraftErasesMountedNumericInput() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-contract"]; app.launch()
        app.buttons["Numeric draft"].tap()
        let input = app.textFields["Private number"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap(); input.typeText("123.")
        XCTAssertEqual(input.value as? String, "123.")
        app.buttons["Clear retained draft"].tap()
        XCTAssertEqual(input.value as? String, "Private number")
    }
    func testPrivacyCoverAlsoCoversPresentedResponse() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-contract"]; app.launch()
        app.buttons["Private modal"].tap()
        let response = app.staticTexts["private-modal-response"]
        XCTAssertTrue(response.waitForExistence(timeout: 5)); XCTAssertTrue(response.isHittable)
        app.buttons["Hide preview"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["response-privacy-cover"].waitForExistence(timeout: 5))
        XCTAssertFalse(response.isHittable)
    }
}
