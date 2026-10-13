package com.obaflix.ads

import android.app.Activity
import android.preference.PreferenceManager
import com.google.android.ump.ConsentInformation
import com.google.android.ump.ConsentRequestParameters
import com.google.android.ump.UserMessagingPlatform
import com.obaflix.BuildConfig
import com.unity3d.mediation.LevelPlayPrivacySettings

/** Called only after the server determines this user needs advertising. */
object AdConsent {
    fun request(activity: Activity, childDirected: Boolean, done: (Boolean) -> Unit) {
        if (!BuildConfig.ADS_APPROVED || !BuildConfig.ADS_AUDIENCE_VALIDATED || BuildConfig.DEBUG || BuildConfig.ADMOB_APP_ID.isBlank() || childDirected) {
            done(false)
            return
        }
        val info = UserMessagingPlatform.getConsentInformation(activity)
        val params = ConsentRequestParameters.Builder().setTagForUnderAgeOfConsent(childDirected).build()
        info.requestConsentInfoUpdate(activity, params, {
            if (activity.isFinishing || activity.isDestroyed) { done(false); return@requestConsentInfoUpdate }
            UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity) { error ->
                // canRequestAds can allow non-personalized ads after refusal. This rollout
                // is stricter: a refusal or unknown TCF storage consent prevents initialization.
                @Suppress("DEPRECATION")
                val purposes = PreferenceManager.getDefaultSharedPreferences(activity)
                    .getString("IABTCF_PurposeConsents", "") ?: ""
                val allowed = error == null && info.canRequestAds() &&
                    (info.consentStatus == ConsentInformation.ConsentStatus.NOT_REQUIRED || purposes.startsWith("1"))
                if (allowed) {
                    // TCF/Additional Consent propagation is handled by LevelPlay. Never
                    // turn canRequestAds into a blanket GDPR=true for every vendor.
                    LevelPlayPrivacySettings.setCCPA(true) // Conservative no sale/share.
                    LevelPlayPrivacySettings.setCOPPA(childDirected)
                }
                done(allowed)
            }
        }, { done(false) })
    }
    fun privacyOptions(activity: Activity) {
        UserMessagingPlatform.showPrivacyOptionsForm(activity) { }
    }
}
