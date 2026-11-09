package com.bluegrain.smsrelay

import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

class RelayApplication : Application() {
    val configured get() = BuildConfig.RELAY_URL.startsWith("https://") &&
        listOf(BuildConfig.FIREBASE_APP_ID, BuildConfig.FIREBASE_API_KEY, BuildConfig.FIREBASE_PROJECT_ID,
            BuildConfig.FIREBASE_SENDER_ID, BuildConfig.GOOGLE_WEB_CLIENT_ID).all { it.isNotBlank() }
    val repository by lazy { RelayRepository(this) }
    override fun onCreate() {
        super.onCreate()
        RelayNotifications.createChannel(this)
        if (configured) {
            if (FirebaseApp.getApps(this).isEmpty()) FirebaseApp.initializeApp(this, FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FIREBASE_APP_ID).setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
            FirebaseMessaging.getInstance().isAutoInitEnabled = true
        }
    }
}
