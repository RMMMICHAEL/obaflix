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
 * ## A limitacao de hoje, dita com clareza
 *
 * `/planos` e `/checkout` existem, mas o site de streaming e fechado para
 * navegador comum (`src/config/site-mode.ts`): quem abre o endereco num
 * navegador cai na pagina de download do aplicativo. A assinatura, hoje, e
 * concluida no aplicativo Obaflix do celular, logado na mesma conta. A tela diz
 * exatamente isso, e nao promete checkout no navegador.
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

/** O resolvedor de hoje: a pagina de planos do Obaflix, sem nada da conta. */
class LinkDaPaginaDePlanos(private val baseUrl: String) : ResolvedorDeLinkDeAssinatura {
    override suspend fun resolver(plano: PlanoTv): LinkDeAssinatura? = linkDaPaginaDePlanos(baseUrl)
}

const val CAMINHO_DOS_PLANOS = "/planos"

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

/** O link fixo para `baseUrl`. `null` se a base nao for https. */
fun linkDaPaginaDePlanos(baseUrl: String): LinkDeAssinatura? {
    val base = runCatching { URI(baseUrl.trim().trimEnd('/')) }.getOrNull() ?: return null
    val host = base.host
    if (base.scheme != "https" || host.isNullOrBlank() || base.userInfo != null) return null

    val porta = if (base.port > 0 && base.port != 443) ":" + base.port else ""
    val link = LinkDeAssinatura(
        urlDoQr = "https://" + host + porta + CAMINHO_DOS_PLANOS,
        enderecoLegivel = host.removePrefix("www.") + porta + CAMINHO_DOS_PLANOS,
    )
    return link.takeIf { podeIrParaQr(it.urlDoQr) }
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
