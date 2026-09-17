package com.obaflix

import android.app.Activity
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.obaflix.bridge.ObaLog
import com.obaflix.cast.CastElegibilidade
import com.obaflix.cast.CastSourceResolver
import com.obaflix.cast.WebVideoCast
import com.obaflix.download.DownloadElegibilidade
import com.obaflix.download.DownloadException
import com.obaflix.download.DownloadFolder
import com.obaflix.download.DownloadRecord
import com.obaflix.download.DownloadService
import com.obaflix.download.DownloadSource
import com.obaflix.download.DownloadSourceResolver
import com.obaflix.download.DownloadStore
import com.obaflix.download.MediaDownloader
import com.obaflix.download.PrefsKeyValueStore
import com.obaflix.download.QualidadeDownload
import com.obaflix.download.SondagemDeFonte
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

/** O que a Activity precisa saber fazer para esta ponte funcionar. */
interface AcoesDeMidiaHost {
    /** Abre o seletor nativo de diretorio. O resultado volta por [MediaActionsBridge.pastaEscolhida]. */
    fun pedirPastaDeDownload()

    /** Pede POST_NOTIFICATIONS quando a versao do Android exige. Sem bloquear nada. */
    fun garantirPermissaoDeNotificacao()
}

/**
 * Exposta ao JavaScript como `window._obaflixMedia`.
 *
 * ## Por que uma segunda interface, e nao metodos novos no ObaflixBridge
 *
 * O `ObaflixBridge` vive no `:core-extractor`, que o `:tv` tambem consome.
 * Metodos de download e transmissao ali apareceriam na TV — onde nao ha SAF
 * util, nao ha Web Video Cast e nada disso foi pedido nesta rodada. Registrando
 * esta interface so na `MainActivity` do modulo `:app`, a TV continua sem
 * qualquer superficie nova: nao e uma flag desligada, o codigo nao existe la.
 *
 * ## O que ela nao faz
 *
 * Nao resolve midia. Todo metodo recebe o payload que
 * `window.obaflixDesktop.extractStream` / `resolveSuperflix` **ja** devolveram
 * para a reproducao. Ver o KDoc de [DownloadSourceResolver].
 */
