package com.bluegrain.smsrelay

import androidx.compose.ui.test.*
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.coroutines.CompletableDeferred
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Consent tests use an in-memory transport and never sign in or register a real phone. */
class OnboardingScreenTest {
    @get:Rule val compose = createComposeRule()
    private val account = RelayUiState(configured = true, signedIn = true, email = "my-account@example.test")
    private fun review(status: String = "pending") = JSONObject()
        .put("sessionId", "attempt").put("name", "My agent").put("purpose", "Ask for decisions")
        .put("status", status).put("capabilities", JSONArray(listOf("forms", "sms")))
        .put("expiresInDays", JSONObject.NULL).put("connectionId", JSONObject.NULL)
    private fun screen(kind: String, request: suspend (String, String, JSONObject?) -> JSONObject) {
        compose.setContent {
            RelayTheme {
                OnboardingScreen(OnboardingLink(kind, "attempt"), "nonce", account, request,
                    onSignIn = { fail("Sign-in is unnecessary") },
                    onRegister = { fail("Opening a link must not register a phone") },
                    onClose = {}, onRestart = {}, onManage = {})
            }
        }
        compose.waitForIdle()
    }

    @Test fun registrationDefaultsToNoOwnerAccessAndNeedsOneConfirmation() {
        val decisions = mutableListOf<JSONObject>()
        screen("register") { method, _, body ->
            if (method == "GET") review() else {
                decisions.add(JSONObject(body.toString()))
                review("approved")
            }
        }
        compose.onNodeWithText("Also allow this service to send requests to me").assertDoesNotExist()
        compose.onNodeWithText("Information and decisions through forms").assertDoesNotExist()
        assertTrue(decisions.isEmpty())
        compose.onNode(hasText("Register agent") and hasClickAction()).performScrollTo().performClick()
        compose.onNodeWithText("Service registered. Return to the CLI to finish setup. A receiving phone is not required.").assertIsDisplayed()
        assertEquals(1, decisions.size)
        assertFalse(decisions.single().getBoolean("selfAccess"))
    }

    @Test fun registrationCannotIncludeAccountAccess() {
        val decisions = mutableListOf<JSONObject>()
        screen("register") { method, _, body -> if (method == "GET") review() else { decisions.add(JSONObject(body.toString())); review("approved") } }
        compose.onNodeWithText("Also allow this service to send requests to me").assertDoesNotExist()
        compose.onNodeWithText("Information and decisions through forms").assertDoesNotExist()
        compose.onNode(hasText("Register agent") and hasClickAction()).performScrollTo().performClick()
        compose.waitForIdle(); assertEquals(1, decisions.size); assertFalse(decisions.single().getBoolean("selfAccess"))
    }

    @Test fun retryPreservesPermissionSelectionAndBusyDecisionCannotDoubleSubmit() {
        val decisions = mutableListOf<JSONObject>()
        val response = CompletableDeferred<JSONObject>()
        screen("pair") { method, _, body ->
            if (method == "GET") review() else {
                decisions.add(JSONObject(body.toString()))
                if (decisions.size == 1) throw ApiFailure("unavailable", 503)
                response.await()
            }
        }
        compose.onNodeWithText("Upcoming SMS codes, shared with your approval").performClick()
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        compose.onNodeWithText("Try again").performScrollTo().performClick()
        compose.onNodeWithText("Upcoming SMS codes, shared with your approval").performScrollTo().assertIsOff()
        assertEquals(1, decisions.size)
        compose.onNodeWithText("Connect").performScrollTo().performClick().assertIsNotEnabled()
        assertEquals(2, decisions.size)
        assertTrue(decisions.all { it.getJSONArray("capabilities").toString() == "[\"forms\"]" })
        compose.runOnIdle { response.complete(review("denied")) }
        compose.onNodeWithText("Cancelled. No new access was granted.").assertIsDisplayed()
    }

