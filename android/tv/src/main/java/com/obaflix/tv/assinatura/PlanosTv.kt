package com.obaflix.tv.assinatura

/**
 * A vitrine de planos da televisao, e os estados dos cards.
 *
 * ## O que este arquivo e, e o que ele nao e
 *
 * E **apresentacao**: texto, preco exibido, cor e selo de cada card, e qual acao
 * cada card oferece para a conta que esta olhando. Nao autoriza nada. Quem decide
 * se uma conta reproduz sem promocao, abre canal ou recebe qualquer beneficio e o
 * servidor, pelos direitos do plano — e cada acao protegida volta a perguntar a
 * ele. Um card mostrando "Plano atual" nao libera um byte.
 *
 * Por isso aqui pode existir comparacao por id de plano: e para escolher o card
 * destacado, nunca para liberar recurso. O plano atual vem de `/api/billing/me`,
 * a conta oficial.
 *
 * Puro, sem Android: testado em JVM.
 */

enum class TomDoPlano { Azul, Roxo, Ambar }

data class Beneficio(val texto: String, val incluido: Boolean = true)

data class PlanoTv(
    /** O id do plano no servidor. So para casar com a conta; nunca autoriza. */
    val id: String,
    val nome: String,
    val preco: String,
    val periodo: String,
    val selo: String?,
    val tom: TomDoPlano,
    /**
     * Mesma ordem nos tres cards — telas, qualidade, catalogo, canais, anuncios,
     * downloads, servidor VIP, suporte —, para as linhas se alinharem e a
     * comparacao se fazer com o olho, sem tabela.
     */
    val beneficios: List<Beneficio>,
)

object CatalogoDePlanosTv {

    val BASICO = PlanoTv(
        id = "basic",
        nome = "Básico",
        preco = "R$ 10",
        periodo = "30 dias",
        selo = null,
        tom = TomDoPlano.Azul,
        beneficios = listOf(
            Beneficio("2 telas"),
            Beneficio("Qualidade HD"),
            Beneficio("Filmes e séries incluídos"),
            Beneficio("Canais de TV não incluídos", incluido = false),
            Beneficio("Sem anúncios após assinar"),
            Beneficio("Downloads com anúncio"),
            // Opcional, e nada mais: a contratacao adicional nao existe nesta
            // versao e nao e oferecida como compra.
            Beneficio("Servidor VIP opcional"),
        ),
    )

    val PLUS = PlanoTv(
        id = "plus",
        nome = "Plus",
        preco = "R$ 19,90",
        periodo = "30 dias",
        selo = "Mais escolhido",
        tom = TomDoPlano.Roxo,
        beneficios = listOf(
            Beneficio("2 telas"),
            Beneficio("Qualidade Full HD"),
            Beneficio("Filmes e séries incluídos"),
            Beneficio("Canais de TV incluídos"),
            Beneficio("Sem anúncios"),
            Beneficio("Downloads sem anúncios"),
            Beneficio("Servidor VIP incluso"),
            Beneficio("Suporte"),
        ),
    )

    val PREMIUM = PlanoTv(
        id = "premium",
        nome = "Premium",
        preco = "R$ 29,90",
        periodo = "30 dias",
        selo = "Experiência completa",
        tom = TomDoPlano.Ambar,
        beneficios = listOf(
            Beneficio("2 telas"),
            Beneficio("Qualidade até 4K"),
            Beneficio("Filmes e séries incluídos"),
            Beneficio("Canais de TV incluídos"),
            Beneficio("Sem anúncios"),
            Beneficio("Downloads sem anúncios"),
            Beneficio("Servidor VIP incluso"),
            Beneficio("Suporte prioritário"),
        ),
    )

    /** Do mais simples ao mais completo. A ordem e a escada do upgrade. */
    val TODOS: List<PlanoTv> = listOf(BASICO, PLUS, PREMIUM)

    fun porId(id: String?): PlanoTv? = TODOS.firstOrNull { it.id == id }
}

/** O que a conta oficial diz sobre o plano. Vem de `/api/billing/me`. */
data class ContaDoPlano(val planoId: String?, val assinaturaAtiva: Boolean)

enum class AcaoDoPlano(val rotulo: String?) {
    Assinar("Assinar"),
    FazerUpgrade("Fazer upgrade"),
    /** Plano atual, ou abaixo dele: downgrade nao e oferecido nesta etapa. */
    Nenhuma(null),
}

data class CardDePlano(val plano: PlanoTv, val atual: Boolean, val acao: AcaoDoPlano) {
    /** "Plano atual" vence o selo comercial: e a informacao que a pessoa procura. */
    val selo: String? get() = if (atual) "Plano atual" else plano.selo
}

/**
 * Os tres cards para esta conta.
 *
 *  - gratuita: "Assinar" em todos;
 *  - Basico: Basico atual; Plus e Premium com "Fazer upgrade";
 *  - Plus: Plus atual; Premium com "Fazer upgrade"; Basico sem acao;
 *  - Premium: Premium atual, sem acao em nenhum card.
 *
 * Assinatura ativa num plano que esta vitrine nao conhece (cortesia, plano
 * interno) nao ganha "Assinar": a pessoa ja tem assinatura, e oferecer compra
 * seria errado. Os cards ficam informativos.
 */
fun cardsDosPlanos(conta: ContaDoPlano): List<CardDePlano> {
    val planos = CatalogoDePlanosTv.TODOS
    val indiceAtual = planos.indexOfFirst { it.id == conta.planoId }

    if (indiceAtual < 0) {
        val acao = if (conta.assinaturaAtiva) AcaoDoPlano.Nenhuma else AcaoDoPlano.Assinar
        return planos.map { CardDePlano(it, atual = false, acao = acao) }
    }

    return planos.mapIndexed { i, plano ->
        CardDePlano(
            plano = plano,
            atual = i == indiceAtual,
            acao = if (i > indiceAtual) AcaoDoPlano.FazerUpgrade else AcaoDoPlano.Nenhuma,
        )
    }
}

/**
 * Onde o cursor nasce.
 *
 * Conta gratuita comeca no Plus — o selo "Mais escolhido" e a recomendacao, e o
 * card do meio deixa uma seta para cada lado. Assinante comeca no primeiro
 * upgrade; sem upgrade, no plano atual.
 */
fun focoInicialDosPlanos(cards: List<CardDePlano>): Int {
    if (cards.isEmpty()) return 0
    if (cards.all { it.acao == AcaoDoPlano.Assinar }) {
        return cards.indexOfFirst { it.plano.id == CatalogoDePlanosTv.PLUS.id }.coerceAtLeast(0)
    }
    val primeiroUpgrade = cards.indexOfFirst { it.acao == AcaoDoPlano.FazerUpgrade }
    if (primeiroUpgrade >= 0) return primeiroUpgrade
    return cards.indexOfFirst { it.atual }.coerceAtLeast(0)
}

/** O foco salvo, se ainda cabe na lista; senao, o inicial. */
fun focoDosPlanos(salvo: Int?, cards: List<CardDePlano>): Int =
    if (salvo != null && salvo in cards.indices) salvo else focoInicialDosPlanos(cards)

/**
 * O card vizinho por D-pad. Nas pontas o cursor para — nao da a volta.
 *
 * Dar a volta faria a seta para a direita no Premium cair no Basico, e quem
 * segura a seta perderia a nocao de onde esta.
 */
fun cardVizinho(indice: Int, passo: Int, total: Int): Int =
    if (total <= 0) 0 else (indice + passo).coerceIn(0, total - 1)
