package com.obaflix.tv.player

import com.obaflix.tv.catalogo.ApiObaflix
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Quem grava a posicao no servidor.
 *
 * Precisa de escopo proprio, fora da composicao: a gravacao mais importante e a
 * do momento em que a pessoa **sai** do player, e nesse instante o escopo da
 * tela ja foi cancelado — a corrotina lancada dali morreria antes de sair o
 * POST, e o progresso do episodio inteiro se perderia.
 *
 * SupervisorJob para uma falha de rede numa gravacao nao derrubar as seguintes.
 */
object GravadorProgresso {

    private val escopo = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun salvar(
        conteudoId: String,
        conteudoTipo: String,
        progressoSeg: Int,
        duracaoSeg: Int?,
        episodioId: String?,
        temporada: Int?,
        numeroEp: Int?,
    ) {
        // Abaixo de cinco segundos nao ha o que retomar, e gravar geraria uma
        // entrada em Continuar Assistindo por cada abertura acidental.
        if (progressoSeg < 5) return
        escopo.launch {
            ApiObaflix.salvarProgresso(
                conteudoId = conteudoId,
                conteudoTipo = conteudoTipo,
                progressoSeg = progressoSeg,
                duracaoSeg = duracaoSeg,
                episodioId = episodioId,
                temporada = temporada,
                numeroEp = numeroEp,
            )
        }
    }
}
