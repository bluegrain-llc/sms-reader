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
        let app = XCUIApplication(); app.launchArguments = ["--ui-contract"]; app.launch()
        app.buttons["Wizard request"].tap()
        let include = app.switches["Include details"]
        XCTAssertTrue(include.waitForExistence(timeout: 5)); include.tap(); app.buttons["Next"].tap()
        let details = app.textFields["Details"]; XCTAssertTrue(details.waitForExistence(timeout: 5))
        details.tap(); details.typeText("Synthetic response")
        app.buttons["review-response"].tap()
        XCTAssertTrue(app.staticTexts["Review your response"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Send response"].exists)
        XCTAssertFalse(app.alerts.firstMatch.exists)
        app.buttons["Edit response"].tap(); app.buttons["Previous"].tap(); include.tap()
        XCTAssertTrue(app.buttons["review-response"].exists)
        app.buttons["review-response"].tap()
        XCTAssertFalse(app.staticTexts["Synthetic response"].exists)
    }
}

extension RelayUITests {
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
