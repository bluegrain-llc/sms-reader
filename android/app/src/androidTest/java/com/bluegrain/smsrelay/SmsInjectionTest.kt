package com.bluegrain.smsrelay

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Opt-in feasibility check using emulator telephony and the real Play services API.
 * Run with scripts/test-sms-injection.py. Never runs against a physical phone.
 */
class SmsInjectionTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun stage(value: String) {
        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
            putString("smsProbeStage", value)
        })
    }

    @Test fun injectedSmsRequiresSystemConsentBeforeExtraction() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("smsInjection") == "true")
        assumeTrue(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val listening = CountDownLatch(1)
        val received = CountDownLatch(1)
        val decided = CountDownLatch(1)
        val failure = AtomicReference<String?>(null)
        val consent = AtomicReference<Intent?>(null)
        val approvedText = AtomicReference<String?>(null)
        val gate = ConsentGate().apply { bind("emulator-injection") }
        compose.setContent { RelayTheme { Text("Synthetic SMS consent test") } }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
                val status = IntentCompat.getParcelableExtra(intent, SmsRetriever.EXTRA_STATUS, Status::class.java)
                if (status?.statusCode == CommonStatusCodes.SUCCESS) {
                    consent.set(IntentCompat.getParcelableExtra(intent, SmsRetriever.EXTRA_CONSENT_INTENT, Intent::class.java))
                } else failure.set("sms_api_status_${status?.statusCode}")
                received.countDown()
            }
        }
        val launcher = compose.activity.activityResultRegistry.register("sms-injection", ActivityResultContracts.StartActivityForResult()) {
            if (it.resultCode == Activity.RESULT_OK) approvedText.set(it.data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE))
            else failure.set("consent_not_approved")
            decided.countDown()
        }
        ContextCompat.registerReceiver(context, receiver, IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
            SmsRetriever.SEND_PERMISSION, null, ContextCompat.RECEIVER_EXPORTED)
        try {
            compose.runOnUiThread {
                SmsRetriever.getClient(compose.activity).startSmsUserConsent(null)
                    .addOnSuccessListener { listening.countDown() }
                    .addOnFailureListener { failure.set("listener_start_failed"); listening.countDown() }
            }
            assertTrue("Listener start timed out", listening.await(20, TimeUnit.SECONDS))
            assertTrue("Listener failed to start", failure.get() == null)
            assertFalse("Code permitted before consent", gate.permits("emulator-injection", "482619"))
            stage("ready_for_injection")
            assertTrue("No Play services consent broadcast after injected SMS", received.await(75, TimeUnit.SECONDS))
            assertTrue("Play services did not provide a consent intent", failure.get() == null && consent.get() != null)
            assertTrue("Message exposed before system approval", approvedText.get() == null)
            assertFalse("Code permitted before system approval", gate.permits("emulator-injection", "482619"))
            compose.runOnUiThread { launcher.launch(consent.get()!!) }
            stage("consent_opened")
            // This isolated emulator contains only the synthetic SMS supplied by the runner.
            // Never inspect or click a real phone's consent dialog.
            var clicked = false
            repeat(40) {
                if (!clicked) {
                    val root = instrumentation.uiAutomation.rootInActiveWindow
                    val allow = root?.findAccessibilityNodeInfosByText("Allow")?.firstOrNull {
                        it.packageName?.toString() == "com.google.android.gms" && it.isClickable
                    }
                    if (allow != null) clicked = allow.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    else Thread.sleep(250)
                }
            }
            assertTrue("System consent Allow button not found", clicked)
            assertTrue("Consent result timed out", decided.await(15, TimeUnit.SECONDS))
            assertTrue("Consent did not return an approved message", failure.get() == null && approvedText.get() != null)
            val candidates = gate.approve("emulator-injection", approvedText.getAndSet(null).orEmpty())
            assertTrue("Approved synthetic code extraction failed", candidates == listOf("482619"))
            assertTrue("Approved code not permitted", gate.permits("emulator-injection", "482619"))
            stage("approved_code_extracted")
        } finally {
            context.unregisterReceiver(receiver)
            compose.runOnUiThread { launcher.unregister() }
            approvedText.set(null)
            gate.clear()
        }
    }
}
