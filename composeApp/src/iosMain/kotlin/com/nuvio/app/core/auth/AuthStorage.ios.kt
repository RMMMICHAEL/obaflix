package com.nuvio.app.core.auth

import platform.Foundation.NSUserDefaults

actual object AuthStorage {
    private const val KEY_ANONYMOUS_USER_ID = "anonymous_user_id"
    private const val KEY_OBAFLIX_SESSION = "obaflix_session"
    private const val KEY_DATA_OWNER = "data_owner_user_id"

    actual fun loadAnonymousUserId(): String? =
        NSUserDefaults.standardUserDefaults.stringForKey(KEY_ANONYMOUS_USER_ID)

    actual fun saveAnonymousUserId(userId: String) {
        NSUserDefaults.standardUserDefaults.setObject(userId, forKey = KEY_ANONYMOUS_USER_ID)
    }

    actual fun clearAnonymousUserId() {
        NSUserDefaults.standardUserDefaults.removeObjectForKey(KEY_ANONYMOUS_USER_ID)
    }

    // shortcut: NSUserDefaults is not the Keychain; move to Keychain before any iOS build ships.
    actual fun loadObaflixSession(): String? =
        NSUserDefaults.standardUserDefaults.stringForKey(KEY_OBAFLIX_SESSION)

    actual fun saveObaflixSession(payload: String) {
        NSUserDefaults.standardUserDefaults.setObject(payload, forKey = KEY_OBAFLIX_SESSION)
    }

    actual fun clearObaflixSession() {
        NSUserDefaults.standardUserDefaults.removeObjectForKey(KEY_OBAFLIX_SESSION)
    }

    actual fun loadDataOwner(): String? =
        NSUserDefaults.standardUserDefaults.stringForKey(KEY_DATA_OWNER)

    actual fun saveDataOwner(userId: String) {
        NSUserDefaults.standardUserDefaults.setObject(userId, forKey = KEY_DATA_OWNER)
    }
}
