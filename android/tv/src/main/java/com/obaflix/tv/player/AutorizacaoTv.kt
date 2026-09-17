package com.obaflix.tv.player

/**
 * Autorizacao de reproducao na televisao, e a sessao promocional.
 *
 * ## Quem decide
 *
 * O servidor. A TV pergunta a `/api/playback/authorize` antes de abrir o player,
 * e cada resposta vira uma `DecisaoDeReproducao`. Nada aqui libera conteudo: a
 * credencial que sai de `Liberada` e consumida por `/api/player/fontes`, que e a
 * autoridade final e recusa sem ela.
 *
 * ## A promocao
 *
 * Conta gratuita recebe `PROMOCAO_TV_NECESSARIA`. O caminho, todo validado no
 * servidor:
 *
 * ```text
 * /ads/promocao/iniciar → video → fim real do player → escolha final
 *        → (Continuar gratis) → /ads/complete → concessao → /player/fontes
 * ```
 *
 * Todo inicio de filme ou episodio de conta gratuita passa pelo video — o
 * servidor emite um desafio por reproducao, e a TV nao pergunta antes. O fim do
 * video **nao libera sozinho**: para na escolha final (planos ou continuar
 * gratis), e so "Continuar gratis" pede a conclusao.
 *
 * O fim do video dispara a conclusao, mas **nao e prova de nada sozinho**: o
 * servidor so emite concessao se entre o inicio que ELE gravou e a conclusao
 * passou a duracao que ELE configurou, e se o aparelho e o mesmo.
 *
 * ## Por que puro
 *
 * O mapeamento de resposta e a maquina de etapas sao onde uma regra errada
 * liberaria conteudo — "erro de rede vira liberado", "fim do video sem ter
 * iniciado vira conclusao". Separados da tela, sao testados em JVM, sem
 * composicao, sem rede e sem player.
 */

// ── Respostas do servidor ────────────────────────────────────────────────────

sealed interface DecisaoDeReproducao {
    /** Pode abrir. `credencial` e o passe ou a concessao; `null` para assinante. */
    data class Liberada(val credencial: String?) : DecisaoDeReproducao
    data class PromocaoObrigatoria(val desafioId: String) : DecisaoDeReproducao
    /** O plano da conta nao alcanca este conteudo. */
    data object ForaDoPlano : DecisaoDeReproducao
    /** Promocao sem configuracao, ou meio indisponivel. Nao libera. */
    data object GratuitoIndisponivel : DecisaoDeReproducao
    data object ConteudoInexistente : DecisaoDeReproducao
    data object SemSessao : DecisaoDeReproducao
    /** Rede, 5xx, resposta que nao se entende. Recuperavel; nunca libera. */
    data object FalhaTemporaria : DecisaoDeReproducao
}

private val ID_OPACO = Regex("^[A-Za-z0-9_-]{1,64}$")

/** O id, se tiver a forma de um id emitido pelo servidor. */
fun idOpaco(valor: String?): String? = valor?.takeIf { ID_OPACO.matches(it) }

/**
 * Traduz a resposta de `/api/playback/authorize`.
 *
 * O desconhecido cai em `FalhaTemporaria`, nunca em `Liberada`: uma decisao nova
 * do servidor que esta versao nao conhece nao pode virar reproducao.
 * `ANUNCIO_NECESSARIO` e anuncio externo do celular — a TV nao o exibe, e o
 * servidor nao o manda para credencial de TV; se chegar, e recusa.
 */
