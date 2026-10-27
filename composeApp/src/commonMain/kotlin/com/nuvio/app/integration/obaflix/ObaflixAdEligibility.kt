package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Whether this account may be shown ads. Starts [State.UNKNOWN] and anything but [State.ELIGIBLE]
 * keeps the Unity SDK untouched (no init, load, show or banner). Memory only, never persisted.
 *
 * Ads are contextual for everyone (`nonBehavioral=true`, set by the provider before init), so age is not
 * collected. What remains is the commercial right: only the server's `ANUNCIO_NECESSARIO` (account is not
 * exempt) confirms it. A dedicated eligibility endpoint can call [confirm] later; none exists yet.
 */
internal object ObaflixAdEligibility {
    enum class State { UNKNOWN, ELIGIBLE, INELIGIBLE }

    private val _flow = MutableStateFlow(State.UNKNOWN)

    /** Observed by UI slots (banner) so they appear/disappear with the answer and on sign-out. */
    val flow: StateFlow<State> get() = _flow

    val state: State get() = _flow.value

    val allowsAds: Boolean get() = state == State.ELIGIBLE

    fun confirm(eligible: Boolean) {
        _flow.value = if (eligible) State.ELIGIBLE else State.INELIGIBLE
    }

    /** Sign-out and account switch: the next account starts unknown. */
    fun reset() {
        _flow.value = State.UNKNOWN
    }
}
