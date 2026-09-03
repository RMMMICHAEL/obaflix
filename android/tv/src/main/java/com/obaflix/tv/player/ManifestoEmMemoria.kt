package com.obaflix.tv.player

import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import com.obaflix.bridge.ObaLog

/**
 * Serve **um** manifesto já autorizado a partir da memória, e o resto pela rede.
 *
 * Motivo de existir: a mídia do player externo do Superflix está presa à sessão
 * do Chromium. Medido em aparelho, uma requisição nossa ao mesmo `master.txt`
 * responde 403 mesmo no instante em que a página o pede — com o cookie, o UA, o
 * Referer e o Origin daquele momento. Não há cabeçalho que transporte aquela
 * autorização, e inventar um está fora de questão.
 *
 * O que sobra, e é o que esta classe faz, é atravessar só o nível protegido: o
 * navegador consome o master, o texto vem por `Midia.manifesto`, e o Media3 o
 * recebe **na URI original**. A URI importa: é contra ela que o Media3 resolve
 * as URIs relativas das variantes, então nada na cadeia enxerga endereço
 * diferente do real.
 *
 * Tudo o mais — sub-playlists, chaves, segmentos — continua saindo pela rede,
 * com os cabeçalhos de sempre. É o mínimo de ponte que resolve o problema; se
 * as variantes também forem recusadas, o log de `DiagnosticoPlayer` dirá, e a
 * decisão de estender a ponte será outra, tomada com evidência.
 *
 * Nada é persistido: o texto vive em memória, vale para a reprodução em curso e
 * some em `limpar()`.
 */
@UnstableApi
class ManifestoEmMemoria(
    private val delegada: DataSource.Factory,
) : DataSource.Factory {

    @Volatile
    private var alvo: Uri? = null

    @Volatile
    private var corpo: ByteArray? = null

    /** Arma o manifesto para a URI desta reprodução. */
    fun armar(url: String, manifesto: String) {
        alvo = Uri.parse(url)
        corpo = manifesto.toByteArray(Charsets.UTF_8)
        ObaLog.evento(
            ObaLog.Fase.MANIFESTO, "tv_manifesto_em_memoria",
            "host" to ObaLog.host(url),
            "bytes" to (corpo?.size ?: 0),
        )
    }

    /** Desarma. Chamado a cada troca de fonte, servidor ou episódio. */
    fun limpar() {
        alvo = null
        corpo = null
    }

    override fun createDataSource(): DataSource = Fonte(delegada.createDataSource())

    private inner class Fonte(private val rede: DataSource) : DataSource {

        private val memoria = ByteArrayDataSource(ByteArray(0))
        private var atual: DataSource = rede
        private var ouvintes = mutableListOf<TransferListener>()

        override fun open(dataSpec: DataSpec): Long {
            val guardado = corpo
            val esperado = alvo
            atual = if (guardado != null && esperado != null && dataSpec.uri == esperado) {
                ObaLog.evento(
                    ObaLog.Fase.MANIFESTO, "tv_manifesto_servido_da_memoria",
                    "host" to ObaLog.host(dataSpec.uri.toString()),
                )
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

        override fun close() = atual.close()

        override fun addTransferListener(transferListener: TransferListener) {
            ouvintes.add(transferListener)
            rede.addTransferListener(transferListener)
            memoria.addTransferListener(transferListener)
        }
    }
}
