package com.nuvio.app.integration.obaflix.ads

/** How often the Rewarded may be requested again: a few spaced retries after failure, one reload after a show. */
internal class RewardedReloadPolicy(
    private val atrasosAposFalhaMs: List<Long> = listOf(5_000L, 15_000L, 45_000L),
    val aposExibicaoMs: Long = 2_000L,
) {
    /** Delay before retry number [falhasConsecutivas] (1-based), or null when automatic retries are exhausted. */
    fun aposFalha(falhasConsecutivas: Int): Long? = atrasosAposFalhaMs.getOrNull(falhasConsecutivas - 1)
}
