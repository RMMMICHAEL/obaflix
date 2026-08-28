package com.obaflix.tv.player

import com.obaflix.ObaflixApp
import com.obaflix.bridge.ExtractResult
import com.obaflix.bridge.ObaLog
import com.obaflix.bridge.StreamExtractor
import com.obaflix.tv.BuildConfig
import com.obaflix.tv.sessao.SessaoTv
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Fontes de reprodução, do lado da TV.
 *
 * Nada aqui inventa extração: usa o mesmo caminho que o aplicativo móvel já usa
 * e que o servidor já protege.
 *
 *   1. `/api/player/fontes` devolve **ids opacos** e rótulos genéricos
 *      ("Servidor 1"). O domínio real do provedor não chega à televisão nessa
 *      etapa, e é o que o usuário vê na tela.
 *   2. `/api/player/fonte-nativa` entrega a URL real de UMA fonte por vez, só
 *      quando ela vai ser de fato usada.
 *   3. `StreamExtractor`, do :core-extractor, extrai no próprio aparelho — com
 *      o IP residencial, que é o que o CDN aceita.
 *
 * O último passo é o que mantém a mídia indo direto do CDN para a TV, sem
 * passar pela Vercel. Um episódio em 1080p passa de 1 GB; proxiar isso seria
 * pagar Transfer Out por cada pessoa assistindo.
 */
object FontesTv {

    private val JSON = "application/json; charset=utf-8".toMediaType()

    /** O que a televisão sabe de uma fonte. Nunca o provedor real. */
    data class Fonte(
        val id: String,
        val rotulo: String,
        val idioma: String?,
        val disponivel: Boolean,
        val nativo: Boolean,
        val iframeDireto: Boolean,
        val iframeDesafio: Boolean,
    ) {
        /** Só estas a TV consegue resolver sozinha. */
        val resolvivel: Boolean get() = disponivel && (nativo || iframeDireto || iframeDesafio)
    }

    data class SessaoFontes(val sessao: String, val fontes: List<Fonte>)

    private fun post(caminho: String, corpo: JSONObject): Request =
        Request.Builder()
            .url("${BuildConfig.OBAFLIX_URL}$caminho")
            .header("User-Agent", SessaoTv.userAgent)
            .apply { SessaoTv.accessToken()?.let { header("Authorization", "Bearer $it") } }
            .post(corpo.toString().toRequestBody(JSON))
            .build()

    /** Abre a sessão de fontes para um título ou episódio. */
    suspend fun abrir(
        conteudoId: String,
        conteudoTipo: String,
        temporada: Int?,
        numeroEp: Int?,
    ): SessaoFontes? = withContext(Dispatchers.IO) {
        val corpo = JSONObject()
            .put("conteudoId", conteudoId)
            // O servidor só distingue filme de série; anime e desenho são séries.
            .put("conteudoTipo", if (conteudoTipo == "filme") "filme" else "serie")
            .put("ambiente", "android")
            .apply {
                if (temporada != null) put("temporada", temporada)
                if (numeroEp != null) put("numeroEp", numeroEp)
            }

        runCatching {
            ObaflixApp.httpClient.newCall(post("/api/player/fontes", corpo)).execute().use { r ->
                if (!r.isSuccessful) return@use null
                val o = JSONObject(r.body?.string().orEmpty())
                val arr = o.optJSONArray("fontes") ?: return@use null
                val fontes = (0 until arr.length()).mapNotNull { i ->
                    arr.optJSONObject(i)?.let { f ->
                        Fonte(
                            id = f.optString("id"),
                            rotulo = f.optString("rotulo").ifBlank { "Servidor ${i + 1}" },
                            idioma = f.optString("idioma").takeIf { it.isNotBlank() && it != "null" },
                            disponivel = f.optBoolean("disponivel", true),
                            nativo = f.optBoolean("nativo"),
                            iframeDireto = f.optBoolean("iframeDireto"),
                            iframeDesafio = f.optBoolean("iframeDesafio"),
                        )
                    }
                }
                SessaoFontes(o.optString("sessao"), fontes)
            }
        }.onFailure {
            ObaLog.alerta(ObaLog.Fase.PLAYER, "fontes_falhou", "erro" to it.javaClass.simpleName)
        }.getOrNull()
    }

    /**
     * Resolve uma fonte até o stream tocável.
     *
     * A URL real vive apenas dentro desta função e do extractor. Não vai para
     * estado da interface, não vai para log e não é desenhada em lugar nenhum —
     * o que a tela mostra é sempre o rótulo genérico.
     */
    suspend fun resolver(sessao: String, fonteId: String): ExtractResult? = withContext(Dispatchers.IO) {
        val embedUrl = runCatching {
            val corpo = JSONObject().put("sessao", sessao).put("fonteId", fonteId)
            ObaflixApp.httpClient.newCall(post("/api/player/fonte-nativa", corpo)).execute().use { r ->
                if (!r.isSuccessful) return@use null
                JSONObject(r.body?.string().orEmpty()).optString("embedUrl").takeIf { it.isNotBlank() }
            }
        }.getOrNull() ?: return@withContext null

        runCatching { StreamExtractor.extract(embedUrl) }
            .onFailure {
                // ObaLog.url() trunca; o domínio do provedor não vaza no log.
                ObaLog.alerta(ObaLog.Fase.PLAYER, "extracao_falhou", "erro" to it.javaClass.simpleName)
            }
            .getOrNull()
    }

    /** Grava a posição. Sem sessão válida a chamada é ignorada em silêncio. */
    suspend fun salvarProgresso(
        conteudoId: String,
        conteudoTipo: String,
        episodioId: String?,
        temporada: Int?,
        numeroEp: Int?,
        progressoSeg: Int,
        duracaoSeg: Int?,
    ) = withContext(Dispatchers.IO) {
        if (SessaoTv.accessToken() == null) return@withContext
        val corpo = JSONObject()
            .put("conteudoId", conteudoId)
            .put("conteudoTipo", if (conteudoTipo == "filme") "filme" else "serie")
            .put("progressoSeg", progressoSeg)
            .apply {
                if (duracaoSeg != null && duracaoSeg > 0) put("duracaoSeg", duracaoSeg)
                if (episodioId != null) put("episodioId", episodioId)
                if (temporada != null) put("temporada", temporada)
                if (numeroEp != null) put("numeroEp", numeroEp)
            }
        runCatching {
            ObaflixApp.httpClient.newCall(post("/api/progress", corpo)).execute().close()
        }
    }

    /** Posição salva, para retomar de onde parou. */
    suspend fun progressoSalvo(conteudoId: String, episodioId: String?): Int = withContext(Dispatchers.IO) {
        if (SessaoTv.accessToken() == null) return@withContext 0
        val url = StringBuilder("${BuildConfig.OBAFLIX_URL}/api/progress?conteudoId=$conteudoId")
        if (episodioId != null) url.append("&episodioId=").append(episodioId)
        runCatching {
            val req = Request.Builder()
                .url(url.toString())
                .header("User-Agent", SessaoTv.userAgent)
                .apply { SessaoTv.accessToken()?.let { header("Authorization", "Bearer $it") } }
                .get().build()
            ObaflixApp.httpClient.newCall(req).execute().use { r ->
                if (!r.isSuccessful) 0
                else JSONObject(r.body?.string().orEmpty()).optInt("progressoSeg", 0)
            }
        }.getOrDefault(0)
    }
}
