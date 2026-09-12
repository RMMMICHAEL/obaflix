package com.obaflix.download

import android.content.ContentResolver
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.URL
import java.util.concurrent.TimeUnit

/** Avanco de um download em andamento. Chamado de dentro do laco de escrita. */
interface ProgressoSink {
    fun avancou(bytes: Long, bytesTotal: Long, segmentosFeitos: Int, segmentosTotal: Int)
}

/** O que sobrou quando o download terminou bem. */
data class ResultadoDownload(
    val saidaUri: String,
    val bytes: Long,
    val segmentos: Int,
)

class DownloadException(val motivo: DownloadFailure, mensagem: String) : Exception(mensagem)

/**
 * Busca a midia e grava dentro da arvore SAF escolhida.
 *
 * ## Headers
 *
 * Manda exatamente `Referer` e `User-Agent` — os mesmos dois que o
 * `PlayerWebViewClient` injeta quando a WebView busca a mesma midia. Nenhum
 * cookie sai daqui: o `OkHttpClient` usado nao tem CookieJar, entao nao ha
 * caminho pelo qual `cf_clearance`, page token ou cfv cheguem ao CDN por esta
 * classe, nem por acidente.
 *
 * ## Por que sequencial, e nao em blocos paralelos
 *
 * Baixar N intervalos ao mesmo tempo dentro do mesmo arquivo exige abrir o
 * descritor em "rw" e posicionar cada escrita — e uma escrita fora de ordem que
 * falha no meio deixa um arquivo com buraco que parece completo. Numa rede
 * movel o ganho e pequeno e o modo de falha e silencioso. A retomada por
 * `Range` cobre o caso que importa de verdade, que e a conexao cair.
 */
