package com.obaflix

import android.app.Application
import android.os.Build
import org.conscrypt.Conscrypt
import java.security.Security
import com.obaflix.bridge.ObaLog
import com.obaflix.bridge.PlayerState
import com.obaflix.security.AppIntegrity
import com.obaflix.security.AppIntegrityStatus
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.util.concurrent.TimeUnit

/**
 * Promove a https os redirecionamentos que o CDN devolve em http.
 *
 * O provedor do MP4 progressivo responde 3xx apontando para um host de borda
 * com esquema http, mesmo servindo o mesmo caminho em https com certificado
 * valido. Como o aplicativo proibe cleartext (network_security_config), o
 * OkHttp recusava o salto com UnknownServiceException e o Media3 traduzia isso
 * em "Source error" — a fonte inteira morria por um esquema errado no Location,
 * e nao por estar indisponivel.
 *
 * Reescrever o Location e o menor conserto possivel: nao afrouxa a politica de
 * cleartext, nao confia em host nenhum, e so troca o esquema de um destino que
 * ja atende em TLS. Se o host nao atendesse em https, a falha continuaria — o
 * que e o comportamento correto.
 *
 * E um network interceptor de proposito: os saltos intermediarios de um
 * redirecionamento nao passam pelos interceptors de aplicacao.
 */
private object RedirecionamentoHttps : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val resposta = chain.proceed(chain.request())
        if (!resposta.isRedirect) return resposta
        val destino = resposta.header("Location") ?: return resposta
        if (!destino.startsWith("http://", ignoreCase = true)) return resposta

        val promovido = "https://" + destino.substring("http://".length)
        ObaLog.alerta(
            ObaLog.Fase.CDN, "redirecionamento_promovido_https",
            "host" to ObaLog.host(promovido),
            "status" to resposta.code,
        )
        return resposta.newBuilder()
            .header("Location", promovido)
            .build()
    }
}

class ObaflixApp : Application() {

    companion object {
        // internal, não private: o teste de regressão do 403 do embedplayer
        // (SuperflixEmbedplayerFailoverTest) precisa apontar este cliente para
        // um MockWebServer local antes de exercitar PlayerExtractors.extractEmbedPlayer,
        // que o usa diretamente. Nada muda em produção — onCreate() continua
        // sendo o único lugar que o define ali.
        lateinit var httpClient: OkHttpClient
            internal set

        /**
         * Cliente usado para o corpo da midia (manifesto, segmentos, MP4).
         *
         * Separado do httpClient porque `readTimeout` significa "tempo maximo
         * entre dois bytes", e o corpo de uma resposta de midia e consumido
         * preguicosamente pelo WebView: quando o buffer do player enche, ele
         * simplesmente para de ler. Passados os 20s do cliente comum, a proxima
         * leitura estourava SocketTimeoutException no meio do stream — o video
         * travava ou o hls.js reportava fragLoadError sem nenhuma pista de por
         * que, ja que a requisicao havia respondido 200/206 normalmente.
         *
         * Aqui o read timeout e zero (sem limite) e o de conexao continua curto,
         * que e o que de fato precisa falhar rapido para o player trocar de fonte.
         */
        lateinit var mediaClient: OkHttpClient
            private set

        @Volatile
        var webViewUserAgent: String? = null

        /**
         * WebView principal, para quem precisa anexar algo a hierarquia de views
         * de fora da Activity — hoje so o overlay do desafio do SuperFlix.
         * Referencia fraca porque a Activity pode ser recriada (rotacao, morte do
         * renderer) e uma referencia forte a vazaria.
         */
        @Volatile
        var hostWebView: java.lang.ref.WeakReference<android.webkit.WebView>? = null

        val playerState = PlayerState()

        @Volatile
        var integrityStatus: AppIntegrityStatus = AppIntegrityStatus.NOT_CONFIGURED
            private set
    }

    /**
     * Instala o Conscrypt como provedor de TLS preferencial.
     *
     * So abaixo do Android 10, que e onde o sistema nao negocia TLS 1.3 sozinho.
     * Acima disso o proprio aparelho ja resolve, e trocar o provedor de quem
     * esta funcionando seria risco sem ganho.
     *
     * Falha silenciosa de proposito: sem o Conscrypt o aplicativo continua como
     * antes desta linha existir — funcionando com os provedores que aceitam
     * TLS 1.2, e falhando nos que exigem 1.3.
     */
    private fun instalarTlsModerno() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return
        runCatching {
            Security.insertProviderAt(Conscrypt.newProvider(), 1)
        }.onSuccess {
            ObaLog.evento(ObaLog.Fase.SESSAO, "tls_conscrypt_ativo", "sdk" to Build.VERSION.SDK_INT)
        }.onFailure {
            ObaLog.alerta(
                ObaLog.Fase.SESSAO, "tls_conscrypt_falhou",
                "erro" to it.javaClass.simpleName,
            )
        }
    }

    override fun onCreate() {
        super.onCreate()
        // Antes de qualquer cliente HTTP nascer: o OkHttp captura a fabrica de
        // SSL na construcao, e trocar o provedor depois nao teria efeito.
        instalarTlsModerno()
        integrityStatus = AppIntegrity.verify(this)
        httpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()

        // Compartilha pool de conexoes e dispatcher com o cliente comum; muda so
        // os tempos. Sem newBuilder() seriam dois pools, e cada segmento HLS
        // refaria o handshake TLS com o CDN.
        mediaClient = httpClient.newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .addNetworkInterceptor(RedirecionamentoHttps)
            .build()

        ObaLog.ambiente(
            mapOf(
                "webview" to webViewVersion(),
                "integridade" to integrityStatus.wireName,
            ),
        )
    }

    /**
     * Versao do pacote da WebView do sistema.
     *
     * Vale registrar porque varios comportamentos deste app dependem dela: o
     * bloqueio automatico do header X-Requested-With so existe da 118 em diante,
     * e aparelhos com WebView antiga falham em manifestos que funcionam nos demais.
     */
    private fun webViewVersion(): String {
        // getCurrentWebViewPackage chega na API 26. Abaixo disso nao ha como
        // descobrir a versao, e o log registra isso em vez de estourar.
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) return "indisponivel"
        return runCatching {
            android.webkit.WebView.getCurrentWebViewPackage()?.versionName ?: "desconhecida"
        }.getOrDefault("indisponivel")
    }
}
