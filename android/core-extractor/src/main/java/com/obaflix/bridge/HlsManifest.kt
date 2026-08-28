package com.obaflix.bridge

import java.net.URL

/** Uma variante de qualidade declarada em #EXT-X-STREAM-INF. */
data class HlsVariant(
    val bandwidth: Int,
    val resolution: String?,
    val label: String,
)

/** Resumo do que um manifesto HLS oferece ao player. */
data class HlsMediaInfo(
    val isMaster: Boolean,
    val variants: List<HlsVariant> = emptyList(),
    val audioTracks: List<String> = emptyList(),
    val subtitles: List<SubtitleTrack> = emptyList(),
)

/**
 * Leitura mínima de manifestos HLS para comparar servidores antes de escolher um.
 *
 * O extrator antigo aceitava a primeira fonte que respondia, sem saber se ela
 * tinha uma única qualidade ou um master com áudio e legendas. Com este parser a
 * escolha passa a ser feita pelo que o manifesto realmente entrega.
 */
object HlsManifest {

    fun looksLikeManifest(text: String): Boolean = text.trimStart().startsWith("#EXTM3U")

    /**
     * Divide a lista de atributos de uma tag EXT-X preservando vírgulas dentro de
     * valores entre aspas, como em CODECS="avc1.4d401f,mp4a.40.2".
     */
    private fun splitAttributes(raw: String): Map<String, String> {
        val parts = mutableListOf<String>()
        val current = StringBuilder()
        var quoted = false
        for (char in raw) {
            when {
                char == '"' -> { quoted = !quoted; current.append(char) }
                char == ',' && !quoted -> { parts.add(current.toString()); current.setLength(0) }
                else -> current.append(char)
            }
        }
        if (current.isNotEmpty()) parts.add(current.toString())

        val values = linkedMapOf<String, String>()
        for (part in parts) {
            val eq = part.indexOf('=')
            if (eq <= 0) continue
            val key = part.substring(0, eq).trim().uppercase()
            val value = part.substring(eq + 1).trim().trim('"')
            if (key.isNotEmpty()) values[key] = value
        }
        return values
    }

    private fun qualityLabel(resolution: String?, bandwidth: Int): String {
        val height = resolution?.substringAfter('x', "")?.trim()?.toIntOrNull()
        if (height != null && height > 0) return "${height}p"
        if (bandwidth > 0) return "${bandwidth / 1000} kbps"
        return "auto"
    }

    fun parse(text: String, baseUrl: String): HlsMediaInfo {
        if (!looksLikeManifest(text)) return HlsMediaInfo(isMaster = false)

        val variants = mutableListOf<HlsVariant>()
        val audio = linkedSetOf<String>()
        val subtitles = linkedMapOf<String, SubtitleTrack>()

        text.replace("\r\n", "\n").replace('\r', '\n').split("\n").forEach { line ->
            val trimmed = line.trim()
            when {
                trimmed.startsWith("#EXT-X-STREAM-INF:", ignoreCase = true) -> {
                    val attrs = splitAttributes(trimmed.substringAfter(':'))
                    val bandwidth = attrs["BANDWIDTH"]?.toIntOrNull()
                        ?: attrs["AVERAGE-BANDWIDTH"]?.toIntOrNull()
                        ?: 0
                    val resolution = attrs["RESOLUTION"]
                    variants.add(HlsVariant(bandwidth, resolution, qualityLabel(resolution, bandwidth)))
                }

                trimmed.startsWith("#EXT-X-MEDIA:", ignoreCase = true) -> {
                    val attrs = splitAttributes(trimmed.substringAfter(':'))
                    val name = attrs["NAME"]?.takeIf { it.isNotBlank() }
                        ?: attrs["LANGUAGE"]?.takeIf { it.isNotBlank() }
                    when (attrs["TYPE"]?.uppercase()) {
                        "AUDIO" -> name?.let { audio.add(it) }
                        "SUBTITLES", "CLOSED-CAPTIONS" -> {
                            val uri = attrs["URI"]?.takeIf { it.isNotBlank() } ?: return@forEach
                            val resolved = runCatching { URL(URL(baseUrl), uri).toString() }.getOrNull()
                                ?: return@forEach
                            subtitles.putIfAbsent(resolved, SubtitleTrack(resolved, name ?: "Legenda"))
                        }
                    }
                }
            }
        }

        return HlsMediaInfo(
            isMaster = variants.isNotEmpty(),
            variants = variants.distinctBy { it.label }.sortedByDescending { it.bandwidth },
            audioTracks = audio.toList(),
            subtitles = subtitles.values.toList(),
        )
    }
}
