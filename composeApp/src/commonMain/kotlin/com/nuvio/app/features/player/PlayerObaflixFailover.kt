package com.nuvio.app.features.player

import co.touchlab.kermit.Logger
import com.nuvio.app.core.ui.NuvioToastController
import com.nuvio.app.features.servers.ServerStreams
import com.nuvio.app.features.streams.AddonStreamGroup
import com.nuvio.app.features.streams.StreamItem
import com.nuvio.app.integration.obaflix.ObaflixNative
import com.nuvio.app.integration.obaflix.ObaflixRef
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Bounded: a title with many dead sources must end in a clear error, not loop. */
internal const val OBAFLIX_MAX_AUTO_ADVANCE = 6

/**
 * A source that has not shown its first frame after this long is treated as dead. Only applies
 * before the first frame of each attempt: rebuffering of a source that already played never counts.
 */
internal const val OBAFLIX_INITIAL_STALL_MS = 25_000L

internal const val OBAFLIX_SOURCES_EXHAUSTED =
    "Nenhuma fonte disponível conseguiu reproduzir este conteúdo. Escolha outra fonte ou tente novamente."

private const val SOURCES_WAIT_MS = 20_000L
private val log = Logger.withTag("ObaflixFailover")

/** Addon sources first (their order), Obaflix servers last; never a source already tried. */
internal fun nextObaflixCandidate(groups: List<AddonStreamGroup>, tried: Set<String>): StreamItem? =
    groups.sortedBy { ServerStreams.isServerSourceId(it.addonId) }
        .asSequence()
        .flatMap { it.streams.asSequence() }
        .firstOrNull { it.hasPlayableSource && it.obaflixAttemptKey() !in tried }

internal fun StreamItem.obaflixAttemptKey(): String =
    playerSourceIdentityKey() ?: playableDirectUrl ?: "$addonId|$streamLabel"

/** Public, non-sensitive description of a source: category plus the labels the user already sees. */
internal fun obaflixSourceLabel(addonId: String?, providerName: String, streamTitle: String?): String =
    if (addonId == ObaflixNative.GROUP_ID) {
        listOfNotNull("Fonte Nativa", streamTitle?.takeIf { it.isNotBlank() }).joinToString(" · ")
    } else {
        listOfNotNull("Addon", providerName.takeIf { it.isNotBlank() }).joinToString(" · ")
    }

internal val PlayerScreenRuntime.isObaflixContent: Boolean
    get() = ObaflixRef.parse(activeVideoId ?: "") != null

/** Header text for the provider slot: Obaflix content shows its category, other content is untouched. */
internal val PlayerScreenRuntime.obaflixAwareProviderName: String
    get() = if (isObaflixContent) obaflixSourceLabel(activeProviderAddonId, activeProviderName, null) else activeProviderName

/**
 * After a REAL failure (player error, initial stall, or a server that could not be resolved), moves to
 * the next compatible source of the same Obaflix title through [switchToSource], so the gate,
 * preparation and cancellation stay exactly as for a manual choice. Returns false only for
 * non-Obaflix content; when sources run out it shows [OBAFLIX_SOURCES_EXHAUSTED] instead.
 */
internal fun PlayerScreenRuntime.tryNextObaflixSource(
    failed: StreamItem?,
    reason: String = "erro",
    skipActive: Boolean = true,
): Boolean {
    val videoId = activeVideoId ?: return false
    if (ObaflixRef.parse(videoId) == null) return false
    if (obaflixAdvanceVideoId != videoId) {
        obaflixAdvanceVideoId = videoId
        obaflixTriedSources = emptySet()
        obaflixAdvanceCount = 0
    }
    obaflixTriedSources = obaflixTriedSources +
        listOfNotNull(failed?.obaflixAttemptKey(), activeStream?.takeIf { skipActive }?.obaflixAttemptKey())
    val failedLabel = failed?.let { obaflixSourceLabel(it.addonId, it.addonName, it.streamLabel) }
    log.w { "fonte_falhou motivo=$reason fonte=\"$failedLabel\" tentativa=$obaflixAdvanceCount/$OBAFLIX_MAX_AUTO_ADVANCE" }
    if (obaflixAdvanceCount >= OBAFLIX_MAX_AUTO_ADVANCE) {
        showObaflixSourcesExhausted()
        return true
    }

    errorMessage = null
    scope.launch {
        val type = contentType ?: parentMetaType
        // Idempotent for the same request: reuses loaded groups, starts loading for a new episode.
        PlayerStreamsRepository.loadSources(type, videoId, activeSeasonNumber, activeEpisodeNumber)
        // Progressive: take the first untried candidate as soon as any group delivers one.
        val next = withTimeoutOrNull(SOURCES_WAIT_MS) { awaitObaflixCandidate(obaflixTriedSources) }
        if (activeVideoId != videoId) return@launch
        if (next == null) {
            showObaflixSourcesExhausted()
            return@launch
        }
        obaflixAdvanceCount++
        obaflixTriedSources = obaflixTriedSources + next.obaflixAttemptKey()
        val label = obaflixSourceLabel(next.addonId, next.addonName, next.streamLabel)
        log.i { "troca_automatica tentativa=$obaflixAdvanceCount/$OBAFLIX_MAX_AUTO_ADVANCE fonte=\"$label\"" }
        NuvioToastController.show("Trocando para: $label")
        switchToSource(next, saveForReuse = false)
    }
    return true
}

/** "Tentar novamente": same title, fresh attempt budget, already loaded sources (no repeated search). */
internal fun PlayerScreenRuntime.retryObaflixSources() {
    obaflixTriedSources = emptySet()
    obaflixAdvanceCount = 0
    errorMessage = null
    log.i { "nova_tentativa_manual" }
    tryNextObaflixSource(failed = null, reason = "nova_tentativa", skipActive = false)
}

/** Initial stall: no first frame within [OBAFLIX_INITIAL_STALL_MS] for this attempt. */
internal fun PlayerScreenRuntime.onObaflixInitialStall() {
    tryNextObaflixSource(failed = activeStream, reason = "travamento_inicial")
}

private fun PlayerScreenRuntime.showObaflixSourcesExhausted() {
    log.w { "fontes_esgotadas tentativas=$obaflixAdvanceCount" }
    errorMessage = OBAFLIX_SOURCES_EXHAUSTED
    controlsVisible = !playerControlsLocked
}

private suspend fun awaitObaflixCandidate(tried: Set<String>): StreamItem? {
    while (true) {
        val state = PlayerStreamsRepository.sourceState.value
        nextObaflixCandidate(state.groups, tried)?.let { return it }
        if (!state.isAnyLoading && state.groups.isNotEmpty()) return null
        delay(250)
    }
}
