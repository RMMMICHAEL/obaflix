package com.obaflix.tv.sessao

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings
import com.obaflix.ObaflixApp
import com.obaflix.bridge.ObaLog
import com.obaflix.tv.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.MessageDigest

/**
 * O lado da TV no pareamento.
 *
 * A TV pede um pareamento, mostra o QR Code e o codigo curto, e pergunta de
 * tempos em tempos se ja foi aprovada. Quando for, guarda o refresh token e
 * segue a vida.
 *
 * O `deviceCode` que ela recebe no inicio e o segredo do fluxo: fica em memoria,
 * nunca e desenhado na tela, nunca vai para log e nunca e gravado em disco. O
 * que aparece na televisao e so o `userCode`, que sozinho nao autentica nada.
 */
object PareamentoTv {

    private val JSON = "application/json; charset=utf-8".toMediaType()

    // ── Identidade do aparelho ───────────────────────────────────────────────

    /**
     * Impressao do aparelho, ja em SHA-256.
     *
     * O servidor recebe o hash, nunca o ANDROID_ID em claro: ele so precisa
     * reconhecer "e o mesmo aparelho de antes", e para isso o hash basta. Serve
     * para amarrar o poll e a renovacao ao aparelho que comecou o pareamento.
     */
    @SuppressLint("HardwareIds")
    fun fingerprint(context: Context): String {
        val bruto = buildString {
            append(
                Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
                    ?: "sem-android-id",
            )
            append('|')
            append(Build.MODEL ?: "?")
            append('|')
            append(Build.MANUFACTURER ?: "?")
        }
        return MessageDigest.getInstance("SHA-256")
            .digest(bruto.toByteArray())
            .joinToString("") { "%02x".format(it) }
    }

    fun modelo(): String = listOfNotNull(
        Build.MANUFACTURER?.takeIf { it.isNotBlank() },
        Build.MODEL?.takeIf { it.isNotBlank() },
    ).joinToString(" ").ifBlank { "Aparelho de TV" }

    // ── Estados ──────────────────────────────────────────────────────────────

    data class Convite(
        /** Publico: aparece na tela e vai no QR. */
        val userCode: String,
        val userCodeFormatado: String,
        val urlQrCode: String,
        val urlVerificacao: String,
        /** Secreto: so em memoria. */
        val deviceCode: String,
        val expiraEmSeg: Int,
        val intervaloSeg: Int,
    )

    sealed interface ResultadoPoll {
        data object Pendente : ResultadoPoll
        data object Expirado : ResultadoPoll
        data class Aprovado(val accessToken: String, val refreshToken: String, val deviceId: String) : ResultadoPoll
        data class Falha(val motivo: String) : ResultadoPoll
    }

    // ── Chamadas ─────────────────────────────────────────────────────────────

    private fun post(caminho: String, corpo: JSONObject): Request =
        Request.Builder()
            .url("${BuildConfig.OBAFLIX_URL}$caminho")
            .header("User-Agent", SessaoTv.userAgent)
            .post(corpo.toString().toRequestBody(JSON))
            .build()

    suspend fun iniciar(context: Context): Convite? = withContext(Dispatchers.IO) {
        val corpo = JSONObject()
            .put("fingerprint", fingerprint(context))
            .put("modelo", modelo())

        runCatching {
            ObaflixApp.httpClient.newCall(post("/api/tv/pair/start", corpo)).execute().use { r ->
                if (!r.isSuccessful) return@use null
                val j = JSONObject(r.body?.string().orEmpty())
                Convite(
                    userCode = j.getString("userCode"),
                    userCodeFormatado = j.getString("userCodeFormatado"),
                    urlQrCode = j.getString("urlQrCode"),
                    urlVerificacao = j.getString("urlVerificacao"),
                    deviceCode = j.getString("deviceCode"),
                    expiraEmSeg = j.optInt("expiraEmSeg", 600),
                    intervaloSeg = j.optInt("intervaloSeg", 3),
                )
            }
        }.onFailure {
            // A URL nunca entra no log; o convite carrega o codigo publico e o
            // segredo, e nenhum dos dois tem por que aparecer.
            ObaLog.alerta(ObaLog.Fase.SESSAO, "pair_start_falhou", "erro" to it.javaClass.simpleName)
        }.getOrNull()
    }

