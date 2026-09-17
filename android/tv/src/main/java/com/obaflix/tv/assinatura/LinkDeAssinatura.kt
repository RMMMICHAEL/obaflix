package com.obaflix.tv.assinatura

import java.net.URI

/**
 * Para onde a TV manda a pessoa continuar a assinatura.
 *
 * ## Apresentacao separada da resolucao
 *
 * A tela de continuacao so conhece `LinkDeAssinatura`: um endereco para o QR e
 * um texto curto para digitar. Quem produz o link e um `ResolvedorDeLinkDeAssinatura`.
 * Hoje o resolvedor devolve a pagina de planos que ja existe. Quando o backend de
 * handoff existir, entra outro resolvedor — que pede ao servidor um link com
 * **token opaco de uso unico** — e a tela nao muda.
 *
 * ## Ponto de integracao pendente
 *
 * O contrato esperado do backend futuro, para o resolvedor que vira:
 *
 * ```text
 * POST /api/tv/assinatura/handoff   { planoId }         (Bearer da TV)
 * 200 { url, enderecoCurto, expiraEm }
 * ```
 *
 * `url` carrega so o token opaco (`?h=...`) — nunca o access token, o refresh
 * token, e-mail ou qualquer dado pessoal. `podeIrParaQr` ja recusa esses nomes.
 *
 * ## O fluxo de hoje
 *
 * `/planos`, `/checkout` e `/conta` abrem no navegador comum (`site-mode.ts`); o
 * resto do streaming web continua fechado. O QR leva a `/planos?plano=<id>`, a
 * pagina destaca o plano, "Assinar" vai ao checkout, e o checkout sem sessao
 * manda ao login — que volta ao mesmo checkout. Sem token de handoff, a pessoa
 * faz login normal no celular com a mesma conta da TV.
 */
data class LinkDeAssinatura(
    val urlDoQr: String,
    val enderecoLegivel: String,
    /** Quando o link deixa de valer. `null` para o link fixo de hoje. */
    val expiraEmMs: Long? = null,
)

fun interface ResolvedorDeLinkDeAssinatura {
    suspend fun resolver(plano: PlanoTv): LinkDeAssinatura?
}

/** O resolvedor de hoje: a pagina de planos do Obaflix, com o plano escolhido e nada da conta. */
class LinkDaPaginaDePlanos(private val baseUrl: String) : ResolvedorDeLinkDeAssinatura {
    override suspend fun resolver(plano: PlanoTv): LinkDeAssinatura? = linkDaPaginaDePlanos(baseUrl, plano.id)
}

/**
 * O resolvedor do caminho do anuncio: direto ao checkout do plano, na duracao do
 * preco de entrada que o card mostrou. Plano e preco vem de `/api/billing/plans`;
 * o APK nao conhece nenhum id.
 */
class LinkDoCheckoutDoPlano(
    private val baseUrl: String,
    private val preco: PrecoDoPlano,
) : ResolvedorDeLinkDeAssinatura {
    override suspend fun resolver(plano: PlanoTv): LinkDeAssinatura? =
        linkDoCheckoutDoPlano(baseUrl, plano.id, preco.id)
}

/**
 * Qual resolvedor a continuacao usa.
 *
 * `precoDoCheckout` so vem preenchido pelo caminho do anuncio; a vitrine de
 * planos continua na pagina de planos, como sempre.
 */
fun resolvedorDaContinuacao(baseUrl: String, precoDoCheckout: PrecoDoPlano?): ResolvedorDeLinkDeAssinatura =
    precoDoCheckout?.let { LinkDoCheckoutDoPlano(baseUrl, it) } ?: LinkDaPaginaDePlanos(baseUrl)

const val CAMINHO_DOS_PLANOS = "/planos"
const val CAMINHO_DO_CHECKOUT = "/checkout"

private val ID_DE_PLANO = Regex("^[a-z0-9_-]{1,32}$")
private val ID_DE_PRECO = Regex("^[A-Za-z0-9_-]{1,64}$")