class MediaDownloader(
    private val contentResolver: ContentResolver,
    private val client: OkHttpClient = clientPadrao(),
) {

    companion object {
        private const val BUFFER = 64 * 1024
        private const val TENTATIVAS = 3

        fun clientPadrao(): OkHttpClient = OkHttpClient.Builder()
            // Sem cookieJar de proposito — ver o KDoc da classe.
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()

        /**
         * Recusa destino que nao seja publico.
         *
         * Mesma checagem do `StreamExtractor`: a URL da fonte vem de um
         * provedor de terceiro e um redirecionamento para `127.0.0.1` ou para
         * um endereco de rede local transformaria o download num SSRF com o
         * aparelho do usuario como pivo.
         */
        /**
         * "tamanho@offset" do #EXT-X-BYTERANGE vira o header `Range` do HTTP.
         *
         * As duas notacoes contam coisas diferentes: o HLS declara **quantos**
         * bytes ler a partir de um offset, o HTTP declara o **ultimo indice**
         * inclusivo. Errar o `-1` aqui pede um byte a mais em cada segmento, o
         * que so aparece como video com estalo no fim de cada pedaco.
         */
        internal fun faixaDeExtX(byteRange: String): String? {
            val partes = byteRange.trim().split("@")
            val tamanho = partes.getOrNull(0)?.trim()?.toLongOrNull() ?: return null
            val offset = partes.getOrNull(1)?.trim()?.toLongOrNull() ?: 0L
            if (tamanho <= 0L) return null
            return "bytes=$offset-${offset + tamanho - 1}"
        }

        fun destinoPublico(url: String): Boolean = runCatching {
            val parsed = URL(url)
            if (parsed.protocol != "https") return false
            val enderecos = InetAddress.getAllByName(parsed.host)
            enderecos.isNotEmpty() && enderecos.none {
                it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress ||
                    it.isSiteLocalAddress || it.isMulticastAddress
            }
        }.getOrDefault(false)
    }

    // -- Sondagem de qualidades ----------------------------------------------

    /**
     * Descobre quais resolucoes esta fonte realmente oferece.
     *
     * E o unico lugar do app que sabe disso: `ExtractResult.qualities` so e
     * preenchido no caminho do Superflix (que nao e baixavel), entao para as
     * fontes que de fato podem ser baixadas a lista de variantes nao existe em
     * lugar nenhum ate alguem ler o master.
     *
     * Custo: uma requisicao ao master. Ela nao e desperdicada — a variante
     * escolhida ja sai daqui resolvida, e o download comeca direto na playlist
     * dela em vez de buscar o master de novo. No total continuam sendo duas
     * requisicoes de manifesto, as mesmas de antes.
     */
    suspend fun sondarQualidades(source: DownloadSource): List<QualidadeDownload> =
        withContext(Dispatchers.IO) {
            // MP4 nao tem manifesto para consultar. Abrir o container so para ler
            // a altura do track custaria baixar o inicio do arquivo, e o `moov`
            // pode estar no fim — e nada garante que esteja la. Sem metadata
            // confiavel, a opcao honesta e uma so.
            if (source.kind == MediaKind.MP4) return@withContext listOf(QualidadeDownload.padrao())

            exigirDestinoPublico(source.url)
            val texto = baixarTexto(source, source.url)
            if (!HlsPlaylist.ehPlaylist(texto)) {
                throw DownloadException(DownloadFailure.MANIFESTO_INVALIDO, "Resposta nao e um manifesto HLS")
            }
            // Playlist de midia direta: nao ha variantes para escolher.
            if (!HlsPlaylist.ehMaster(texto)) return@withContext listOf(QualidadeDownload.padrao())

            QualidadeDownload.deVariantes(HlsPlaylist.parseMaster(texto), source.url)
        }

    // -- MP4 ------------------------------------------------------------------

    suspend fun baixarMp4(
        source: DownloadSource,
        pasta: DocumentFile,
        nomeArquivo: String,
        sink: ProgressoSink,
    ): ResultadoDownload = withContext(Dispatchers.IO) {
        exigirDestinoPublico(source.url)

        val arquivo = pasta.createFile("video/mp4", nomeArquivo)
            ?: throw DownloadException(DownloadFailure.ESCRITA, "Nao foi possivel criar o arquivo")

        var gravados = 0L
        var total = -1L
        var tentativa = 0

        while (true) {
            currentCoroutineContext().ensureActive()
            try {
                // "wa" (append) na retomada: o que ja foi gravado continua
                // valido, e o Range pede so o que falta.
                val modo = if (gravados > 0L) "wa" else "w"
                val resposta = executar(source, source.url, faixaDe = gravados)
                resposta.use { r ->
                    val corpo = r.body ?: throw DownloadException(DownloadFailure.HTTP, "Resposta sem corpo")
                    if (total < 0L) {
                        val declarado = corpo.contentLength()
                        if (declarado > 0L) total = declarado + gravados
                    }
                    contentResolver.openOutputStream(arquivo.uri, modo).use { saida ->
                        if (saida == null) {
                            throw DownloadException(DownloadFailure.ESCRITA, "Sem stream de escrita")
                        }
                        gravados += copiar(corpo.byteStream(), { buf, n -> saida.write(buf, 0, n) }) { parcial ->
                            sink.avancou(gravados + parcial, total, 0, 0)
                        }
                    }
                }
                break
            } catch (e: DownloadException) {
                throw e
            } catch (e: IOException) {
                tentativa++
                if (tentativa >= TENTATIVAS) {
                    throw DownloadException(DownloadFailure.REDE, e.message ?: "Falha de rede")
                }
            }
        }

        ResultadoDownload(arquivo.uri.toString(), gravados, 0)
    }

    // -- HLS ------------------------------------------------------------------

    /**
     * Baixa manifesto e segmentos para uma subpasta propria.
     *
     * A subpasta existe porque HLS nao e um arquivo: sao centenas de segmentos
     * mais o manifesto reescrito. Jogar isso solto na pasta que o usuario
     * escolheu misturaria os segmentos de tres episodios diferentes.
     */
    /**
     * @param varianteId id da variante escolhida pelo usuario, quando houve
     *   escolha. Normalmente a URL de [source] **ja e** a da variante — o
     *   caminho normal nem passa por um master aqui. Este parametro cobre o
     *   caso em que a URL guardada ainda aponta para um master: sem ele, o
     *   downloader cairia em [HlsPlaylist.melhorVariante] e entregaria 1080p a
     *   quem escolheu 480p.
     */
    suspend fun baixarHls(
        source: DownloadSource,
        pasta: DocumentFile,
        nomePasta: String,
        sink: ProgressoSink,
        varianteId: String? = null,
    ): ResultadoDownload = withContext(Dispatchers.IO) {
        exigirDestinoPublico(source.url)

        // 1. Master -> variante. Um manifesto de midia direto tambem chega aqui,
        //    e nesse caso nao ha o que escolher.
        val textoInicial = baixarTexto(source, source.url)
        if (!HlsPlaylist.ehPlaylist(textoInicial)) {
            throw DownloadException(DownloadFailure.MANIFESTO_INVALIDO, "Resposta nao e um manifesto HLS")
        }

        var urlDaMidia = source.url
        var textoDaMidia = textoInicial
        if (HlsPlaylist.ehMaster(textoInicial)) {
            val variantes = HlsPlaylist.parseMaster(textoInicial)
            val variante = if (varianteId != null && varianteId != QualidadeDownload.ID_PADRAO) {
                // Escolha explicita: ou e ela, ou nada. Cair para a melhor
                // variante aqui seria entregar em silencio uma qualidade que a
                // pessoa nao pediu — e o arquivo ficaria no aparelho dela sem
                // nenhum aviso de que veio diferente.
                HlsPlaylist.porId(variantes, varianteId)
                    ?: throw DownloadException(
                        DownloadFailure.FONTE_INCOMPATIVEL,
                        "Variante escolhida nao existe mais no manifesto",
                    )
            } else {
                HlsPlaylist.melhorVariante(variantes)
                    ?: throw DownloadException(DownloadFailure.MANIFESTO_INVALIDO, "Master sem variantes")
            }
            urlDaMidia = HlsPlaylist.resolver(source.url, variante.uri)
            exigirDestinoPublico(urlDaMidia)
            textoDaMidia = baixarTexto(source, urlDaMidia)
        }

        val midia = HlsPlaylist.parseMedia(textoDaMidia)
        if (midia.criptografada) {
            // Gravar a chave de conteudo ao lado do video, na pasta do usuario,
            // e persistir material de decodificacao — fora do que esta rodada
            // se propoe. Recusa explicita e melhor que um arquivo ilegivel.
            throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "HLS criptografado")
        }
        if (midia.segmentos.isEmpty()) {
            throw DownloadException(DownloadFailure.MANIFESTO_INVALIDO, "Playlist sem segmentos")
        }

        val destino = pasta.createDirectory(nomePasta)
            ?: throw DownloadException(DownloadFailure.ESCRITA, "Nao foi possivel criar a pasta")

        // 2. Segmentos. O mapa guarda "URI resolvida -> nome local" e e o que a
        //    reescrita do manifesto consulta depois.
        val nomes = LinkedHashMap<String, String>()
        var bytes = 0L
        var feitos = 0

        val comInit = buildList {
            midia.initSegment?.let { add(it to "init.mp4") }
            midia.segmentos.forEachIndexed { i, seg ->
                add(seg to "seg%05d%s".format(i + 1, extensaoDe(seg.uri)))
            }
        }
        val total = comInit.size

        for ((segmento, nomeLocal) in comInit) {
            currentCoroutineContext().ensureActive()
            val urlSeg = HlsPlaylist.resolver(urlDaMidia, segmento.uri)
            exigirDestinoPublico(urlSeg)

            val arquivo = destino.createFile("video/mp2t", nomeLocal)
                ?: throw DownloadException(DownloadFailure.ESCRITA, "Nao foi possivel criar o segmento")

            bytes += baixarParaArquivo(source, urlSeg, segmento.byteRange, arquivo)
            nomes[urlSeg] = nomeLocal
            feitos++
            sink.avancou(bytes, -1L, feitos, total)
        }

        // 3. Manifesto local, apontando aos arquivos gravados.
        val local = HlsPlaylist.reescreverParaLocal(textoDaMidia, urlDaMidia) { nomes[it] }
        val manifesto = destino.createFile("application/x-mpegURL", "index.m3u8")
            ?: throw DownloadException(DownloadFailure.ESCRITA, "Nao foi possivel criar o manifesto")
        contentResolver.openOutputStream(manifesto.uri, "w").use { saida ->
            saida?.write(local.toByteArray(Charsets.UTF_8))
                ?: throw DownloadException(DownloadFailure.ESCRITA, "Sem stream de escrita")
        }

        ResultadoDownload(destino.uri.toString(), bytes, feitos)
    }

    // -- Comuns ---------------------------------------------------------------

    private fun exigirDestinoPublico(url: String) {
        if (!destinoPublico(url)) {
            throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "Destino bloqueado")
        }
    }

    private fun executar(source: DownloadSource, url: String, faixaDe: Long = 0L, byteRange: String? = null) =
        client.newCall(pedido(source, url, faixaDe, byteRange)).execute().also { r ->
            if (!r.isSuccessful) {
                val codigo = r.code
                r.close()
                throw DownloadException(
                    if (codigo == 403 || codigo == 401) DownloadFailure.FONTE_EXPIRADA else DownloadFailure.HTTP,
                    "HTTP $codigo",
                )
            }
        }

    private fun pedido(source: DownloadSource, url: String, faixaDe: Long, byteRange: String?): Request =
        Request.Builder().url(url).apply {
            source.referer?.let { header("Referer", it) }
            source.userAgent?.let { header("User-Agent", it) }
            when {
                byteRange != null -> Companion.faixaDeExtX(byteRange)?.let { header("Range", it) }
                faixaDe > 0L -> header("Range", "bytes=$faixaDe-")
            }
        }.build()

    private suspend fun baixarTexto(source: DownloadSource, url: String): String {
        var tentativa = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            try {
                executar(source, url).use { r ->
                    return r.body?.string()
                        ?: throw DownloadException(DownloadFailure.MANIFESTO_INVALIDO, "Manifesto vazio")
                }
            } catch (e: DownloadException) {
                throw e
            } catch (e: IOException) {
                tentativa++
                if (tentativa >= TENTATIVAS) {
                    throw DownloadException(DownloadFailure.REDE, e.message ?: "Falha de rede")
                }
            }
        }
    }

    private suspend fun baixarParaArquivo(
        source: DownloadSource,
        url: String,
        byteRange: String?,
        destino: DocumentFile,
    ): Long {
        var tentativa = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            try {
                executar(source, url, byteRange = byteRange).use { r ->
                    val corpo = r.body ?: throw DownloadException(DownloadFailure.HTTP, "Segmento sem corpo")
                    contentResolver.openOutputStream(destino.uri, "w").use { saida ->
                        if (saida == null) {
                            throw DownloadException(DownloadFailure.ESCRITA, "Sem stream de escrita")
                        }
                        return copiar(corpo.byteStream(), { buf, n -> saida.write(buf, 0, n) }, null)
                    }
                }
            } catch (e: DownloadException) {
                throw e
            } catch (e: IOException) {
                tentativa++
                if (tentativa >= TENTATIVAS) {
                    throw DownloadException(DownloadFailure.REDE, e.message ?: "Falha de rede")
                }
            }
        }
    }

    /**
     * Copia com cancelamento cooperativo.
     *
     * O `ensureActive` dentro do laco e o que faz "Cancelar" surtir efeito no
     * meio de um arquivo grande: sem ele o laco so terminaria no fim do corpo
     * da resposta, e um episodio de 1 GB continuaria consumindo rede depois de
     * o usuario ja ter cancelado.
     */
    private suspend fun copiar(
        entrada: InputStream,
        escrever: (ByteArray, Int) -> Unit,
        aoAvancar: ((Long) -> Unit)?,
    ): Long {
        val buffer = ByteArray(BUFFER)
        var total = 0L
        entrada.use { fonte ->
            while (true) {
                currentCoroutineContext().ensureActive()
                val lidos = fonte.read(buffer)
                if (lidos <= 0) break
                escrever(buffer, lidos)
                total += lidos
                aoAvancar?.invoke(total)
            }
        }
        return total
    }

    private fun extensaoDe(uri: String): String {
        val caminho = uri.substringBefore('?').substringBefore('#')
        return when {
            caminho.endsWith(".m4s", ignoreCase = true) -> ".m4s"
            caminho.endsWith(".mp4", ignoreCase = true) -> ".mp4"
            caminho.endsWith(".aac", ignoreCase = true) -> ".aac"
            else -> ".ts"
        }
    }
}
