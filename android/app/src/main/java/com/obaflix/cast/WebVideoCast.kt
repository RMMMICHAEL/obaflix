package com.obaflix.cast

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle

/**
 * Integracao com o Web Video Cast, por Intent explicito.
 *
 * ## Por que um aplicativo externo, e nao Chromecast nativo
 *
 * O stack nativo de Cast obrigaria o receptor a buscar a midia sozinho, de um
 * IP que nao e o do aparelho, sem os headers de autorizacao — o que o CDN
 * responde com 403 para praticamente toda fonte que temos. O Web Video Cast
 * roda no proprio aparelho, faz a requisicao ele mesmo com os headers que
 * passamos e retransmite. E a unica forma de transmitir midia autorizada por
 * Referer sem inventar um proxy publico.
 */
object WebVideoCast {

    const val PACOTE = "com.instantbits.cast.webvideo"
    private const val PLAY_STORE_APP = "market://details?id=$PACOTE"
    private const val PLAY_STORE_WEB = "https://play.google.com/store/apps/details?id=$PACOTE"

    /**
     * O Intent a montar, como dado puro.
     *
     * Existe separado do `Intent` de verdade porque `Intent` e classe de
     * framework: num teste unitario de JVM todo `putExtra` vira no-op e todo
     * `getStringExtra` devolve null, entao asserir sobre um `Intent` construido
     * nao provaria nada. Sobre esta classe, prova.
     */
    data class Especificacao(
        val pacote: String,
        val acao: String,
        val url: String,
        val mimeType: String,
        val titulo: String,
        val poster: String?,
        val headers: Map<String, String>,
    )

    /**
     * Monta a especificacao a partir de uma fonte ja aprovada.
     *
     * Os headers sao **so** Referer e User-Agent, e so quando existem. Nao ha
     * ramo que copie cookie, `cf_clearance`, page token ou cfv para ca: o
     * [CastSource] nem carrega esses campos, entao o vazamento nao e evitado
     * por disciplina, e impossivel de escrever sem mudar o tipo.
     */
    fun especificacao(source: CastSource): Especificacao {
        val headers = LinkedHashMap<String, String>()
        source.referer?.let { headers["Referer"] = it }
        source.userAgent?.let { headers["User-Agent"] = it }
        return Especificacao(
            pacote = PACOTE,
            acao = Intent.ACTION_VIEW,
            url = source.url,
            mimeType = source.mimeType,
            titulo = source.titulo,
            poster = source.poster,
            headers = headers,
        )
    }

    fun instalado(context: Context): Boolean = runCatching {
        context.packageManager.getPackageInfo(PACOTE, 0)
        true
    }.getOrDefault(false)

    /**
     * Intent explicito para o Web Video Cast.
     *
     * Explicito (com `setPackage`) e nao um seletor: um `ACTION_VIEW` aberto
     * com uma URL de midia autorizada ofereceria a fonte a qualquer app que
     * declare o MIME, incluindo um instalado depois com essa finalidade. O
     * destino aqui e um so, conhecido, e declarado em `<queries>`.
     */
    fun intent(source: CastSource): Intent {
        val spec = especificacao(source)
        return Intent(spec.acao).apply {
            setPackage(spec.pacote)
            setDataAndType(Uri.parse(spec.url), spec.mimeType)
            putExtra("title", spec.titulo)
            spec.poster?.let { putExtra("poster", it) }
            // Diz ao app externo que a URL e https e nao deve ser rebaixada.
            putExtra("secure_uri", true)
            if (spec.headers.isNotEmpty()) {
                val bundle = Bundle()
                spec.headers.forEach { (k, v) -> bundle.putString(k, v) }
                putExtra("android.media.intent.extra.HTTP_HEADERS", bundle)
            }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    /**
     * Leva a pagina do Web Video Cast na loja.
     *
     * Nunca instala nada — abre a ficha e quem decide e o usuario. Tenta a loja
     * nativa primeiro e cai no navegador quando ela nao existe (aparelho sem
     * Play Store, que e comum nos mesmos AOSP que rodam o app).
     */
    fun abrirNaLoja(context: Context): Boolean {
        val nativa = Intent(Intent.ACTION_VIEW, Uri.parse(PLAY_STORE_APP))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (resolve(context, nativa)) {
            context.startActivity(nativa)
            return true
        }
        val web = Intent(Intent.ACTION_VIEW, Uri.parse(PLAY_STORE_WEB))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (resolve(context, web)) {
            context.startActivity(web)
            return true
        }
        return false
    }

    private fun resolve(context: Context, intent: Intent): Boolean = runCatching {
        context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) != null
    }.getOrDefault(false)
}
