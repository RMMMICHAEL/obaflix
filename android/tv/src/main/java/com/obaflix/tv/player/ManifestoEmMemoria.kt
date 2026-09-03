package com.obaflix.tv.player

import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import com.obaflix.bridge.ObaLog
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Serve **um** manifesto já autorizado a partir da memória, e o resto pela rede.
 *
 * ## Por que existe
 *
 * A mídia do player externo do Superflix está presa à sessão do Chromium.
 * Medido em aparelho, uma requisição nossa ao mesmo `master.txt` responde 403
 * mesmo no instante em que a página o pede, com o cookie, o UA, o Referer e o
 * Origin daquele momento. Não há cabeçalho que transporte aquela autorização.
 *
 * O que sobra é atravessar só o nível protegido: o navegador consome o master,
 * o texto vem por `Midia.manifesto`, e o Media3 o recebe **na URI original** —
 * é contra ela que o parser HLS resolve as URIs relativas das variantes.
 * Sub-playlists, chaves e segmentos continuam saindo pela rede.
 *
 * ## Opt-in estrito
 *
 * Sem manifesto armado, `createDataSource()` devolve o `DataSource` da fábrica
 * de rede **sem embrulho nenhum**: para MP4, HLS comum e qualquer outra fonte o
 * caminho é byte a byte o mesmo de antes desta classe existir.
 *
 * Isso não é preciosismo. A primeira versão guardava um
 * `ByteArrayDataSource(ByteArray(0))` como campo do embrulho, criado a cada
 * `createDataSource()`; esse construtor exige array não-vazio e lançava
 * `IllegalArgumentException` sempre — para toda mídia, antes de qualquer I/O.
 * O Media3 reportava `ERROR_CODE_FAILED_RUNTIME_CHECK` e a TV inteira parava de
 * tocar, inclusive as fontes que nada tinham a ver com o player externo. Ver
 * `ManifestoEmMemoriaTest`.
 *
 * ## Ciclo de vida
 *
 * Nada é persistido: o texto vive em memória, vale para a reprodução em curso e
 * some em `limpar()` — troca de fonte, troca de episódio e saída da tela.
 */
@UnstableApi
class ManifestoEmMemoria(
    private val delegada: DataSource.Factory,
) : DataSource.Factory {

    /** URI do master, em texto, para comparação sem depender de `Uri.equals`. */
    @Volatile
    private var alvo: String? = null

    @Volatile
    private var corpo: ByteArray? = null

    /** Arma o manifesto para a URI desta reprodução. */
    fun armar(url: String, manifesto: String) {
        val bytes = manifesto.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty()) {
            // Manifesto vazio não é manifesto. Armar seria trocar uma falha de
            // rede por uma falha de contrato mais adiante.
            limpar()
            ObaLog.alerta(ObaLog.Fase.MANIFESTO, "tv_manifesto_vazio_ignorado")
            return
        }
        alvo = url
        corpo = bytes
        ObaLog.evento(
            ObaLog.Fase.MANIFESTO, "tv_manifesto_em_memoria",
            "host" to ObaLog.host(url),
            "bytes" to bytes.size,
        )
    }

    /** Desarma. Chamado a cada troca de fonte, servidor ou episódio. */
    fun limpar() {
        alvo = null
        corpo = null
    }

    /** Esta URI deve ser servida da memória? Puro de propósito: é testável. */
    internal fun casa(uri: String?): Boolean = corpoPara(uri) != null

    /**
     * Bytes a servir para esta URI, ou `null` para deixar seguir pela rede.
     *
     * É a decisão inteira do mecanismo, isolada de `DataSpec` e de `Uri` — que
     * no android.jar de teste unitário são stubs. Toda a regra que importa
     * (opt-in, URI exata, child playlist e segmento pela rede) fica verificável
     * sem Robolectric.
     */
    internal fun corpoPara(uri: String?): ByteArray? {
        val guardado = corpo ?: return null
        val esperado = alvo ?: return null
        return if (uri != null && uri == esperado) guardado else null
    }

    override fun createDataSource(): DataSource {
        // Opt-in: sem manifesto armado, nem embrulho existe.
        if (corpo == null) return delegada.createDataSource()
        return Fonte(delegada.createDataSource())
    }

    /**
     * Embrulho que escolhe a origem **por abertura**.
     *
     * Cada `open()` decide de novo, e o `ByteArrayDataSource` é criado na hora:
     * o Media3 pode abrir o mesmo master mais de uma vez — farejamento,
     * preparação, recarga da playlist — e um buffer consumido não pode ficar
     * pela metade para a abertura seguinte.
     */
    private inner class Fonte(private val rede: DataSource) : DataSource {

        private val ouvintes = CopyOnWriteArrayList<TransferListener>()
        private var atual: DataSource = rede

        override fun open(dataSpec: DataSpec): Long {
            val guardado = corpoPara(dataSpec.uri.toString())
            atual = if (guardado != null) {
                ObaLog.evento(
                    ObaLog.Fase.MANIFESTO, "tv_manifesto_servido_da_memoria",
                    "host" to ObaLog.host(dataSpec.uri.toString()),
                    "posicao" to dataSpec.position,
                )
                // Instância nova a cada abertura. `position` e `length` do
                // DataSpec são tratados pela própria classe do Media3, inclusive
                // a recusa de posição fora de faixa — que é o comportamento que
                // o player espera.
                ByteArrayDataSource(guardado).also { nova ->
                    ouvintes.forEach { nova.addTransferListener(it) }
                }
            } else {
                rede
            }
            return atual.open(dataSpec)
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
            atual.read(buffer, offset, length)

        override fun getUri(): Uri? = atual.uri

        override fun getResponseHeaders(): Map<String, List<String>> = atual.responseHeaders

        override fun close() {
            val fechando = atual
            // Volta para a rede antes de fechar: se `close()` vier duas vezes,
            // a segunda cai num `DataSource` que trata fechamento repetido, e
            // não numa instância de memória já descartada.
            atual = rede
            fechando.close()
        }

        override fun addTransferListener(transferListener: TransferListener) {
            ouvintes.addIfAbsent(transferListener)
            rede.addTransferListener(transferListener)
            // Uma abertura de memória já em curso também precisa ouvir.
            (atual as? ByteArrayDataSource)?.addTransferListener(transferListener)
        }
    }
}
