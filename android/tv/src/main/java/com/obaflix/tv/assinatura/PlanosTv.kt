package com.obaflix.tv.assinatura

/**
 * A vitrine de planos na televisao, e os estados dos cards.
 *
 * ## Nada comercial mora no APK
 *
 * Nome, selo, tema, beneficios e precos chegam de `GET /api/billing/plans` — a
 * mesma resposta que a pagina `/planos` e o checkout usam. Beneficios sao
 * derivados dos direitos gravados em `Plano`; precos, das linhas ativas de
 * `PlanoPreco`. Trocar preco ou beneficio nao exige APK novo, e a TV nao tem como
 * anunciar algo diferente do que o checkout cobra.
 *
 * ## Apresentacao, nao autorizacao
 *
 * Os estados dos cards comparam o id do plano atual (de `/api/billing/me`) com o
 * id de cada card — para desenhar, nunca para liberar. Cada acao protegida volta
 * a perguntar ao servidor.
 *
 * Puro, sem Android: testado em JVM.
 */

enum class TomDoPlano { Azul, Roxo, Ambar, Neutro }

data class Beneficio(val texto: String, val incluido: Boolean = true)

data class PrecoDoPlano(
    val id: String,
    val rotulo: String,
    /** Duracao em dias (ex.: 30) ou `null` quando o servidor usa meses de calendario. */
    val duracaoDias: Int?,
    val precoCentavos: Int,
    val moeda: String,
    /** Meses de calendario (5, 12). Exatamente um dos dois vem preenchido. */
    val duracaoMeses: Int? = null,
) {
    /** So para ordenar: meses contam como 30 dias. Nunca usado em calculo de valor. */
    val duracaoAproximadaEmDias: Int get() = duracaoDias ?: ((duracaoMeses ?: 0) * 30)
}

data class PlanoTv(
    /** O id do plano no servidor. So para casar com a conta; nunca autoriza. */
    val id: String,
    val nome: String,
    val selo: String?,
    val tom: TomDoPlano,
    val beneficios: List<Beneficio>,
    val precos: List<PrecoDoPlano>,
) {
    /** Sem preco ativo no servidor, o checkout recusaria. A TV nao oferece. */
    val compravel: Boolean get() = precos.isNotEmpty()

    /** A menor duracao disponivel — a que o card mostra. As outras ficam no checkout. */
    val precoDeEntrada: PrecoDoPlano? get() = precos.minByOrNull { it.duracaoAproximadaEmDias }
}

fun tomDoTema(tema: String?): TomDoPlano = when (tema) {
    "azul" -> TomDoPlano.Azul
    "roxo" -> TomDoPlano.Roxo
    "ambar" -> TomDoPlano.Ambar
    else -> TomDoPlano.Neutro
}

/**
 * Os planos oferecidos na TV: os que o servidor apresenta com tema.
 *
 * O gratuito vem sem tema e nao vira card — ninguem assina o gratuito.
 */
fun planosDaVitrine(todos: List<PlanoTv>): List<PlanoTv> = todos.filter { it.tom != TomDoPlano.Neutro }

/** "R$ 19,90", "R$ 1.234,50". Moeda desconhecida sai com o codigo, sem simbolo inventado. */
fun formatarPreco(centavos: Int, moeda: String): String {
    val reais = centavos / 100
    val resto = (centavos % 100).toString().padStart(2, '0')
    val milhares = reais.toString().reversed().chunked(3).joinToString(".").reversed()
    return (if (moeda == "BRL") "R$ " else "$moeda ") + milhares + "," + resto
}

/** O que a conta oficial diz sobre o plano. Vem de `/api/billing/me`. */
data class ContaDoPlano(val planoId: String?, val assinaturaAtiva: Boolean)

enum class AcaoDoPlano(val rotulo: String?, val acionavel: Boolean) {
    Assinar("Assinar", true),
    FazerUpgrade("Fazer upgrade", true),
    /** O servidor nao tem preco ativo para o plano: nada a oferecer agora. */
    Indisponivel("Indisponível no momento", false),
    /** Plano atual, ou abaixo dele: downgrade nao e oferecido nesta etapa. */
    Nenhuma(null, false),
}

data class CardDePlano(
    val plano: PlanoTv,
    /** 1, 2, 3 — desenhado como marcador, para o plano nao ser identificado so pela cor. */
    val nivel: Int,
    val atual: Boolean,
    val acao: AcaoDoPlano,
) {
    val selo: String? get() = if (atual) "Plano atual" else plano.selo
}

/**
 * Os cards para esta conta.
 *
 *  - gratuita: "Assinar" em todos;
 *  - Basico: Basico atual; superiores com "Fazer upgrade";
 *  - Plus: Plus atual; Premium com "Fazer upgrade"; Basico sem acao;
 *  - Premium: Premium atual, sem acao;
 *  - plano sem preco ativo: "Indisponivel no momento", sem acao.
 *
 * Assinatura ativa num plano que a vitrine nao conhece (cortesia, interno) nao
 * ganha "Assinar": a pessoa ja assina.
 */
fun cardsDosPlanos(planos: List<PlanoTv>, conta: ContaDoPlano): List<CardDePlano> {
    val vitrine = planosDaVitrine(planos)
    val indiceAtual = vitrine.indexOfFirst { it.id == conta.planoId }

    return vitrine.mapIndexed { i, plano ->
        val base = when {
            indiceAtual < 0 -> if (conta.assinaturaAtiva) AcaoDoPlano.Nenhuma else AcaoDoPlano.Assinar
            i > indiceAtual -> AcaoDoPlano.FazerUpgrade
            else -> AcaoDoPlano.Nenhuma
        }
        CardDePlano(
            plano = plano,
            nivel = i + 1,
            atual = i == indiceAtual,
            acao = if (base.acionavel && !plano.compravel) AcaoDoPlano.Indisponivel else base,
        )
    }
}

/**
 * Onde o cursor nasce.
 *
 * Sem plano atual na vitrine, no card de selo roxo ("Mais escolhido") — ou no do
 * meio, se o servidor nao marcar nenhum. Assinante comeca no primeiro upgrade;
 * sem upgrade, no plano atual.
 */
fun focoInicialDosPlanos(cards: List<CardDePlano>): Int {
    if (cards.isEmpty()) return 0
    val atual = cards.indexOfFirst { it.atual }
    if (atual < 0) {
        val recomendado = cards.indexOfFirst { it.plano.tom == TomDoPlano.Roxo }
        return if (recomendado >= 0) recomendado else cards.size / 2
    }
    val primeiroUpgrade = cards.indexOfFirst { it.acao == AcaoDoPlano.FazerUpgrade }
    return if (primeiroUpgrade >= 0) primeiroUpgrade else atual
}

/** O foco salvo, se ainda cabe na lista; senao, o inicial. */
fun focoDosPlanos(salvo: Int?, cards: List<CardDePlano>): Int =
    if (salvo != null && salvo in cards.indices) salvo else focoInicialDosPlanos(cards)

/**
 * O card vizinho por D-pad. Nas pontas o cursor para — nao da a volta.
 */
fun cardVizinho(indice: Int, passo: Int, total: Int): Int =
    if (total <= 0) 0 else (indice + passo).coerceIn(0, total - 1)
