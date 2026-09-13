package com.obaflix.download

import java.util.UUID

/**
 * A fonte sondada que espera o usuario escolher a qualidade no modal.
 *
 * ## Por que e uma classe propria, e nao dois campos na ponte
 *
 * O que ela guarda e a URL assinada mais os headers de autorizacao, vivos entre
 * a abertura e o fechamento de um modal. As regras de quando isso vale — id
 * confere, prazo nao venceu, qualidade pertence a esta sondagem — sao
 * exatamente as que nao podem afrouxar, e aqui elas sao testaveis sem Android.
 *
 * **Nunca vai para o disco.** [DownloadStore] existe para apagar esses campos
 * quando um download termina; guardar a mesma coisa em SharedPreferences por
 * "conveniencia do modal" desfaria isso.
 */
class SondagemDeFonte(
    private val validadeMs: Long = 5 * 60 * 1000L,
    private val relogio: () -> Long = System::currentTimeMillis,
    private val gerarId: () -> String = { UUID.randomUUID().toString() },
) {

    data class Guardada(
        val id: String,
        val source: DownloadSource,
        val qualidades: List<QualidadeDownload>,
        val pid: String,
        val titulo: String,
        val criadaEm: Long,
    )

    /** O que sai de [resgatar]. */
    sealed class Resgate {
        data class Ok(
            val source: DownloadSource,
            val qualidade: QualidadeDownload,
            val pid: String,
            val titulo: String,
        ) : Resgate()

        /** Id nao confere, ou nao ha sondagem — inclui o modal ja fechado. */
        object NaoEncontrada : Resgate()

        object Expirada : Resgate()

        object QualidadeInvalida : Resgate()
    }

    /**
     * Uma so por vez: o modal e modal, nao existem dois abertos.
     *
     * Guardar uma nova descarta a anterior — que e o comportamento certo quando
     * a pessoa fecha um modal e abre outro em outro episodio.
     */
    @Volatile
    private var atual: Guardada? = null

    fun guardar(
        source: DownloadSource,
        qualidades: List<QualidadeDownload>,
        pid: String,
        titulo: String,
    ): String {
        val id = gerarId()
        atual = Guardada(id, source, qualidades, pid, titulo, relogio())
        return id
    }

    /**
     * Consome a sondagem.
     *
     * Descarta em qualquer desfecho — inclusive no sucesso. Uma sondagem
     * resgatada duas vezes viraria dois downloads do mesmo toque.
     */
    fun resgatar(id: String, qualidadeId: String): Resgate {
        val guardada = atual ?: return Resgate.NaoEncontrada
        if (guardada.id != id) return Resgate.NaoEncontrada

        if (relogio() - guardada.criadaEm > validadeMs) {
            atual = null
            return Resgate.Expirada
        }

        val qualidade = guardada.qualidades.firstOrNull { it.id == qualidadeId }
            ?: return Resgate.QualidadeInvalida

        atual = null
        return Resgate.Ok(guardada.source, qualidade, guardada.pid, guardada.titulo)
    }

    /**
     * O usuario fechou o modal sem escolher.
     *
     * Solta a URL assinada da memoria na hora, em vez de esperar o prazo. E o
     * que garante que fechar o modal nao deixa nada pendente nem inicia nada.
     */
    fun descartar() {
        atual = null
    }

    /** Só para diagnóstico e teste. */
    val temSondagemAberta: Boolean get() = atual != null
}
