package com.obaflix.bridge

import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Exposta ao JavaScript como window._obaflixBridge.
 *
 * O CustomPlayer.tsx usa window.obaflixDesktop.
 * O shim JS injetado em onPageFinished cria esse objeto
 * e converte callbacks em Promises.
 *
 * Equivalente ao preload.js + ipcMain do Electron.
 */
class ObaflixBridge(
    private val webView: WebView,
    private val scope: CoroutineScope,
    private val capability: String,
) {

    // Extração em andamento. Trocar de episódio rápido deixava a cadeia anterior
    // rodando: ela continuava competindo pela mesma sessão do provedor e podia
    // resolver depois da nova, sobrescrevendo o stream correto.
    private var activeExtraction: Job? = null
    private val superflixSessions = ConcurrentHashMap<String, SuperflixExtractor.Session>()

    private fun authorized(value: String): Boolean = value == capability
    private fun validCallbackId(value: String): Boolean =
        value.length in 1..128 && value.all { it.isLetterOrDigit() || it == '_' || it == '-' }

    private companion object {
        /** Eventos do JS que significam "a reproducao parou aqui". */
        val FALHAS_JS = setOf("video_erro", "travado", "erro_js", "promise_rejeitada")
    }

    /**
     * Exibe um Toast nativo com erros enviados pelo JavaScript.
     */
    @JavascriptInterface
    fun logError(capability: String, msg: String) {
        if (!authorized(capability)) return
        ObaLog.alerta(ObaLog.Fase.PLAYER, "erro_reportado", "msg" to msg.take(200))

        webView.post {
            Toast.makeText(
                webView.context,
                msg.take(300),
                Toast.LENGTH_LONG
            ).show()
        }
    }

    /**
     * Entrada da sonda de diagnostico injetada no documento (ver
     * PlayerWebViewClient.fetchDocumentWithoutCsp).
     *
     * O lado JS e quem enxerga o que de fato quebrou a reproducao — MediaError do
     * <video>, erro fatal do hls.js, travamento com buffer parado. Nada disso
     * aparece no logcat sozinho. Aqui esses eventos entram na MESMA trilha das
     * fases nativas, entao o log final mostra "extraiu -> baixou manifesto ->
     * segmento 403 -> video_erro DECODIFICACAO" em sequencia, com os tempos.
     *
     * `dadosJson` chega como texto: e apenas registrado, nunca avaliado.
     */
    @JavascriptInterface
    fun logDiag(capability: String, fase: String, evento: String, dadosJson: String) {
        if (!authorized(capability)) return
        // Nomes vem do proprio app, mas o valor entra numa linha de log
        // estruturada — limitar o tamanho evita que uma string enorme empurre
        // as linhas anteriores para fora do buffer da trilha.
        val faseSegura = fase.take(24).ifBlank { "player" }
        val eventoSeguro = evento.take(40).ifBlank { "sem_nome" }

        val campos = runCatching {
            val json = JSONObject(dadosJson)
            json.keys().asSequence().take(12)
                .map { chave -> chave.take(24) to (json.opt(chave)?.toString()?.take(160)) }
                .toList()
        }.getOrElse { listOf("dados" to dadosJson.take(200)) }

        // Erro fatal do JS entra como falha (imprime a trilha inteira); o resto e
        // progresso normal e nao deve poluir a saida.
        val fatal = eventoSeguro in FALHAS_JS ||
            (eventoSeguro == "hls_erro" && dadosJson.contains("\"fatal\":true"))

        if (fatal) {
            ObaLog.falha(faseSegura, "js_$eventoSeguro", null, *campos.toTypedArray())
        } else {
            ObaLog.evento(faseSegura, "js_$eventoSeguro", *campos.toTypedArray())
        }
    }

    /**
     * Mantém a tela do Android ligada enquanto o player
     * estiver aberto.
     *
     * Não exige permissão no AndroidManifest.
     */
    @JavascriptInterface
    fun setKeepScreenOn(capability: String, enabled: Boolean) {
        if (!authorized(capability)) return
        ObaLog.evento(ObaLog.Fase.PLAYER, "tela_ligada", "ativo" to enabled)

        webView.post {
            webView.keepScreenOn = enabled
        }
    }

    @JavascriptInterface
    fun extractStream(
        capability: String,
        callbackId: String,
        embedUrl: String
    ) {
        if (!authorized(capability) || !validCallbackId(callbackId) || embedUrl.length > 4096) return
        val provider = PlayerExtractors.detectProvider(embedUrl) ?: "desconhecido"

        // Cada chamada e uma tentativa de reproducao: abre trilha propria. Quando
        // o player pula de fonte, o log passa a mostrar duas trilhas distintas em
        // vez de linhas intercaladas de duas extracoes concorrentes.
        ObaLog.novaTrilha(
            "extractStream",
            "provedor" to provider,
            "embed" to ObaLog.url(embedUrl),
        )
        val comeco = System.currentTimeMillis()

        // A Promise da extração anterior fica sem resolver de propósito: rejeitá-la
        // faria o CustomPlayer entender que a fonte falhou e pular para a próxima.
        if (activeExtraction?.isActive == true) {
            ObaLog.alerta(ObaLog.Fase.BRIDGE, "extracao_anterior_cancelada")
        }
        activeExtraction?.cancel()
        activeExtraction = scope.launch {
            try {
                val result = if (provider == "redecanais") {
                    RedeCanaisExtractor.extract(webView, embedUrl)
                } else {
                    StreamExtractor.extract(embedUrl)
                }

                val json = JSONObject().apply {
                    put("stream", result.stream)
                    put(
                        "tipo",
                        result.tipo
                            ?: if (provider == "redecanais" || result.stream.contains(".mp4")) "mp4" else "hls",
                    )
                    if (result.referer != null) {
                        put("referer", result.referer)
                    } else {
                        put("referer", JSONObject.NULL)
                    }
                    put("subtitles", org.json.JSONArray().apply {
                        result.subtitles.forEachIndexed { index, track ->
                            put(JSONObject().apply {
                                put("file", track.file)
                                put("label", track.label)
                                put("kind", "captions")
                                put("default", index == 0)
                            })
                        }
                    })
                    // Metadados da fonte escolhida: o player usa para saber que o
                    // manifesto já traz qualidades/áudios e quando o token expira.
                    put("isMaster", result.isMaster)
                    put("qualities", org.json.JSONArray(result.qualities))
                    put("audioTracks", org.json.JSONArray(result.audioTracks))
                    put("expiresAt", result.expiresAt ?: JSONObject.NULL)
                }.toString()

                ObaLog.evento(
                    ObaLog.Fase.BRIDGE, "extracao_resolvida",
                    "provedor" to provider,
                    "tipo" to (result.tipo ?: "-"),
                    "master" to result.isMaster,
                    "qualidades" to result.qualities.size,
                    "audios" to result.audioTracks.size,
                    "legendas" to result.subtitles.size,
                    "stream" to ObaLog.url(result.stream),
                    "ms" to (System.currentTimeMillis() - comeco),
                )

                resolveCallback(callbackId, json)
            } catch (e: CancellationException) {
                ObaLog.evento(
                    ObaLog.Fase.BRIDGE, "extracao_cancelada",
                    "provedor" to provider,
                    "ms" to (System.currentTimeMillis() - comeco),
                )
                throw e
            } catch (e: Exception) {
                // describe() nomeia a fase (DNS/TCP/TLS/HTTP) e a causa. Sem isso
                // toda falha de rede chegava aqui como "Handshake failed", que nao
                // distingue provedor fora do ar de TLS incompativel com o aparelho.
                val detail = NetworkDiagnostics.describe(e, embedUrl)
                    .takeIf { it.isNotBlank() && it != "null" }
                    ?: "Falha nativa sem detalhes"
                ObaLog.falha(
                    ObaLog.Fase.BRIDGE, "extracao_falhou", e,
                    "provedor" to provider,
                    "diagnostico" to detail,
                    "ms" to (System.currentTimeMillis() - comeco),
                )

                val json = JSONObject()
                    .put(
                        "error",
                        "$provider: $detail"
                    )
                    .toString()

                resolveCallback(callbackId, json)
            }
        }
    }

    @JavascriptInterface
    fun prepareSuperflix(capability: String, callbackId: String, embedUrl: String) {
        if (!authorized(capability) || !validCallbackId(callbackId) || embedUrl.length > 4096 ||
            PlayerExtractors.detectProvider(embedUrl) != "superflix"
        ) return

        activeExtraction?.cancel()
        activeExtraction = scope.launch {
            try {
                val session = SuperflixExtractor.prepare(embedUrl)
                val sessionId = UUID.randomUUID().toString()
                superflixSessions[sessionId] = session
                val json = JSONObject().apply {
                    put("sessionId", sessionId)
                    put("expiresAt", session.expiresAt ?: JSONObject.NULL)
                    put("options", org.json.JSONArray().apply {
                        session.options.forEach { option ->
                            put(JSONObject().apply {
                                put("key", option.key)
                                put("label", option.label)
                                put("isFile", option.isFile)
                            })
                        }
                    })
                }
                resolveCallback(callbackId, json.toString())
            } catch (error: Exception) {
                resolveCallback(callbackId, JSONObject()
                    .put("error", error.message ?: "Falha ao preparar Superflix")
                    .toString())
            }
        }
    }

    @JavascriptInterface
    fun resolveSuperflix(
        capability: String,
        callbackId: String,
        sessionId: String,
        optionKey: String,
    ) {
        if (!authorized(capability) || !validCallbackId(callbackId) ||
            sessionId.length > 128 || optionKey.length > 128
        ) return
        val session = superflixSessions[sessionId]
        if (session == null) {
            resolveCallback(callbackId, JSONObject().put("error", "Sessão Superflix indisponível").toString())
            return
        }

        activeExtraction?.cancel()
        activeExtraction = scope.launch {
            try {
                val result = StreamExtractor.acceptNativeResult(session.resolve(optionKey))
                val json = JSONObject().apply {
                    put("stream", result.stream)
                    put("tipo", result.tipo ?: "hls")
                    put("referer", result.referer ?: JSONObject.NULL)
                    put("expiresAt", result.expiresAt ?: JSONObject.NULL)
                    put("subtitles", org.json.JSONArray().apply {
                        result.subtitles.forEach { track ->
                            put(JSONObject().put("file", track.file).put("label", track.label))
                        }
                    })
                    put("isMaster", result.isMaster)
                    put("qualities", org.json.JSONArray(result.qualities))
                    put("audioTracks", org.json.JSONArray(result.audioTracks))
                }
                resolveCallback(callbackId, json.toString())
            } catch (error: Exception) {
                resolveCallback(callbackId, JSONObject()
                    .put("error", error.message ?: "Servidor Superflix indisponível")
                    .toString())
            }
        }
    }

    private fun resolveCallback(
        id: String,
        json: String
    ) {
        // Base64 evita problemas com aspas, barras
        // e caracteres especiais no JavaScript.
        val b64 = Base64.encodeToString(
            json.toByteArray(Charsets.UTF_8),
            Base64.NO_WRAP
        )

        webView.post {
            webView.evaluateJavascript(
                """
                (function() {
                    var callbacks =
                        window._obaflixCallbacks || {};

                    var cb = callbacks['$id'];

                    if (cb) {
                        try {
                            cb.resolve(
                                JSON.parse(atob('$b64'))
                            );
                        } catch (e) {
                            cb.reject(e);
                        }
                    }
                })()
                """.trimIndent(),
                null
            )
        }
    }
}
