package com.obaflix.tv.sessao

import android.os.Build
import com.obaflix.ObaflixApp
import com.obaflix.tv.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

/**
 * Estado da sessao da TV.
 *
 * O access token vive **so em memoria**: dura 15 minutos e a TV consegue outro
 * com o refresh a qualquer momento, entao grava-lo em disco so aumentaria a
 * superficie sem economizar nada. Quem persiste e o refresh, cifrado, em
 * ArmazenamentoSessao.
 */
sealed interface EstadoSessao {
    /** Sem credencial. A TV precisa parear. */
    data class NaoPareado(val httpStatus: Int) : EstadoSessao

    /** Sessao valida. */
    data class Autenticado(val dispositivo: String?) : EstadoSessao

    /** Nao deu para falar com o servidor — nao confundir com nao autenticado. */
    data class SemContato(val motivo: String) : EstadoSessao
}

object SessaoTv {

    @Volatile
    private var access: String? = null

    fun accessToken(): String? = access

    /**
     * User-Agent que a extracao usou.
     *
     * O player tem de repetir exatamente o par User-Agent/Referer da extracao:
     * varios CDN amarram o link ao par, e um deles diferente vira 403 no meio
     * da reproducao — sem erro visivel, so o video que nao abre.
     */
    val uaNavegador: String? get() = com.obaflix.ObaflixApp.webViewUserAgent

    fun definirAccessToken(valor: String?) {
        access = valor
    }

    /**
     * User-Agent da TV.
     *
     * O marcador `ObaflixTV/` e o que faz o proxy da Vercel entregar os
     * segmentos de midia direto do CDN em vez de passar por ele. Sem isso, cada
     * episodio consumiria Transfer Out — ver shouldProxyMediaThroughApp no
     * servidor. E deliberadamente distinto de `ObaflixApp/` (movel) para que os
     * dois ambientes sejam separaveis no log.
     */
    val userAgent: String =
        "ObaflixTV/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; ${Build.MODEL})"

    /**
     * Conta em que este aparelho esta, mascarada ("mic***@gmail.com").
     *
     * So a tela de perfil chama, e so ela passa `?conta=1` — a verificacao de
     * abertura continua sem consultar o banco. Existe porque, quando a TV e o
     * celular mostram Continuar Assistindo diferentes, a primeira coisa a
     * descartar e estarem em contas diferentes, e ate aqui nao havia como olhar.
     */
    suspend fun conta(): String? = withContext(Dispatchers.IO) {
        val token = access ?: return@withContext null
        val requisicao = Request.Builder()
            .url("${BuildConfig.OBAFLIX_URL}/api/tv/whoami?conta=1")
            .header("User-Agent", userAgent)
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        runCatching {
            ObaflixApp.httpClient.newCall(requisicao).execute().use { r ->
                if (r.code != 200) return@use null
                Regex("\"conta\":\"([^\"]+)\"")
                    .find(r.body?.string().orEmpty())?.groupValues?.getOrNull(1)
            }
        }.getOrNull()
    }

    suspend fun verificar(): EstadoSessao = withContext(Dispatchers.IO) {
        val token = access
        val requisicao = Request.Builder()
            .url("${BuildConfig.OBAFLIX_URL}/api/tv/whoami")
            .header("User-Agent", userAgent)
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .get()
            .build()

        runCatching {
            // httpClient vem do :core-extractor — mesmo pool de conexoes que a
            // extracao usa, sem um segundo cliente HTTP no aplicativo.
            ObaflixApp.httpClient.newCall(requisicao).execute().use { resposta ->
                if (resposta.code == 200) {
                    val corpo = resposta.body?.string().orEmpty()
                    val dispositivo = Regex("\"dispositivo\":\"([^\"]+)\"")
                        .find(corpo)?.groupValues?.getOrNull(1)
                    EstadoSessao.Autenticado(dispositivo)
                } else {
                    EstadoSessao.NaoPareado(resposta.code)
                }
            }
        }.getOrElse { erro ->
            EstadoSessao.SemContato(erro.javaClass.simpleName)
        }
    }
}