/**
 * Nomes de parametro que nunca vao para um QR.
 *
 * O QR fica exposto na sala: qualquer camera o le. Credencial ou dado pessoal
 * ali seria entregue a quem estiver olhando a TV.
 */
private val PARAMETROS_PROIBIDOS = setOf(
    "token", "access_token", "refresh_token", "id_token", "authorization", "auth",
    "bearer", "session", "sessao", "sessionid", "senha", "password",
    "email", "e-mail", "cpf", "telefone", "phone", "userid", "user_id",
)

/**
 * O link para `baseUrl`, com o plano escolhido. `null` se a base nao for https.
 *
 * O QR leva `?plano=<id>` — so o id publico do plano, que a pagina usa para
 * destacar o card. O endereco legivel fica curto, sem o parametro: quem digita
 * escolhe o plano la.
 */
fun linkDaPaginaDePlanos(baseUrl: String, planoId: String? = null): LinkDeAssinatura? {
    val origem = origemHttps(baseUrl) ?: return null
    val consulta = planoId?.takeIf { ID_DE_PLANO.matches(it) }?.let { "?plano=$it" } ?: ""
    val link = LinkDeAssinatura(
        urlDoQr = "https://" + origem + CAMINHO_DOS_PLANOS + consulta,
        enderecoLegivel = origem.removePrefix("www.") + CAMINHO_DOS_PLANOS,
    )
    return link.takeIf { podeIrParaQr(it.urlDoQr) }
}

/**
 * O link direto ao checkout: `/checkout?planoId=<id>&planoPrecoId=<id>`, os
 * mesmos parametros que a pagina de planos usa ao clicar em Assinar. So ids
 * publicos — o checkout sem sessao manda ao login e volta ao mesmo endereco.
 *
 * `null` se a base nao for https ou um dos ids nao tiver forma de id: sem os
 * dois o checkout nao seleciona nada. O endereco legivel continua sendo a
 * pagina de planos: digitar a consulta com o controle nao e realista, e la a
 * pessoa escolhe o mesmo plano.
 */
fun linkDoCheckoutDoPlano(baseUrl: String, planoId: String, precoId: String): LinkDeAssinatura? {
    val origem = origemHttps(baseUrl) ?: return null
    if (!ID_DE_PLANO.matches(planoId) || !ID_DE_PRECO.matches(precoId)) return null
    val link = LinkDeAssinatura(
        urlDoQr = "https://" + origem + CAMINHO_DO_CHECKOUT + "?planoId=" + planoId + "&planoPrecoId=" + precoId,
        enderecoLegivel = origem.removePrefix("www.") + CAMINHO_DOS_PLANOS,
    )
    return link.takeIf { podeIrParaQr(it.urlDoQr) }
}

/** `host[:porta]` de uma base https sem usuario na URL; `null` para o resto. */
private fun origemHttps(baseUrl: String): String? {
    val base = runCatching { URI(baseUrl.trim().trimEnd('/')) }.getOrNull() ?: return null
    val host = base.host
    if (base.scheme != "https" || host.isNullOrBlank() || base.userInfo != null) return null
    val porta = if (base.port > 0 && base.port != 443) ":" + base.port else ""
    return host + porta
}

/**
 * Esta URL pode ser desenhada num QR?
 *
 * Exige https, recusa usuario/senha na URL, fragmento e qualquer parametro com
 * nome de credencial ou dado pessoal. Vale tambem para o link futuro com token de
 * handoff: um resolvedor novo que por engano mandasse o access token seria
 * recusado aqui, antes de chegar a tela.
 */
fun podeIrParaQr(url: String): Boolean {
    val uri = runCatching { URI(url) }.getOrNull() ?: return false
    if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null) return false
    if (uri.rawFragment != null) return false
    val nomes = uri.rawQuery
        ?.split("&")
        ?.map { it.substringBefore("=").lowercase() }
        .orEmpty()
    return nomes.none { it in PARAMETROS_PROIBIDOS }
}
