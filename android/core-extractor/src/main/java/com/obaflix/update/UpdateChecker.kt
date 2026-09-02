package com.obaflix.update

import com.obaflix.ObaflixApp
import com.obaflix.bridge.NetworkDiagnostics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.CacheControl
import okhttp3.Request

/**
 * Por que a plataforma pedida nao tem uma versao nova para oferecer, ou por
 * que nao foi possivel nem saber.
 */
sealed interface ResultadoVerificacao {
    /** Sem internet, DNS falhou, timeout — a causa vem de [NetworkDiagnostics]. */
    data class SemConexao(val causa: String) : ResultadoVerificacao

    /** A resposta chegou, mas o corpo nao e um manifesto que da para confiar. */
    data class ManifestoInvalido(val causa: String) : ResultadoVerificacao

    /** Manifesto valido, mas sem entrada (ou com entrada malformada) para esta plataforma. */
    data class PlataformaAusente(val plataforma: String) : ResultadoVerificacao

    /** `versionCode` publicado e menor ou igual ao instalado. Nunca sugere downgrade. */
    object JaAtualizado : ResultadoVerificacao

    data class NovaVersao(val info: PlatformUpdate) : ResultadoVerificacao
}

/**
 * Consulta o manifesto central de atualizacao e decide se ha algo novo para
 * esta instalacao.
 *
 * A comparacao e sempre por `versionCode` — nunca pelo nome do arquivo ou da
 * versao textual, que nao tem ordem confiavel (`"1.10.0"` vs `"1.9.0"` como
 * string compara errado).
 */
object UpdateChecker {

    suspend fun verificar(
        manifestUrl: String,
        plataforma: Plataforma,
        versionCodeAtual: Int,
    ): ResultadoVerificacao = withContext(Dispatchers.IO) {
        val requisicao = Request.Builder()
            .url(manifestUrl)
            // O manifesto muda a cada release; uma resposta do cache do OkHttp
            // aqui faria a checagem sempre "ver" a versao de quando o cache
            // foi preenchido, nunca a atual.
            .cacheControl(CacheControl.Builder().noCache().noStore().build())
            .header("Accept", "application/json")
            .get()
            .build()

        val corpo = try {
            ObaflixApp.httpClient.newCall(requisicao).execute().use { resposta ->
                if (!resposta.isSuccessful) {
                    return@withContext ResultadoVerificacao.SemConexao("HTTP ${resposta.code}")
                }
                resposta.body?.string()
            }
        } catch (e: Exception) {
            return@withContext ResultadoVerificacao.SemConexao(NetworkDiagnostics.describe(e, manifestUrl))
        }

        if (corpo.isNullOrBlank()) {
            return@withContext ResultadoVerificacao.ManifestoInvalido("corpo vazio")
        }

        val manifesto = try {
            UpdateManifestParser.parse(corpo)
        } catch (e: Exception) {
            return@withContext ResultadoVerificacao.ManifestoInvalido(e.message ?: "JSON invalido")
        }

        decidir(manifesto, plataforma, versionCodeAtual)
    }

    /**
     * A parte pura da decisao — sem rede, testavel isolada. Separada de
     * [verificar] so por isso.
     */
    internal fun decidir(
        manifesto: UpdateManifest,
        plataforma: Plataforma,
        versionCodeAtual: Int,
    ): ResultadoVerificacao {
        val entrada = when (plataforma) {
            Plataforma.ANDROID -> manifesto.android
            Plataforma.ANDROID_TV -> manifesto.androidTv
        } ?: return ResultadoVerificacao.PlataformaAusente(plataforma.chave)

        return if (entrada.versionCode <= versionCodeAtual) {
            ResultadoVerificacao.JaAtualizado
        } else {
            ResultadoVerificacao.NovaVersao(entrada)
        }
    }
}
