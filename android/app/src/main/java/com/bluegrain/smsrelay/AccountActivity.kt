package com.bluegrain.smsrelay

import android.Manifest
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

abstract class AccountActivity : ComponentActivity() {
    protected open val administrationOnly = false
    protected open val resumePausedPhoneOnRegistration = false
    protected val vm: RelayViewModel by viewModels {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                RelayViewModel(application, administrationOnly) as T
        }
    }
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) vm.register(resumePausedPhoneOnRegistration) else vm.error("Enable notifications in Android settings before registering this phone.")
    }
    protected fun register() {
        if (Build.VERSION.SDK_INT >= 33 && !RelayNotifications.enabled(this)) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        else if (RelayNotifications.enabled(this)) vm.register(resumePausedPhoneOnRegistration)
        else vm.error("Enable the code request notification channel in Android settings.")
    }
    protected fun deleteAccountWithReauthentication() {
        val user = com.google.firebase.auth.FirebaseAuth.getInstance().currentUser
        if (user?.providerData?.any { it.providerId == "apple.com" } == true) authenticateApple(deleteAfter = true)
        else authenticate(deleteAfter = true)
    }
    protected fun signIn() {
        val user = if ((application as RelayApplication).configured) com.google.firebase.auth.FirebaseAuth.getInstance().currentUser else null
        val options = mutableListOf<Pair<String, () -> Unit>>()
        if (user == null) {
            options += "Continue with Google" to { authenticate(false) }
            options += "Continue with Apple" to { authenticateApple() }
        } else {
            if (user.providerData.any { it.providerId == "google.com" }) options += "Verify Google account" to { authenticate(false) }
            else options += "Link Google account" to { confirmLink { authenticate(false, link = true, expectedLinkOwner = user.uid) } }
            if (user.providerData.any { it.providerId == "apple.com" }) options += "Verify Apple account" to { authenticateApple() }
            else options += "Link Apple account" to { confirmLink { authenticateApple(link = true, expectedLinkOwner = user.uid) } }
            options += "Sign out" to { vm.signOut(user.uid) }
        }
        android.app.AlertDialog.Builder(this).setTitle(if (user == null) "Sign in" else "Account sign-in methods")
            .setItems(options.map { it.first }.toTypedArray()) { _, index -> options[index].second() }.setNegativeButton("Cancel", null).show()
    }
    private fun confirmLink(action: () -> Unit) {
        android.app.AlertDialog.Builder(this).setTitle("Link sign-in methods?")
            .setMessage("I consent to connect this provider to my current relay account. Accounts are never merged by email.")
            .setPositiveButton("Link account") { _, _ -> action() }.setNegativeButton("Cancel", null).show()
    }
    private fun authenticateApple(deleteAfter: Boolean = false, link: Boolean = false, expectedLinkOwner: String? = null) {
        val auth = com.google.firebase.auth.FirebaseAuth.getInstance()
        val user = auth.currentUser
        val owner = user?.uid
        lifecycleScope.launch {
            try {
                val provider = com.google.firebase.auth.OAuthProvider.newBuilder("apple.com").setScopes(listOf("email", "name")).build()
                if (deleteAfter) {
                    var accessToken: String? = null
                    vm.deleteAccountWithReauthentication(owner.orEmpty(), reauthenticate = {
                        val result = checkNotNull(user).startActivityForReauthenticateWithProvider(this@AccountActivity, provider).await()
                        accessToken = (result.credential as? com.google.firebase.auth.OAuthCredential)?.accessToken ?: error("apple_token_required")
                        result.user?.uid.orEmpty()
                    }, revoke = { auth.revokeAccessToken(checkNotNull(accessToken)).await() })
                } else if (link) {
                    linkForOwner(checkNotNull(expectedLinkOwner), { auth.currentUser?.uid }) {
                        checkNotNull(user).startActivityForLinkWithProvider(this@AccountActivity, provider).await().user?.uid
                    }
                    vm.refresh().join()
                } else {
                    val result = when {
                        user != null -> user.startActivityForReauthenticateWithProvider(this@AccountActivity, provider)
                        else -> auth.startActivityForSignInWithProvider(this@AccountActivity, provider)
                    }.await()
                    check(owner == null || result.user?.uid == owner)
                    vm.refresh().join()
                }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { vm.error("Apple sign-in was not completed. Use the same account and retry. Link providers only through Link account.") }
        }
    }
    private fun authenticate(deleteAfter: Boolean, link: Boolean = false, expectedLinkOwner: String? = null) {
        val expectedOwner = (application as RelayApplication).repository.ownerId
        val auth = com.google.firebase.auth.FirebaseAuth.getInstance()
        val linkUser = auth.currentUser
        lifecycleScope.launch {
            try {
                if (link) check(expectedLinkOwner != null && linkUser?.uid == expectedLinkOwner)
                val option = GetGoogleIdOption.Builder().setServerClientId(BuildConfig.GOOGLE_WEB_CLIENT_ID)
                    .setFilterByAuthorizedAccounts(false).setAutoSelectEnabled(false).build()
                val result = CredentialManager.create(this@AccountActivity).getCredential(this@AccountActivity,
                    GetCredentialRequest.Builder().addCredentialOption(option).build())
                val credential = result.credential
                if (credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    val token = GoogleIdTokenCredential.createFrom(credential.data).idToken
                    if (link) {
                        linkForOwner(checkNotNull(expectedLinkOwner), { auth.currentUser?.uid }) {
                            checkNotNull(linkUser).linkWithCredential(com.google.firebase.auth.GoogleAuthProvider.getCredential(token, null)).await().user?.uid
                        }
                        vm.refresh().join()
                    } else vm.signedIn(token, deleteAfter, expectedOwner)
                } else vm.error("Choose a Google account to continue.")
            } catch (e: CancellationException) { throw e }
            catch (_: NoCredentialException) { vm.error("Add a Google account to this phone, then try again.") }
            catch (_: GetCredentialCancellationException) { vm.error("Google sign-in was cancelled.") }
            catch (_: Exception) { vm.error("Google sign-in was not completed. Try again when ready.") }
        }
    }
}