fun interpretarAutorizacao(
    status: Int,
    decisao: String?,
    codigo: String?,
    passe: String?,
    desafioId: String?,
): DecisaoDeReproducao = when (status) {
    200 -> when (decisao) {
        "PERMITIDO" -> DecisaoDeReproducao.Liberada(idOpaco(passe))
        "PROMOCAO_TV_NECESSARIA" ->
            idOpaco(desafioId)?.let { DecisaoDeReproducao.PromocaoObrigatoria(it) }
                ?: DecisaoDeReproducao.FalhaTemporaria
        "NEGADO" ->
            if (codigo == "conteudo_indisponivel_no_plano") DecisaoDeReproducao.ForaDoPlano
            else DecisaoDeReproducao.GratuitoIndisponivel
        "ANUNCIO_INDISPONIVEL", "ANUNCIO_NECESSARIO" -> DecisaoDeReproducao.GratuitoIndisponivel
        else -> DecisaoDeReproducao.FalhaTemporaria
    }
    401 -> DecisaoDeReproducao.SemSessao
    404 -> DecisaoDeReproducao.ConteudoInexistente
    else -> DecisaoDeReproducao.FalhaTemporaria
}

sealed interface InicioDaPromocaoTv {
    data class Iniciada(val videoUrl: String, val duracaoSeg: Int?) : InicioDaPromocaoTv
    /** Desafio vencido, consumido ou recusado: pedir autorizacao de novo. */
    data object Expirada : InicioDaPromocaoTv
    data object SemSessao : InicioDaPromocaoTv
    data object FalhaTemporaria : InicioDaPromocaoTv
}

fun interpretarInicio(status: Int, videoUrl: String?, duracaoSeg: Int?): InicioDaPromocaoTv = when (status) {
    200 ->
        if (videoUrl != null && videoUrl.startsWith("https://")) {
            InicioDaPromocaoTv.Iniciada(videoUrl, duracaoSeg?.takeIf { it > 0 })
        } else {
            InicioDaPromocaoTv.FalhaTemporaria
        }
    401 -> InicioDaPromocaoTv.SemSessao
    403, 404 -> InicioDaPromocaoTv.Expirada
    else -> InicioDaPromocaoTv.FalhaTemporaria
}

sealed interface ConclusaoDaPromocao {
    data class Concedida(val concessao: String) : ConclusaoDaPromocao
    /** O servidor nao aceitou a conclusao. Nada foi liberado. */
    data object Recusada : ConclusaoDaPromocao
    data object SemSessao : ConclusaoDaPromocao
    data object FalhaTemporaria : ConclusaoDaPromocao
}

fun interpretarConclusao(status: Int, concessao: String?): ConclusaoDaPromocao = when (status) {
    200 -> idOpaco(concessao)?.let { ConclusaoDaPromocao.Concedida(it) } ?: ConclusaoDaPromocao.FalhaTemporaria
    401 -> ConclusaoDaPromocao.SemSessao
    403, 404 -> ConclusaoDaPromocao.Recusada
    else -> ConclusaoDaPromocao.FalhaTemporaria
}

/**
 * O player chegou ao fim de verdade?
 *
 * `STATE_ENDED` so e aceito com duracao conhecida e a posicao no fim. Um
 * `ENDED` com duracao zero, ou longe do fim, e midia truncada ou estado
 * inconsistente — e vira falha de video, nao conclusao. O servidor recusaria a
 * conclusao antecipada de qualquer forma; filtrar aqui evita queimar o desafio.
 */
fun terminouDeVerdade(posicaoMs: Long, duracaoMs: Long): Boolean =
    duracaoMs > 0 && posicaoMs >= duracaoMs - FOLGA_DO_FIM_MS

const val FOLGA_DO_FIM_MS = 1_500L

/** O que `/api/player/fontes` respondeu para a abertura da sessao. */
sealed interface AberturaDeFontes {
    data class Aberta(val sessao: SessaoFontes) : AberturaDeFontes
    /** 403. `codigo` diz se e plano ou autorizacao ausente/vencida. */
    data class Recusada(val codigo: String?) : AberturaDeFontes
    data object SemSessao : AberturaDeFontes
    data object Falhou : AberturaDeFontes
}

// ── Etapas ───────────────────────────────────────────────────────────────────

