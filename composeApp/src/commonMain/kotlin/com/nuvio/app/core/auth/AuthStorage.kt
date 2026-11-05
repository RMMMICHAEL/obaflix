package com.nuvio.app.core.auth

internal expect object AuthStorage {
    fun loadAnonymousUserId(): String?
    fun saveAnonymousUserId(userId: String)
    fun clearAnonymousUserId()
    fun loadObaflixSession(): String?
    fun saveObaflixSession(payload: String)
    fun clearObaflixSession()
    fun loadDataOwner(): String?
    fun saveDataOwner(userId: String)
}