class MediaActionsBridge(
    private val activity: Activity,
    private val host: AcoesDeMidiaHost,
    private val webView: WebView,
    private val capability: String,
    /**
     * Escopo da Activity: a sondagem do master e rede, e morre junto com a tela.
     * Um download ja enfileirado nao depende disto — quem o executa e o
     * [DownloadService], com escopo proprio.
     */
    private val escopo: CoroutineScope,
    /**
     * A origem https de um endereco do proxy local (`LocalMediaServer`), ou
     * `null` quando a URL nao e dele. Ver [paraTransmissao].
     */
    private val origemDoProxyLocal: (String) -> LocalMediaServer.Origem? = { null },
) {

    private val store = DownloadStore(PrefsKeyValueStore(activity.applicationContext))
    private val downloader = MediaDownloader(activity.contentResolver)

    /** Pedido que espera a escolha da pasta. Um de cada vez, o ultimo vence. */
    private var pendente: Pendente? = null

    private data class Pendente(val callbackId: String, val registro: DownloadRecord)

    /**
     * A fonte sondada esperando a escolha no modal. Ver [SondagemDeFonte] —
     * o prazo, o casamento de id e o descarte vivem la, testaveis sem Android.
     */
    private val sondagem = SondagemDeFonte()

    private fun autorizado(valor: String) = valor == capability
    private fun idValido(valor: String) =
        valor.length in 1..128 && valor.all { it.isLetterOrDigit() || it == '_' || it == '-' }

    // -- Pasta ----------------------------------------------------------------

    @JavascriptInterface
    fun temPasta(capability: String): Boolean {
        if (!autorizado(capability)) return false
        return DownloadFolder.temPastaValida(activity)
    }

    @JavascriptInterface
    fun escolherPasta(capability: String) {
        if (!autorizado(capability)) return
        activity.runOnUiThread { host.pedirPastaDeDownload() }
    }

    /**
     * Chamado pela Activity quando o seletor nativo volta.
     *
     * O caminho feliz do enunciado termina aqui: a pessoa escolheu a pasta, o
     * Android devolveu o foco ao app, e o download que estava esperando comeca
     * sozinho — sem ela precisar tocar "Baixar" de novo.
     */
    fun pastaEscolhida(sucesso: Boolean) {
        val esperando = pendente ?: return
        pendente = null
        if (!sucesso) {
            responder(esperando.callbackId, recusa("sem_pasta"))
            return
        }
        iniciar(esperando.registro, esperando.callbackId, pastaAcabouDeSerEscolhida = true)
    }

    // -- Download -------------------------------------------------------------

    /**
     * Primeira metade do fluxo: a fonte serve? E com quais qualidades?
     *
     * Existe separada de [solicitarDownload] porque o modal de qualidade fica
     * entre as duas. Sondar antes de abrir o modal tem uma consequencia boa: o
     * modal so aparece para uma fonte que **de fato** da para baixar. Uma fonte
     * presa a sessao do navegador e recusada aqui, e o lado web tenta a proxima
     * sem nunca ter mostrado uma tela de escolha que ia falhar no fim.
     *
     * @param payloadJson resolucao ja autorizada + `pid` e `titulo`.
     */
    @JavascriptInterface
    fun inspecionarFonte(capability: String, callbackId: String, payloadJson: String) {
        if (!autorizado(capability) || !idValido(callbackId) || payloadJson.length > 65536) return

        val payload = runCatching { JSONObject(payloadJson) }.getOrNull()
        if (payload == null) {
            responder(callbackId, recusa("payload_invalido"))
            return
        }
        val pid = payload.optString("pid").take(200).ifBlank { null }
        val titulo = payload.optString("titulo").take(300).ifBlank { "Video" }
        if (pid == null) {
            responder(callbackId, recusa("payload_invalido"))
            return
        }

        ObaLog.evento("download", "download_request", "pid" to pid)

        // Ja esta na fila: nao sonda de novo nem abre modal. Dois toques no
        // mesmo episodio nao podem virar dois downloads.
        store.ativoPorPid(pid)?.let { jaExiste ->
            responder(
                callbackId,
                JSONObject().put("ok", true).put("jaNaFila", true).put("id", jaExiste.id),
            )
            return
        }

        when (val elegibilidade = DownloadSourceResolver.paraDownload(payload)) {
            is DownloadElegibilidade.Inelegivel -> {
                ObaLog.alerta(
                    "download", "download_failed",
                    "pid" to pid,
                    "motivo" to elegibilidade.motivo.name.lowercase(),
                )
                // Sinal para o lado web oferecer a proxima fonte da lista. Nao
                // ha nova tentativa aqui: a lista e a sessao autenticada vivem la.
                responder(callbackId, recusa(elegibilidade.motivo.name.lowercase()).put("tentarOutraFonte", true))
            }

            is DownloadElegibilidade.Elegivel -> {
                val fonte = elegibilidade.source
                escopo.launch {
                    try {
                        val qualidades = downloader.sondarQualidades(fonte)
                        val id = sondagem.guardar(fonte, qualidades, pid, titulo)

                        ObaLog.evento(
                            "download", "download_source_ready",
                            "pid" to pid,
                            "kind" to fonte.kind.name.lowercase(),
                            "qualidades" to qualidades.size,
                            "host" to ObaLog.host(fonte.url),
                        )
                        responder(
                            callbackId,
                            JSONObject()
                                .put("ok", true)
                                .put("sondagemId", id)
                                .put("qualidades", QualidadeDownload.listaParaJson(qualidades)),
                        )
                    } catch (e: DownloadException) {
                        ObaLog.alerta(
                            "download", "download_failed",
                            "pid" to pid,
                            "motivo" to e.motivo.name.lowercase(),
                        )
                        responder(callbackId, recusa(e.motivo.name.lowercase()).put("tentarOutraFonte", true))
                    } catch (e: Exception) {
                        ObaLog.alerta("download", "download_failed", "pid" to pid, "motivo" to "sondagem")
                        responder(callbackId, recusa("sondagem_falhou").put("tentarOutraFonte", true))
                    }
                }
            }
        }
    }

    /**
     * Segunda metade: o usuario escolheu a qualidade.
     *
     * Nao reclassifica nem re-resolve nada — usa a sondagem que [inspecionarFonte]
     * ja pagou. A URL que vai para o downloader e a **da variante escolhida**,
     * nao a do master, e e por isso que a escolha nao pode ser desfeita depois.
     *
     * @param payloadJson `{ sondagemId, qualidadeId }`.
     */
    @JavascriptInterface
    fun solicitarDownload(capability: String, callbackId: String, payloadJson: String) {
        if (!autorizado(capability) || !idValido(callbackId) || payloadJson.length > 65536) return

        val payload = runCatching { JSONObject(payloadJson) }.getOrNull()
        if (payload == null) {
            responder(callbackId, recusa("payload_invalido"))
            return
        }

        val resgate = sondagem.resgatar(
            payload.optString("sondagemId"),
            payload.optString("qualidadeId"),
        )
        val ok = when (resgate) {
            is SondagemDeFonte.Resgate.Ok -> resgate
            SondagemDeFonte.Resgate.NaoEncontrada,
            SondagemDeFonte.Resgate.Expirada -> {
                responder(callbackId, recusa("sondagem_expirada"))
                return
            }
            SondagemDeFonte.Resgate.QualidadeInvalida -> {
                responder(callbackId, recusa("qualidade_invalida"))
                return
            }
        }

        val registro = DownloadRecord(
            id = store.novoId(),
            pid = ok.pid,
            titulo = ok.titulo,
            kind = ok.source.kind,
            // A variante escolhida ja resolvida; sem ela, a fonte original.
            url = ok.qualidade.uri ?: ok.source.url,
            referer = ok.source.referer,
            userAgent = ok.source.userAgent,
            qualidadeId = ok.qualidade.id,
            qualidadeLabel = ok.qualidade.label,
        )

        if (!DownloadFolder.temPastaValida(activity)) {
            // Guarda o pedido e abre o seletor. A continuacao acontece em
            // pastaEscolhida(); a Promise do JS segue pendente ate la.
            pendente = Pendente(callbackId, registro)
            activity.runOnUiThread { host.pedirPastaDeDownload() }
            return
        }
        iniciar(registro, callbackId, pastaAcabouDeSerEscolhida = false)
    }

    /**
     * O usuario fechou o modal sem escolher.
     *
     * Solta a URL assinada da memoria na hora, em vez de esperar a validade
     * expirar. Nenhum download e criado — fechar o modal nao baixa nada.
     */
    @JavascriptInterface
    fun descartarSondagem(capability: String) {
        if (!autorizado(capability)) return
        sondagem.descartar()
    }

    private fun iniciar(registro: DownloadRecord, callbackId: String, pastaAcabouDeSerEscolhida: Boolean) {
        if (!DownloadFolder.temPastaValida(activity)) {
            responder(callbackId, recusa("pasta_invalida"))
            return
        }
        store.salvar(registro)
        activity.runOnUiThread {
            host.garantirPermissaoDeNotificacao()
            DownloadService.enfileirar(activity.applicationContext, registro.id)
        }
        responder(
            callbackId,
            JSONObject()
                .put("ok", true)
                .put("id", registro.id)
                .put("pastaEscolhidaAgora", pastaAcabouDeSerEscolhida),
        )
    }

    @JavascriptInterface
    fun cancelarDownload(capability: String, id: Int) {
        if (!autorizado(capability) || id <= 0) return
        DownloadService.cancelar(activity.applicationContext, id)
    }

    /** A lista como a tela a desenha — sem nenhuma URL autorizada. */
    @JavascriptInterface
    fun listarDownloads(capability: String): String {
        if (!autorizado(capability)) return "{\"downloads\":[]}"
        return store.paraJsonPublico()
    }

    // -- Cast -----------------------------------------------------------------

    @JavascriptInterface
    fun solicitarCast(capability: String, callbackId: String, payloadJson: String) {
        if (!autorizado(capability) || !idValido(callbackId) || payloadJson.length > 65536) return

        val payload = runCatching { JSONObject(payloadJson) }.getOrNull()
        if (payload == null) {
            responder(callbackId, recusa("payload_invalido"))
            return
        }
        val titulo = payload.optString("titulo").take(300).ifBlank { "Video" }
        val poster = payload.optString("poster").ifBlank { null }
        val pid = payload.optString("pid").take(200).ifBlank { "-" }

        ObaLog.evento("cast", "cast_request", "pid" to pid)

        // O app externo faltando e verificado antes da fonte: nao ha motivo para
        // aprovar uma midia para entrega a um destino que nao existe.
        if (!WebVideoCast.instalado(activity)) {
            ObaLog.evento("cast", "cast_unavailable", "motivo" to "app_ausente")
            responder(callbackId, recusa("app_ausente").put("podeInstalar", true))
            return
        }

        when (val elegibilidade = CastSourceResolver.classificar(paraTransmissao(payload, origemDoProxyLocal), titulo, poster)) {
            is CastElegibilidade.Inelegivel -> {
                ObaLog.evento("cast", "cast_unavailable", "motivo" to elegibilidade.motivo.name.lowercase())
                responder(callbackId, recusa(elegibilidade.motivo.name.lowercase()).put("tentarOutraFonte", true))
            }

            is CastElegibilidade.Elegivel -> {
                val fonte = elegibilidade.source
                ObaLog.evento(
                    "cast", "cast_source_ready",
                    "pid" to pid,
                    "kind" to fonte.kind.name.lowercase(),
                    "host" to ObaLog.host(fonte.url),
                )
                activity.runOnUiThread {
                    val aberto = runCatching {
                        activity.startActivity(WebVideoCast.intent(fonte))
                        true
                    }.getOrDefault(false)

                    if (aberto) {
                        ObaLog.evento("cast", "cast_external_open", "pacote" to WebVideoCast.PACOTE)
                        responder(callbackId, JSONObject().put("ok", true))
                    } else {
                        ObaLog.evento("cast", "cast_unavailable", "motivo" to "falha_ao_abrir")
                        responder(callbackId, recusa("falha_ao_abrir"))
                    }
                }
            }
        }
    }

    @JavascriptInterface
    fun instalarAppDeCast(capability: String) {
        if (!autorizado(capability)) return
        activity.runOnUiThread { WebVideoCast.abrirNaLoja(activity) }
    }

    // -- Resposta ao JS -------------------------------------------------------

    private fun recusa(motivo: String) = JSONObject().put("ok", false).put("motivo", motivo)

    internal companion object {
        /**
         * O payload de transmissao com a midia de origem no lugar do loopback.
         *
         * Dentro do player, episodio Playerflix toca pelo proxy local, e o
         * "Transmitir" entregava `http://127.0.0.1/...` ao classificador — recusado
         * como `nao_https`, que a tela mostrava como "Nao foi possivel concluir".
         * Pela ficha o mesmo conteudo ja chega com a URL https, e por isso la
         * funcionava. Aqui os dois caminhos passam a entregar a mesma coisa.
         *
         * O resto do payload (origem, tipo, validade) nao muda, e a classificacao
         * continua inteira em [CastSourceResolver]. URL que nao e do proxy passa
         * intacta.
         */
        fun paraTransmissao(
            payload: JSONObject,
            origemDoProxyLocal: (String) -> LocalMediaServer.Origem?,
        ): JSONObject {
            val origem = origemDoProxyLocal(payload.optString("stream")) ?: return payload
            return JSONObject(payload.toString()).apply {
                put("stream", origem.url)
                if (origem.referer != null) put("referer", origem.referer) else remove("referer")
                if (origem.userAgent != null) put("userAgent", origem.userAgent) else remove("userAgent")
            }
        }

        /**
         * Expressao JavaScript que devolve o objeto de um JSON em base64 UTF-8.
         *
         * `atob` sozinho devolve um byte por caractere (Latin-1): "Padrão", que
         * em UTF-8 sao dois bytes no "ã", chegava a tela como "PadrÃ£o". Os bytes
         * voltam a ser UTF-8 pelo `TextDecoder` antes do `JSON.parse`.
         */
        fun jsonDeBase64Utf8(b64: String): String =
            "JSON.parse(new TextDecoder('utf-8').decode(" +
                "Uint8Array.from(atob('$b64'), function(c) { return c.charCodeAt(0); })))"
    }

    /**
     * Resolve a Promise do lado JS.
     *
     * Base64 pelo mesmo motivo do `ObaflixBridge`: o JSON entra num literal de
     * string JavaScript, e aspas ou barra invertida no titulo do episodio
     * quebrariam o script — ou pior, o fechariam.
     */
    private fun responder(callbackId: String, json: JSONObject) {
        val b64 = Base64.encodeToString(json.toString().toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        webView.post {
            webView.evaluateJavascript(
                """
                (function() {
                    var cb = (window._obaflixCallbacks || {})['$callbackId'];
                    if (!cb) return;
                    delete window._obaflixCallbacks['$callbackId'];
                    try { cb.resolve(${jsonDeBase64Utf8(b64)}); } catch (e) { cb.reject(e); }
                })()
                """.trimIndent(),
                null,
            )
        }
    }

    /** Progresso vindo do servico: entrega ao JS, se a pagina tiver ouvinte. */
    fun notificarProgresso(registro: DownloadRecord) {
        val b64 = Base64.encodeToString(
            registro.paraJsonPublico().toString().toByteArray(Charsets.UTF_8),
            Base64.NO_WRAP,
        )
        webView.post {
            webView.evaluateJavascript(
                """
                (function() {
                    if (typeof window.__obaflixDownloadProgress !== 'function') return;
                    try { window.__obaflixDownloadProgress(${jsonDeBase64Utf8(b64)}); } catch (e) {}
                })()
                """.trimIndent(),
                null,
            )
        }
    }
}
