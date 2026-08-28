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
 * Na Fase 0 ainda nao existe pareamento, entao nao ha token guardado — e nao
 * guardar nada e justamente o que torna esta fase segura: nao ha segredo em
 * disco para vazar. O que esta rota prova e o outro lado: que o servidor
 * reconhece a TV e responde 401 corretamente a quem chega sem credencial.
 *
 * Quando o pareamento entrar (Fase 1), o refresh token vai para
 * EncryptedSharedPreferences com chave do Android Keystore, e o access token
 * fica so em memoria.
 */
sealed interface EstadoSessao {
    /** O servidor respondeu e recusou — caminho de autenticacao funcionando. */
    data class NaoPareado(val httpStatus: Int) : EstadoSessao

    /** Ha sessao valida. Só ocorre a partir da Fase 1. */
    data class Autenticado(val nome: String) : EstadoSessao

    /** Nao deu para falar com o servidor. */
    data class SemContato(val motivo: String) : EstadoSessao
}

object SessaoTv {

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

    suspend fun verificar(): EstadoSessao = withContext(Dispatchers.IO) {
        val requisicao = Request.Builder()
            .url("${BuildConfig.OBAFLIX_URL}/api/tv/whoami")
            .header("User-Agent", userAgent)
            .get()
            .build()

        runCatching {
            // httpClient vem do :core-extractor — mesmo pool de conexoes que a
            // extracao usa, sem um segundo cliente HTTP no aplicativo.
            ObaflixApp.httpClient.newCall(requisicao).execute().use { resposta ->
                when (resposta.code) {
                    200 -> EstadoSessao.Autenticado(resposta.body?.string()?.take(120) ?: "")
                    else -> EstadoSessao.NaoPareado(resposta.code)
                }
            }
        }.getOrElse { erro ->
            EstadoSessao.SemContato(erro.javaClass.simpleName)
        }
    }
}
