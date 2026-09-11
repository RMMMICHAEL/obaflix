package com.obaflix.tv.catalogo

/**
 * Modelos do catalogo.
 *
 * Sao os mesmos campos que o site ja publica; nada aqui e calculado no
 * aparelho a nao ser o que so a televisao usa (fracao de progresso, rotulo de
 * episodio). O que o backend nao devolve nao existe nesta tela — nenhuma
 * secao e inventada para preencher espaco.
 */

data class Genero(val id: Int, val nome: String)

data class Item(
    val id: String,
    val titulo: String,
    val poster: String?,
    val background: String?,
    val logo: String?,
    val sinopse: String?,
    val ano: Int?,
    val nota: Double?,
    /** "filme", "serie", "anime" ou "desenho". */
    val tipo: String,
    val generos: List<Genero> = emptyList(),
    /** Preenchidos so em Continuar Assistindo. */
    val progressoSeg: Int = 0,
    val duracaoSeg: Int? = null,
    val temporada: Int? = null,
    val numeroEp: Int? = null,
    val episodioId: String? = null,
    /** Id da entrada de histórico — usado no Perfil para remover o item. */
    val historyId: String? = null,
) {
    /** Serie, anime e desenho compartilham a mesma rota e o mesmo player. */
    val ehSerie: Boolean get() = tipo != "filme"

    /** Fracao assistida, para a barrinha do card. Zero quando nao se aplica. */
    val progresso: Float
        get() = if (duracaoSeg != null && duracaoSeg > 0) {
            (progressoSeg.toFloat() / duracaoSeg).coerceIn(0f, 1f)
        } else 0f

    val rotuloEpisodio: String?
        get() = if (temporada != null && numeroEp != null) "T$temporada E$numeroEp" else null

    val chaveProgresso: String get() = episodioId ?: id
}

data class Fileira(
    /** Estavel entre recargas: e a chave de foco e de rolagem restaurada. */
    val id: String,
    val titulo: String,
    val itens: List<Item>,
    val paisagem: Boolean = false,
)

data class Home(val destaques: List<Item>, val fileiras: List<Fileira>)

data class Episodio(
    val id: String,
    val serieId: String,
    val temporada: Int,
    val numeroEp: Int,
    val titulo: String?,
    val thumbnail: String?,
    /**
     * Se ha alguma fonte cadastrada. O servidor manda "disponivel" ou null em
     * vez da URL — o aparelho nunca ve endereco de provedor no catalogo.
     */
    val disponivel: Boolean,
) {
    val rotulo: String get() = titulo?.takeIf { it.isNotBlank() } ?: "Episódio $numeroEp"
}

/** Ficha completa. `episodios` so vem preenchida para serie. */
data class Detalhe(
    val item: Item,
    val temporadas: List<Int>,
    val episodios: List<Episodio>,
) {
    fun episodiosDa(temporada: Int): List<Episodio> = episodios.filter { it.temporada == temporada }
}

/** Uma pagina de catalogo filtrado. */
data class Pagina(val itens: List<Item>, val pagina: Int, val paginas: Int) {
    val temMais: Boolean get() = pagina < paginas
}

// ── Canais ao vivo ───────────────────────────────────────────────────────────

/**
 * Um canal, do jeito que o aparelho o conhece.
 *
 * Nao ha campo de URL, e nao deve passar a haver. O catalogo de canais devolve
 * so metadado publico; o endereco de midia aparece uma vez, na concessao, ja
 * apontando para o dominio de midia do Obaflix — nunca para o provedor.
 *
 * Tambem nao ha nivel nem cadeado. `/api/canais` devolve so o que esta conta
 * pode abrir — o recorte por entitlement e feito na consulta —, entao nao existe
 * canal bloqueado na grade para desenhar. Isso nao dispensa a checagem no OK: a
 * concessao decide do zero, porque um plano pode cair entre a listagem e o
 * toque.
 *
 * Tambem nao ha programa atual, proximo, horario nem progresso: nao existe
 * fonte confiavel de EPG nesta fase, e um horario inventado erra na tela de
 * quem esta olhando.
 */
data class CanalTv(
    val id: String,
    val slug: String,
    val nome: String,
    val categoria: String,
    val logoUrl: String?,
)

/** Uma categoria, com o rotulo que o servidor mandou. */
data class CategoriaDeCanal(val id: String, val rotulo: String)

data class CatalogoDeCanais(
    val canais: List<CanalTv>,
    val categorias: List<CategoriaDeCanal>,
)

/**
 * O resultado de pedir para reproduzir um canal.
 *
 * `Liberado` carrega a unica URL que o aparelho chega a ver. As recusas sao
 * separadas por tipo porque a tela responde de forma diferente a cada uma — e
 * nenhuma delas carrega motivo tecnico, host ou status do provedor.
 */
sealed interface Concessao {
    /**
     * `sessionId` volta no corpo da proxima chamada, para renovar sem o servidor
     * precisar buscar o provedor de novo. Nao e credencial: sozinho nao abre
     * nada, porque a URL de midia exige assinatura e renovar exige a sessao
     * autenticada do dono.
     *
     * `validoPorSegundos` e curto de proposito. O aparelho volta ao backend
     * antes de vencer, e nessa volta o servidor reconfere entitlement e gira o
     * nonce — o que derruba na hora as URLs emitidas antes.
     */
    data class Liberado(
        val manifestUrl: String,
        val sessionId: String,
        /**
         * Numero da geracao, monotonico, vindo do servidor.
         *
         * E o que permite recusar uma resposta antiga que chegou atrasada: duas
         * renovacoes concorrentes nao tem ordem de chegada garantida, e adotar
         * a que chegar por ultimo faria o aparelho REGREDIR para uma geracao
         * que o servidor ja aposentou.
         */
        val geracao: Int,
        val expiraEm: Long,
        val validoPorSegundos: Int,
    ) : Concessao
    /** Plano nao alcanca. `nivelExigido` e o que a tela mostra. */
    data class PrecisaDeUpgrade(val nivelExigido: String?) : Concessao
    /** Sessao caiu. A raiz volta ao pareamento. */
    data object SemSessao : Concessao
    /** Canal fora do ar, inexistente ou adulto. Indistinguiveis de proposito. */
    data object Indisponivel : Concessao
    /** Falha temporaria: rede, provedor fora, limite de tentativas. */
    data object FalhaTemporaria : Concessao
}
