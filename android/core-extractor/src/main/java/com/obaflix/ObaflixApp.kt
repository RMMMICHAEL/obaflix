package com.obaflix

import android.app.Application
import android.os.Build
import org.conscrypt.Conscrypt
import java.security.Security
import com.obaflix.bridge.ObaLog
import com.obaflix.bridge.PlayerState
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class ObaflixApp : Application() {

    companion object {
        lateinit var httpClient: OkHttpClient
            private set

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
            .build()

        ObaLog.ambiente(mapOf("webview" to webViewVersion()))
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
