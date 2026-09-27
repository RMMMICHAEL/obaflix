package com.obaflix.tv.player

import com.obaflix.tv.catalogo.Concessao
import kotlinx.coroutines.sync.Mutex

/**
 * Controle de reproducao de um canal, do lado da televisao.
 *
 * Classe pura: sem Compose, sem Media3, sem corrotina propria. Tudo que toca o
 * mundo entra por parametro, para poder ser **testada como protocolo**
 * (`HandoffDeCanalTest`).
 *
 * Espelha `src/lib/canais/handoff.ts`. Comportamento observavel igual; o codigo
 * nao precisa ser.
 *
 * ## O contrato
 *
 * `POST /api/canais/[id]/play` devolve `streamUrl`, e o aparelho busca a midia
 * direto. Essa URL nao vence num relogio nosso: vale ate o provedor girar ou
 * cair. Entao nao ha renovacao periodica — ha **re-resolucao quando a
 * reproducao falha**: o player chama `aoErroDeReproducao`, este controle pede
 * uma URL nova (`reresolucao = true`) e troca a fonte.
 *
 * A versao anterior esperava o contrato aposentado do Worker (`manifestUrl`,
 * `sessionId`, geracao). Com o servidor atual ela recebia 200 sem
 * `manifestUrl`, tratava como falha temporaria e o canal nunca tocava.
 *
 * ## Teto, para nao virar tempestade
 *
 * Um canal fora do ar falharia, re-resolveria, falharia de novo — um laco
 * contra o `/play` e o provedor. O teto e uma janela deslizante: no maximo
 * `maxReresolucoes` dentro de `janelaMs`. Estourou, `aoPerder` para a
 * reproducao e a tela oferece o "tentar de novo" manual (que cria outro
 * controle e zera a contagem).
 *
 * ## Single-flight
 *
 * Enquanto uma re-resolucao esta em andamento (incluindo a espera apos uma
 * falha temporaria), um novo erro nao dispara outra. O ExoPlayer costuma
 * reportar a mesma queda mais de uma vez.
 */
class HandoffDeCanal(
    private val canalId: String,
    /** `reresolucao = false` e a abertura; `true` e a continuacao apos erro. */
    private val pedir: suspend (canalId: String, reresolucao: Boolean) -> Concessao,
    /**
     * Faz o player realmente passar a usar esta URL (`setMediaItem` + `prepare`).
     * Nao pode ser "guardar numa variavel": trocar a fonte e o efeito.
     */
    private val trocarFonte: (streamUrl: String) -> Unit,
    /** Recusa definitiva ou teto estourado: a reproducao para e a tela explica. */
    private val aoPerder: (Concessao) -> Unit,
    /** `delay` injetavel, para o teste controlar o relogio. */
    private val esperar: suspend (millis: Long) -> Unit,
    /** Relogio injetavel. */
    private val agora: () -> Long = { System.currentTimeMillis() },
    private val maxReresolucoes: Int = 3,
    private val janelaMs: Long = 60_000,
    private val esperaAposFalhaMs: Long = 3_000,
) {

    /** A URL em uso. `null` antes da primeira. Vive so em memoria. */
    var fonteAtual: String? = null
        private set

    /** Quantas re-resolucoes por erro foram efetivamente disparadas. */
    var reresolucoes: Int = 0
        private set

    private var vivo = true
    private val trava = Mutex()
    /** Instantes das re-resolucoes recentes, para o teto por janela deslizante. */
    private val carimbos = ArrayDeque<Long>()

    fun parar() {
        vivo = false
    }

    private fun tetoEstourado(): Boolean {
        val limite = agora() - janelaMs
        while (carimbos.isNotEmpty() && carimbos.first() < limite) carimbos.removeFirst()
        return carimbos.size >= maxReresolucoes
    }

    private fun perder(motivo: Concessao) {
        vivo = false
        aoPerder(motivo)
    }

    /** Pede a primeira URL e passa a tocar. */
    suspend fun iniciar(): Concessao {
        if (!trava.tryLock()) return Concessao.FalhaTemporaria
        try {
            val r = runCatching { pedir(canalId, false) }.getOrElse { Concessao.FalhaTemporaria }
            if (!vivo) return r
            if (r is Concessao.Liberado) {
                fonteAtual = r.streamUrl
                trocarFonte(r.streamUrl)
            } else {
                perder(r)
            }
            return r
        } finally {
            trava.unlock()
        }
    }

    /**
     * O player chama isto num erro fatal (ou no stall detectado pelo watchdog),
     * e o botao "Atualizar canal" tambem. Single-flight: se ja ha uma
     * re-resolucao em andamento, este pedido e absorvido por ela.
     */
    suspend fun aoErroDeReproducao() {
        if (!vivo || !trava.tryLock()) return
        try {
            while (vivo) {
                if (tetoEstourado()) {
                    // Fonte quebrada de verdade: parar e a resposta certa.
                    perder(Concessao.FalhaTemporaria)
                    return
                }
                carimbos.addLast(agora())
                reresolucoes++
                val r = runCatching { pedir(canalId, true) }.getOrElse { Concessao.FalhaTemporaria }
                if (!vivo) return
                when (r) {
                    is Concessao.Liberado -> {
                        fonteAtual = r.streamUrl
                        trocarFonte(r.streamUrl)
                        return
                    }
                    // Rede, rate limit, provedor instavel: espera curta e tenta
                    // de novo — ainda sob o teto, que garante o fim do laco.
                    Concessao.FalhaTemporaria -> esperar(esperaAposFalhaMs)
                    // Plano caiu, canal saiu do ar, sessao revogada.
                    else -> {
                        perder(r)
                        return
                    }
                }
            }
        } finally {
            trava.unlock()
        }
    }
}

/**
 * Detecta stall silencioso: o player diz que esta tocando, mas a posicao nao
 * anda. Espelha `src/lib/canais/watchdogDeStall.ts` e dispara a **mesma**
 * re-resolucao (`HandoffDeCanal.aoErroDeReproducao`), sob o mesmo teto.
 *
 * Dispara uma unica vez por stall; so volta a poder disparar depois de um
 * avanco real. Pausa voluntaria nunca conta, e retomar da carencia.
 */
class WatchdogDeStall(private val limiarMs: Long = 7_000) {
    private var iniciado = false
    private var ultimaPosicaoMs = -1L
    private var ultimoAvancoMs = 0L
    private var pausado = false
    private var disparado = false

    fun progrediu(posicaoMs: Long, agoraMs: Long) {
        if (!iniciado) {
            iniciado = true
            ultimaPosicaoMs = posicaoMs
            ultimoAvancoMs = agoraMs
            disparado = false
            return
        }
        if (kotlin.math.abs(posicaoMs - ultimaPosicaoMs) > EPSILON_MS) {
            ultimaPosicaoMs = posicaoMs
            ultimoAvancoMs = agoraMs
            disparado = false
        }
    }

    fun definirPausado(p: Boolean, agoraMs: Long) {
        pausado = p
        if (!p) {
            ultimoAvancoMs = agoraMs
            disparado = false
        }
    }

    fun deveReresolver(agoraMs: Long): Boolean {
        if (pausado || !iniciado || disparado) return false
        if (agoraMs - ultimoAvancoMs >= limiarMs) {
            disparado = true
            return true
        }
        return false
    }

    private companion object {
        const val EPSILON_MS = 20L
    }
}