    private suspend fun consultar(context: Context, convite: Convite): ResultadoPoll =
        withContext(Dispatchers.IO) {
            val corpo = JSONObject()
                .put("userCode", convite.userCode)
                .put("deviceCode", convite.deviceCode)
                .put("fingerprint", fingerprint(context))

            runCatching {
                ObaflixApp.httpClient.newCall(post("/api/tv/pair/poll", corpo)).execute().use { r ->
                    val j = JSONObject(r.body?.string().orEmpty())
                    when (j.optString("estado")) {
                        "aprovado" -> ResultadoPoll.Aprovado(
                            accessToken = j.getString("accessToken"),
                            refreshToken = j.getString("refreshToken"),
                            deviceId = j.getString("deviceId"),
                        )
                        "pendente" -> ResultadoPoll.Pendente
                        else -> ResultadoPoll.Expirado
                    }
                }
            }.getOrElse { ResultadoPoll.Falha(it.javaClass.simpleName) }
        }

    /**
     * Espera a aprovacao com ritmo adaptativo.
     *
     * Rapido no primeiro minuto, que e quando a pessoa esta com o celular na mao
     * e a resposta precisa parecer imediata; lento depois, porque uma tela
     * esquecida aberta nao pode custar uma consulta a cada tres segundos por dez
     * minutos. No caso tipico — cerca de 40 segundos ate aprovar — sao ~13
     * consultas, e uma leitura de Redis em cada.
     */
    suspend fun aguardar(
        context: Context,
        convite: Convite,
        aoAtualizar: (ResultadoPoll) -> Unit,
    ) {
        val comeco = System.currentTimeMillis()
        val limiteMs = convite.expiraEmSeg * 1000L
        val rapidoAteMs = 60_000L
        var falhasSeguidas = 0

        while (System.currentTimeMillis() - comeco < limiteMs) {
            val decorrido = System.currentTimeMillis() - comeco
            delay(if (decorrido < rapidoAteMs) convite.intervaloSeg * 1000L else 10_000L)

            when (val r = consultar(context, convite)) {
                is ResultadoPoll.Aprovado -> {
                    ArmazenamentoSessao.salvar(context, r.refreshToken, r.deviceId)
                    SessaoTv.definirAccessToken(r.accessToken)
                    ObaLog.evento(ObaLog.Fase.SESSAO, "tv_pareada")
                    aoAtualizar(r)
                    return
                }
                is ResultadoPoll.Expirado -> {
                    aoAtualizar(r)
                    return
                }
                is ResultadoPoll.Falha -> {
                    // Rede oscilando nao deve encerrar o pareamento; a tela so
                    // desiste depois de algumas tentativas seguidas sem resposta.
                    if (++falhasSeguidas >= 5) {
                        aoAtualizar(r)
                        return
                    }
                }
                is ResultadoPoll.Pendente -> falhasSeguidas = 0
            }
        }
        aoAtualizar(ResultadoPoll.Expirado)
    }

    // ── Renovacao e saida ────────────────────────────────────────────────────

    /** Troca o refresh por um par novo. Falhou, a TV volta para o pareamento. */
    suspend fun renovar(context: Context): Boolean = withContext(Dispatchers.IO) {
        val refresh = ArmazenamentoSessao.refreshToken(context) ?: return@withContext false
        val corpo = JSONObject()
            .put("refreshToken", refresh)
            .put("fingerprint", fingerprint(context))

        runCatching {
            ObaflixApp.httpClient.newCall(post("/api/tv/session", corpo)).execute().use { r ->
                if (!r.isSuccessful) {
                    // 401 aqui significa revogado, expirado ou reutilizado. Em
                    // todos, a credencial local nao serve mais para nada.
                    if (r.code == 401) ArmazenamentoSessao.limpar(context)
                    return@use false
                }
                val j = JSONObject(r.body?.string().orEmpty())
                ArmazenamentoSessao.salvar(context, j.getString("refreshToken"), j.getString("deviceId"))
                SessaoTv.definirAccessToken(j.getString("accessToken"))
                true
            }
        }.getOrElse { false }
    }

    /** Sair da conta nesta TV: revoga no servidor e apaga o que estava em disco. */
    suspend fun sair(context: Context): Boolean = withContext(Dispatchers.IO) {
        val token = SessaoTv.accessToken()
        val requisicao = Request.Builder()
            .url("${BuildConfig.OBAFLIX_URL}/api/tv/session")
            .header("User-Agent", SessaoTv.userAgent)
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .delete()
            .build()

        val ok = runCatching {
            ObaflixApp.httpClient.newCall(requisicao).execute().use { it.isSuccessful }
        }.getOrElse { false }

        // Some com a credencial local mesmo se o servidor nao respondeu: o
        // usuario pediu para sair, e o refresh expira sozinho de qualquer forma.
        ArmazenamentoSessao.limpar(context)
        SessaoTv.definirAccessToken(null)
        ObaLog.evento(ObaLog.Fase.SESSAO, "tv_logout", "servidor" to ok)
        ok
    }
}