    @Test fun expiredSessionCannotBeApprovedAndOpeningDoesNotDecide() {
        var decisions = 0
        screen("pair") { method, _, _ ->
            if (method != "GET") decisions++
            review("expired")
        }
        compose.onNodeWithText("This session expired. Request a fresh link and approve access again.").assertIsDisplayed()
        compose.onNodeWithText("Connect").assertDoesNotExist()
        assertEquals(0, decisions)
    }

    @Test fun hostedApprovalNamesTheAppAndApprovesOnlyTheDisplayedSelection() {
        var approved = false
        val decisions = mutableListOf<JSONObject>()
        screen("oauth") { method, path, body ->
            when {
                path.startsWith("/v3/connections/") -> JSONObject().put("setup", "setup_complete")
                method == "POST" -> {
                    decisions.add(JSONObject(body.toString()))
                    approved = true
                    JSONObject().put("redirect", "https://assistant.example/callback?code=never-displayed")
                }
                else -> review(if (approved) "approved" else "pending")
                    .put("clientName", "Hosted assistant").put("clientOrigin", "https://assistant.example")
                    .put("connectionId", if (approved) "connection" else JSONObject.NULL)
            }
        }
        compose.onNodeWithText("Requested by Hosted assistant (https://assistant.example). These app details are supplied by the app operator.").assertIsDisplayed()
        assertTrue(decisions.isEmpty())
        compose.onNodeWithText("Upcoming SMS codes, shared with your approval").performScrollTo().performClick()
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        compose.onNodeWithText("Setup complete. The service can request your approval.").assertIsDisplayed()
        assertEquals(1, decisions.size)
        assertEquals("[\"forms\"]", decisions.single().getJSONArray("capabilities").toString())
        compose.onNodeWithText("never-displayed", substring = true).assertDoesNotExist()
    }
    @Test fun changingDestinationCancelsTheOldDecision() {
        var target by mutableStateOf(OnboardingLink("pair", "first"))
        val started = CompletableDeferred<Unit>()
        val oldDecision = CompletableDeferred<JSONObject>()
        compose.setContent {
            RelayTheme {
                OnboardingScreen(target, target.id, account, request = { method, path, _ ->
                    if (method == "POST") { started.complete(Unit); oldDecision.await() }
                    else review().put("sessionId", target.id).put("name", if (path.contains("first")) "First service" else "Second service")
                }, onSignIn = {}, onRegister = {}, onClose = {}, onRestart = {}, onManage = {})
            }
        }
        compose.waitForIdle()
        compose.onNode(hasText("Connect") and hasClickAction()).performScrollTo().performClick()
        compose.waitUntil(5000) { started.isCompleted }
        compose.runOnIdle { target = OnboardingLink("pair", "second") }
        compose.waitForIdle()
        compose.onNodeWithText("Second service").assertIsDisplayed()
        compose.runOnIdle { oldDecision.complete(review("approved").put("name", "First service")) }
        compose.waitForIdle()
        compose.onNodeWithText("Second service").assertIsDisplayed()
        compose.onNodeWithText("First service").assertDoesNotExist()
        compose.onNode(hasText("Connect") and hasClickAction()).assertIsEnabled()
    }

    @Test fun pausedPhoneSetupRequiresAnExplicitResumeAction() {
        var resumes = 0
        compose.setContent {
            RelayTheme {
                OnboardingScreen(OnboardingLink("pair", "attempt"), "nonce",
                    account.copy(registered = true, paused = true), request = { _, path, _ ->
                        if (path.startsWith("/v3/connections/")) JSONObject().put("setup", "phone_setup_needed")
                        else review("approved").put("connectionId", "connection")
                    }, onSignIn = {}, onRegister = { resumes++ }, onClose = {}, onRestart = {}, onManage = {})
            }
        }
        compose.waitForIdle()
        compose.onNodeWithText("Access granted — connect a phone to receive requests").performScrollTo().assertIsDisplayed()
        assertEquals(0, resumes)
        compose.onNodeWithText("Resume this phone").performScrollTo().performClick()
        assertEquals(1, resumes)
    }

}
