package com.nuvio.app

import com.nuvio.app.core.auth.AuthState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AppGateSessionTest {
    @Test
    fun withoutASessionTheGateNeverReachesProfilesOrMain() {
        assertEquals("Loading", gateScreenWithoutSession(AuthState.Loading))
        assertEquals("Auth", gateScreenWithoutSession(AuthState.Unauthenticated))
        assertNull(gateScreenWithoutSession(AuthState.Authenticated(userId = "u1", email = "a@b.c", isAnonymous = true)))
    }
}