sealed interface EtapaDaReproducao {
    data object Autorizando : EtapaDaReproducao
    data class IniciandoPromocao(val desafioId: String) : EtapaDaReproducao
    data class Promocao(val desafioId: String, val videoUrl: String) : EtapaDaReproducao
    /**
     * O video terminou de verdade; a pessoa escolhe entre os planos e continuar
     * gratis. `videoUrl` mantem o player (e o ultimo quadro) vivo; `null` quando
     * a etapa e retomada na volta dos planos, sem player.
     */
    data class EscolhaFinal(val desafioId: String, val videoUrl: String?) : EtapaDaReproducao
    data class ConcluindoPromocao(val desafioId: String) : EtapaDaReproducao
    /** Unica etapa que abre o player do conteudo. */
    data class Liberada(val credencial: String?) : EtapaDaReproducao
    /** Recuperavel quando `retomar` existe; senao, so Voltar. */
    data class Falha(val motivo: MotivoDaFalha, val retomar: EtapaDaReproducao?) : EtapaDaReproducao
    data object ForaDoPlano : EtapaDaReproducao
    data object GratuitoIndisponivel : EtapaDaReproducao
    data object ConteudoInexistente : EtapaDaReproducao
    data object SemSessao : EtapaDaReproducao
    /** A pessoa saiu. A tela fecha a camada. */
    data object Saiu : EtapaDaReproducao
}

enum class MotivoDaFalha { Rede, VideoNaoCarregou, ConclusaoNaoConfirmada }

sealed interface EventoDaReproducao {
    data class Decidiu(val decisao: DecisaoDeReproducao) : EventoDaReproducao
    data class PromocaoIniciou(val inicio: InicioDaPromocaoTv) : EventoDaReproducao
    /** `STATE_ENDED` que passou por `terminouDeVerdade`. */
    data object VideoTerminou : EventoDaReproducao
    data object VideoFalhou : EventoDaReproducao
    /** OK em "Continuar gratis" na escolha final. Unico caminho para a conclusao. */
    data object EscolheuContinuarGratis : EventoDaReproducao
    data class PromocaoConcluiu(val conclusao: ConclusaoDaPromocao) : EventoDaReproducao
    data object TentouDeNovo : EventoDaReproducao
    data object Voltou : EventoDaReproducao
}

/**
 * Onde a camada comeca.
 *
 *  - `escolhaPendente`: a pessoa foi aos planos a partir da escolha final e
 *    voltou — retoma a escolha do mesmo desafio, sem outro video;
 *  - `previa`: o episodio seguinte ja trouxe a decisao — o video comeca direto;
 *  - senao, pergunta ao servidor.
 */
fun etapaInicial(
    previa: DecisaoDeReproducao.PromocaoObrigatoria?,
    escolhaPendente: String? = null,
): EtapaDaReproducao = when {
    escolhaPendente != null -> EtapaDaReproducao.EscolhaFinal(escolhaPendente, videoUrl = null)
    previa != null -> EtapaDaReproducao.IniciandoPromocao(previa.desafioId)
    else -> EtapaDaReproducao.Autorizando
}

/**
 * A transicao. Funcao total e pura.
 *
 * Todo evento fora da etapa em que faz sentido e **ignorado** — a etapa fica
 * como estava. E o que impede, por exemplo, um `VideoTerminou` atrasado de um
 * player ja descartado concluir uma promocao que nem comecou, ou uma resposta de
 * rede antiga liberar a reproducao depois de a pessoa ter voltado.
 *
 * Invariantes que os testes travam:
 *
 *  - `Liberada` so nasce de `Decidiu(Liberada)` em `Autorizando`, ou de
 *    `PromocaoConcluiu(Concedida)` em `ConcluindoPromocao`;
 *  - `ConcluindoPromocao` so nasce de `EscolheuContinuarGratis` na escolha
 *    final, que so nasce de `VideoTerminou` — o fim do video, sozinho, para;
 *  - Voltar durante a promocao nunca libera: cancela a tentativa e sai;
 *  - erro de rede, de video ou de conclusao nunca libera.
 */
