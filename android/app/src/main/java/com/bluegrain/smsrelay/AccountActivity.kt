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
    protected fun deleteAccountWithReauthentication() { authenticate(deleteAfter = true) }
    protected fun signIn() { authenticate(deleteAfter = false) }
    private fun authenticate(deleteAfter: Boolean) {
        val expectedOwner = (application as RelayApplication).repository.ownerId
        lifecycleScope.launch {
            try {
                val option = GetGoogleIdOption.Builder().setServerClientId(BuildConfig.GOOGLE_WEB_CLIENT_ID)
                    .setFilterByAuthorizedAccounts(false).setAutoSelectEnabled(false).build()
                val result = CredentialManager.create(this@AccountActivity).getCredential(this@AccountActivity,
                    GetCredentialRequest.Builder().addCredentialOption(option).build())
                val credential = result.credential
                if (credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    vm.signedIn(GoogleIdTokenCredential.createFrom(credential.data).idToken, deleteAfter, expectedOwner)
                } else vm.error("Choose a Google account to continue.")
            } catch (e: CancellationException) { throw e }
            catch (_: NoCredentialException) { vm.error("Add a Google account to this phone, then try again.") }
            catch (_: GetCredentialCancellationException) { vm.error("Google sign-in was cancelled.") }
            catch (_: Exception) { vm.error("Google sign-in was not completed. Try again when ready.") }
        }
    }
}