fun avancar(etapa: EtapaDaReproducao, evento: EventoDaReproducao): EtapaDaReproducao = when (evento) {
    is EventoDaReproducao.Voltou -> when (etapa) {
        // Sair no meio da promocao cancela a tentativa: o desafio fica para tras
        // e vence sozinho no servidor. Perguntar de novo reabriria outro video
        // em vez de devolver a pessoa de onde ela veio.
        // Liberada: o player do conteudo cuida do proprio BACK.
        is EtapaDaReproducao.Liberada -> etapa
        else -> EtapaDaReproducao.Saiu
    }

    is EventoDaReproducao.Decidiu ->
        if (etapa !is EtapaDaReproducao.Autorizando) etapa
        else when (val d = evento.decisao) {
            is DecisaoDeReproducao.Liberada -> EtapaDaReproducao.Liberada(d.credencial)
            is DecisaoDeReproducao.PromocaoObrigatoria -> EtapaDaReproducao.IniciandoPromocao(d.desafioId)
            DecisaoDeReproducao.ForaDoPlano -> EtapaDaReproducao.ForaDoPlano
            DecisaoDeReproducao.GratuitoIndisponivel -> EtapaDaReproducao.GratuitoIndisponivel
            DecisaoDeReproducao.ConteudoInexistente -> EtapaDaReproducao.ConteudoInexistente
            DecisaoDeReproducao.SemSessao -> EtapaDaReproducao.SemSessao
            DecisaoDeReproducao.FalhaTemporaria ->
                EtapaDaReproducao.Falha(MotivoDaFalha.Rede, retomar = EtapaDaReproducao.Autorizando)
        }

    is EventoDaReproducao.PromocaoIniciou ->
        if (etapa !is EtapaDaReproducao.IniciandoPromocao) etapa
        else when (val i = evento.inicio) {
            is InicioDaPromocaoTv.Iniciada -> EtapaDaReproducao.Promocao(etapa.desafioId, i.videoUrl)
            InicioDaPromocaoTv.Expirada -> EtapaDaReproducao.Autorizando
            InicioDaPromocaoTv.SemSessao -> EtapaDaReproducao.SemSessao
            // Repetir o inicio e seguro: o servidor mantem o instante original.
            InicioDaPromocaoTv.FalhaTemporaria -> EtapaDaReproducao.Falha(MotivoDaFalha.Rede, retomar = etapa)
        }

    is EventoDaReproducao.VideoTerminou ->
        if (etapa is EtapaDaReproducao.Promocao) EtapaDaReproducao.EscolhaFinal(etapa.desafioId, etapa.videoUrl) else etapa

    is EventoDaReproducao.EscolheuContinuarGratis ->
        if (etapa is EtapaDaReproducao.EscolhaFinal) EtapaDaReproducao.ConcluindoPromocao(etapa.desafioId) else etapa

    is EventoDaReproducao.VideoFalhou ->
        if (etapa is EtapaDaReproducao.Promocao) {
            EtapaDaReproducao.Falha(
                MotivoDaFalha.VideoNaoCarregou,
                retomar = EtapaDaReproducao.IniciandoPromocao(etapa.desafioId),
            )
        } else {
            etapa
        }

    is EventoDaReproducao.PromocaoConcluiu ->
        if (etapa !is EtapaDaReproducao.ConcluindoPromocao) etapa
        else when (val c = evento.conclusao) {
            is ConclusaoDaPromocao.Concedida -> EtapaDaReproducao.Liberada(c.concessao)
            ConclusaoDaPromocao.SemSessao -> EtapaDaReproducao.SemSessao
            // Recusa ou rede: nada liberado. Tentar de novo volta a perguntar —
            // se a conclusao tinha passado no servidor, a marca de pago devolve
            // passe sem outra promocao; se nao, abre-se outra.
            ConclusaoDaPromocao.Recusada, ConclusaoDaPromocao.FalhaTemporaria ->
                EtapaDaReproducao.Falha(MotivoDaFalha.ConclusaoNaoConfirmada, retomar = EtapaDaReproducao.Autorizando)
        }

    is EventoDaReproducao.TentouDeNovo ->
        if (etapa is EtapaDaReproducao.Falha && etapa.retomar != null) etapa.retomar else etapa
}
