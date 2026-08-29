package com.obaflix.tv.catalogo

import android.content.Context
import com.obaflix.ObaflixApp
import com.obaflix.bridge.ObaLog
import com.obaflix.tv.BuildConfig
import com.obaflix.tv.sessao.PareamentoTv
import com.obaflix.tv.sessao.SessaoTv
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/**
 * Cliente do catalogo.
 *
 * Toda rota do Obaflix que a televisao consome passa por aqui. Duas regras
 * valem para todas:
 *
 *  1. **Renovacao transparente.** O access token vive 15 minutos e so em
 *     memoria. Em vez de espalhar tratamento de 401 por cada tela, a primeira
 *     resposta 401 dispara uma renovacao e a requisicao e refeita uma unica
 *     vez. Uma trava serializa isso: dez fileiras carregando juntas com o token
 *     vencido gastariam dez renovacoes e invalidariam o refresh das outras nove.
 *  2. **Nada de URL de provedor.** As rotas publicas ja devolvem so
 *     disponibilidade; o endereco real de midia so aparece na resolucao de uma
 *     fonte por vez, em FontesTv, e nunca e registrado em log.
 */
object ApiObaflix {

    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val travaRenovacao = Mutex()

    @Volatile
    private var contexto: Context? = null

    /** Chamada uma vez na abertura, com o contexto de aplicacao. */
    fun instalar(context: Context) {
        contexto = context.applicationContext
    }

    // ── Imagens ──────────────────────────────────────────────────────────────

    /**
     * O catalogo mistura caminho do TMDB e URL completa no mesmo campo — depende
     * de qual sincronizacao gravou o registro. Resolver aqui evita espalhar esse
     * detalhe por cada tela.
     */
    fun imagem(caminho: String?, tamanho: String = "w500"): String? {
        if (caminho.isNullOrBlank() || caminho == "null") return null
        if (caminho.startsWith("http")) return caminho
        return "https://image.tmdb.org/t/p/" + tamanho + caminho
    }

    // ── Transporte ───────────────────────────────────────────────────────────

    private fun requisicao(caminho: String, corpo: JSONObject?, corpoDelete: Boolean): Request =
        Request.Builder()
            .url(BuildConfig.OBAFLIX_URL + caminho)
            .header("User-Agent", SessaoTv.userAgent)
            .apply {
                SessaoTv.accessToken()?.let { header("Authorization", "Bearer " + it) }
                when {
                    corpoDelete && corpo != null -> delete(corpo.toString().toRequestBody(JSON))
                    corpoDelete -> delete()
                    corpo != null -> post(corpo.toString().toRequestBody(JSON))
                    else -> get()
                }
            }
            .build()

    private data class Resposta(val status: Int, val corpo: String?)

    private fun chamar(caminho: String, corpo: JSONObject?, corpoDelete: Boolean): Resposta = runCatching {
        ObaflixApp.httpClient.newCall(requisicao(caminho, corpo, corpoDelete)).execute().use { r ->
            Resposta(r.code, if (r.isSuccessful) r.body?.string() else null)
        }
    }.getOrElse {
        ObaLog.alerta(
            ObaLog.Fase.SESSAO, "catalogo_falhou",
            "rota" to caminho.substringBefore("?"), "erro" to it.javaClass.simpleName,
        )
        Resposta(0, null)
    }

    /**
     * Executa uma vez; se voltou 401, renova e executa de novo.
     *
     * Nao ha terceira tentativa de proposito: se o segundo 401 chegou, o refresh
     * tambem nao vale mais e insistir so gera trafego. PareamentoTv.renovar ja
     * limpa a credencial e a raiz cai no pareamento.
     */
    private suspend fun executar(caminho: String, corpo: JSONObject? = null, corpoDelete: Boolean = false): String? =
        withContext(Dispatchers.IO) {
            val primeira = chamar(caminho, corpo, corpoDelete)
            if (primeira.status != 401) return@withContext primeira.corpo

            val ctx = contexto ?: return@withContext null
            val renovou = travaRenovacao.withLock { PareamentoTv.renovar(ctx) }
            if (!renovou) return@withContext null
            chamar(caminho, corpo, corpoDelete).corpo
        }

    private suspend fun objeto(caminho: String, corpo: JSONObject? = null): JSONObject? =
        executar(caminho, corpo)?.let { runCatching { JSONObject(it) }.getOrNull() }

    private suspend fun vetor(caminho: String): JSONArray? =
        executar(caminho, null)?.let { runCatching { JSONArray(it) }.getOrNull() }

    // ── Leitura de JSON ──────────────────────────────────────────────────────

    private fun texto(o: JSONObject, chave: String): String? =
        o.optString(chave).takeIf { it.isNotBlank() && it != "null" }

    private fun generos(o: JSONObject): List<Genero> {
        val arr = o.optJSONArray("generos") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val g = arr.optJSONObject(i)?.optJSONObject("genero") ?: return@mapNotNull null
            val nome = texto(g, "nome") ?: return@mapNotNull null
            Genero(g.optInt("id"), nome)
        }
    }

    private fun item(o: JSONObject, tipoPadrao: String): Item = Item(
        id = o.optString("id"),
        titulo = texto(o, "titulo") ?: "Sem título",
        poster = texto(o, "poster"),
        background = texto(o, "background"),
        logo = texto(o, "logo"),
        sinopse = texto(o, "sinopse"),
        ano = o.optInt("ano").takeIf { it > 0 },
        nota = o.optDouble("nota").takeIf { !it.isNaN() && it > 0 },
        tipo = texto(o, "tipo") ?: tipoPadrao,
        generos = generos(o),
        progressoSeg = o.optInt("progressoSeg"),
        duracaoSeg = o.optInt("duracaoSeg").takeIf { it > 0 },
        temporada = o.optInt("temporada").takeIf { it > 0 },
        numeroEp = o.optInt("numeroEp").takeIf { it > 0 },
        episodioId = texto(o, "episodioId"),
        historyId = texto(o, "historyId"),
    )

    /**
     * Item vindo do Histórico / Favoritos, onde os dados do conteudo vem
     * aninhados em `filme`/`serie`. Achata para o mesmo Item das outras telas.
     */
    private fun itemDeConteudo(o: JSONObject): Item? {
        val filme = o.optJSONObject("filme")
        val serie = o.optJSONObject("serie")
        val fonte = filme ?: serie ?: return null
        val tipo = if (filme != null) "filme" else texto(serie!!, "tipo") ?: "serie"
        return Item(
            id = texto(o, "conteudoId") ?: fonte.optString("id"),
            titulo = texto(fonte, "titulo") ?: "Sem título",
            poster = texto(fonte, "poster"),
            background = texto(fonte, "background"),
            logo = texto(fonte, "logo"),
            sinopse = texto(fonte, "sinopse"),
            ano = fonte.optInt("ano").takeIf { it > 0 },
            nota = fonte.optDouble("nota").takeIf { !it.isNaN() && it > 0 },
            tipo = tipo,
            temporada = o.optInt("temporada").takeIf { it > 0 },
            numeroEp = o.optInt("numeroEp").takeIf { it > 0 },
            episodioId = texto(o, "episodioId"),
            historyId = texto(o, "id"),
            progressoSeg = o.optInt("progressoSeg"),
            duracaoSeg = o.optInt("duracaoSeg").takeIf { it > 0 },
        )
    }

    private fun itens(arr: JSONArray?, tipoPadrao: String): List<Item> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { item(it, tipoPadrao) }
        }
    }

    // distinctBy id em toda lista de catalogo: a LazyRow/LazyGrid usa o id como
    // key, e uma unica repeticao — comum quando a sincronizacao insere algo
    // enquanto a pagina e montada — derruba o app com "Key was already used".
    // Melhor filtrar aqui, uma vez, do que confiar que todas as rotas nunca
    // repetem.
    private fun lista(raiz: JSONObject, chave: String, tipoPadrao: String): List<Item> =
        itens(raiz.optJSONArray(chave), tipoPadrao).distinctBy { it.id }

    // ── Home ─────────────────────────────────────────────────────────────────

    /**
     * Monta a Home com **duas** requisicoes, nao uma por fileira.
     *
     * /api/home ja devolve as seis listas de catalogo numa consulta so, e
     * /api/continuar-assistindo e a unica parte que e da conta. Montar as
     * fileiras por chamadas separadas multiplicaria invocacao na Vercel e query
     * no Supabase pelo numero de faixas visiveis, sem trazer nada que este
     * payload ja nao traga.
     */
    suspend fun home(): Home? {
        val raiz = objeto("/api/tv/home") ?: return null

        val fileiras = mutableListOf<Fileira>()

        continuarAssistindo()?.takeIf { it.isNotEmpty() }?.let {
            fileiras += Fileira("continuar", "Continuar assistindo", it, paisagem = true)
        }

        fun adicionar(id: String, titulo: String, chave: String) {
            val itens = lista(raiz, chave, "filme")
            if (itens.isNotEmpty()) fileiras += Fileira(id, titulo, itens)
        }

        // Ordem fixa pedida — a mesma lógica do site (popularidade, popularRank,
        // nota>=7, createdAt). O campo `tipo` de cada item vem do backend.
        adicionar("em-alta", "Em Alta", "emAlta")
        adicionar("filmes-populares", "Filmes Populares", "popularesFilmes")
        adicionar("filmes-top10", "Top 10 Filmes de Hoje", "top10Filmes")
        adicionar("filmes-avaliados", "Filmes Mais Bem Avaliados", "avaliadosFilmes")
        adicionar("filmes-novos", "Novos Filmes", "novosFilmes")
        adicionar("series-populares", "Séries Populares", "popularesSeries")
        adicionar("series-top10", "Top 10 Séries de Hoje", "top10Series")
        adicionar("series-avaliadas", "Séries Mais Bem Avaliadas", "avaliadosSeries")
        adicionar("series-novas", "Novas Séries", "novasSeries")

        // Categorias em destaque, cada uma com filmes e séries daquele gênero.
        raiz.optJSONArray("categorias")?.let { cats ->
            for (i in 0 until cats.length()) {
                val cat = cats.optJSONObject(i) ?: continue
                val titulo = texto(cat, "titulo") ?: continue
                val itens = itens(cat.optJSONArray("itens"), "filme")
                if (itens.isNotEmpty()) fileiras += Fileira("cat-$i-$titulo", titulo, itens)
            }
        }

        // Destaque duplo: os primeiros de "Em Alta" que tenham backdrop — um
        // banner sem arte de fundo vira retangulo cinza no meio da tela.
        val comArte = lista(raiz, "emAlta", "filme").filter { it.background != null }
        val destaques = comArte.distinctBy { it.id }.take(6)

        return Home(destaques, fileiras)
    }

    /**
     * Continuar assistindo. Exige sessao.
     *
     * Lista vazia e resposta legitima (conta nova); null e falha de rede. A Home
     * distingue as duas: a primeira some, a segunda nao derruba o catalogo.
     */
    suspend fun continuarAssistindo(): List<Item>? {
        val arr = vetor("/api/continuar-assistindo") ?: return null
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { item(it, it.optString("conteudoTipo").ifBlank { "filme" }) }
        }.distinctBy { it.chaveProgresso }
    }

    // ── Catalogo filtrado ────────────────────────────────────────────────────

    private fun consulta(vararg pares: Pair<String, Any?>): String =
        pares.filter { it.second != null }.joinToString("&") { it.first + "=" + it.second }

    suspend fun filmes(
        pagina: Int = 1,
        genero: Int? = null,
        ano: Int? = null,
        ordem: String = "recente",
    ): Pagina? {
        val raiz = objeto(
            "/api/filmes?" + consulta(
                "page" to pagina, "genero" to genero, "ano" to ano, "ordem" to ordem,
            ),
        ) ?: return null
        return Pagina(
            itens = lista(raiz, "filmes", "filme"),
            pagina = raiz.optInt("page", pagina),
            paginas = raiz.optInt("pages", pagina),
        )
    }

    suspend fun series(
        tipo: String,
        pagina: Int = 1,
        genero: Int? = null,
        ano: Int? = null,
        ordem: String = "recente",
    ): Pagina? {
        val raiz = objeto(
            "/api/series?" + consulta(
                "tipo" to tipo, "page" to pagina, "genero" to genero, "ano" to ano, "ordem" to ordem,
            ),
        ) ?: return null
        return Pagina(
            itens = lista(raiz, "series", tipo),
            pagina = raiz.optInt("page", pagina),
            paginas = raiz.optInt("pages", pagina),
        )
    }

    // ── Ficha ────────────────────────────────────────────────────────────────

    /**
     * Detalhe de um conteudo.
     *
     * Para serie, os episodios de **todas** as temporadas vem numa requisicao so
     * e ficam em memoria. Buscar por temporada faria uma ida ao servidor a cada
     * troca no seletor — e a troca precisa ser instantanea, com o controle na
     * mao. Uma consulta a mais aqui evita uma por temporada depois.
     */
    suspend fun detalhe(id: String, tipo: String): Detalhe? {
        if (tipo == "filme") {
            val o = objeto("/api/filmes/" + id) ?: return null
            return Detalhe(item(o, "filme"), emptyList(), emptyList())
        }

        // As duas chamadas em paralelo. Em sequencia, a ficha esperava a soma
        // de duas idas ao servidor para mostrar o titulo — e a lista de
        // episodios nao depende do corpo da serie para ser pedida.
        val par = coroutineScope {
            val corpo = async { objeto("/api/series/" + id) }
            val eps = async { vetor("/api/series/" + id + "/episodios") }
            Pair(corpo.await(), eps.await())
        }
        val o = par.first ?: return null
        val arr = par.second
        val base = item(o, tipo)
        val episodios = (0 until (arr?.length() ?: 0)).mapNotNull { i ->
            val e = arr?.optJSONObject(i) ?: return@mapNotNull null
            Episodio(
                id = e.optString("id"),
                serieId = id,
                temporada = e.optInt("temporada"),
                numeroEp = e.optInt("numeroEp"),
                titulo = texto(e, "titulo"),
                thumbnail = texto(e, "thumbnail"),
                disponivel = texto(e, "urlDub") != null || texto(e, "urlLeg") != null,
            )
        }.sortedWith(compareBy({ it.temporada }, { it.numeroEp }))

        return Detalhe(base, episodios.map { it.temporada }.distinct().sorted(), episodios)
    }

    // ── Busca ────────────────────────────────────────────────────────────────

    suspend fun buscar(termo: String): List<Item> {
        if (termo.isBlank()) return emptyList()
        val raiz = objeto("/api/search?q=" + java.net.URLEncoder.encode(termo, "UTF-8"))
            ?: return emptyList()
        // Intercala filme e serie em vez de concatenar: quem digita "casa" quer
        // ver as duas coisas na primeira linha, nao vinte filmes antes da serie.
        val filmes = lista(raiz, "filmes", "filme")
        val series = lista(raiz, "series", "serie")
        return buildList {
            for (i in 0 until maxOf(filmes.size, series.size)) {
                filmes.getOrNull(i)?.let { add(it) }
                series.getOrNull(i)?.let { add(it) }
            }
            // A grade de busca usa (tipo + id) como key; filme e serie com o mesmo
            // id do TMDB coexistem, mas dois do mesmo tipo nao podem repetir.
        }.distinctBy { it.tipo + it.id }
    }

    /**
     * Progresso salvo de UM episodio especifico (ou filme).
     *
     * Existe por causa da troca de episodio no player: o episodio novo tem de
     * comecar na SUA posicao — 00:00 se nunca foi visto —, nunca herdar o minuto
     * do anterior. Usa a mesma rota /api/progress do site, com episodioId.
     */
    suspend fun progresso(conteudoId: String, episodioId: String?): Int {
        val caminho = "/api/progress?conteudoId=" + conteudoId +
            (if (episodioId != null) "&episodioId=" + episodioId else "")
        val o = objeto(caminho) ?: return 0
        // Concluido volta ao inicio: reassistir do zero e o esperado.
        if (o.optBoolean("concluido", false)) return 0
        return o.optInt("progressoSeg", 0)
    }

    // ── Relacionados ───────────────────────────────────────────────────────────

    /**
     * "Você também pode gostar".
     *
     * O backend nao tem rota de similaridade por item, entao a aproximacao mais
     * barata e honesta e o proprio catalogo filtrado pelo primeiro genero do
     * conteudo — uma consulta so, que a rota ja sabe responder. Sem genero, cai
     * para os populares do mesmo tipo. O proprio item e removido da lista.
     */
    suspend fun relacionados(base: Item): List<Item> {
        val genero = base.generos.firstOrNull()?.id
        val pagina = if (base.tipo == "filme") {
            filmes(1, genero, null, "popular")
        } else {
            series(base.tipo, 1, genero, null, "popular")
        }
        return pagina?.itens.orEmpty().filter { it.id != base.id }.take(20)
    }

    // ── Perfil: histórico e favoritos ──────────────────────────────────────────

    suspend fun historico(): List<Item> {
        val arr = vetor("/api/user/history") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { itemDeConteudo(it) }
        }
    }

    suspend fun favoritos(): List<Item> {
        val arr = vetor("/api/user/watchlist") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { itemDeConteudo(it) }
        }
    }

    /** Remove uma entrada de Continuar/Histórico pelo id da entrada. */
    suspend fun removerHistorico(historyId: String): Boolean =
        executar("/api/continuar-assistindo", JSONObject().put("historyId", historyId), corpoDelete = true) != null

    /** Remove um favorito (watchlist). */
    suspend fun removerFavorito(conteudoId: String, tipo: String): Boolean =
        executar("/api/user/watchlist/" + conteudoId + "?tipo=" + tipo, corpoDelete = true) != null

    // ── Favoritos (watchlist) ──────────────────────────────────────────────────

    suspend fun estaNaLista(id: String, tipo: String): Boolean {
        val o = objeto("/api/user/watchlist/check?conteudoId=" + id + "&conteudoTipo=" + tipo)
        return o?.optBoolean("inWatchlist", false) ?: false
    }

    /** Alterna o favorito. Devolve o novo estado. */
    suspend fun alternarLista(id: String, tipo: String, estavaNaLista: Boolean): Boolean {
        if (estavaNaLista) {
            executar("/api/user/watchlist/" + id + "?tipo=" + tipo, corpoDelete = true)
            return false
        }
        executar("/api/user/watchlist", JSONObject().put("conteudoId", id).put("conteudoTipo", tipo))
        return true
    }

    // ── Progresso ────────────────────────────────────────────────────────────

    /**
     * Grava a posicao. Mesmo contrato do site: e o backend que decide quando o
     * item sai de Continuar Assistindo e qual episodio entra na fila.
     */
    suspend fun salvarProgresso(
        conteudoId: String,
        conteudoTipo: String,
        progressoSeg: Int,
        duracaoSeg: Int?,
        episodioId: String? = null,
        temporada: Int? = null,
        numeroEp: Int? = null,
    ): Boolean {
        val corpo = JSONObject()
            .put("conteudoId", conteudoId)
            .put("conteudoTipo", if (conteudoTipo == "filme") "filme" else "serie")
            .put("progressoSeg", progressoSeg)
            .put("duracaoSeg", duracaoSeg ?: JSONObject.NULL)
            .put("episodioId", episodioId ?: JSONObject.NULL)
            .put("temporada", temporada ?: JSONObject.NULL)
            .put("numeroEp", numeroEp ?: JSONObject.NULL)
        return executar("/api/progress", corpo) != null
    }

    // ── Fontes de reproducao ─────────────────────────────────────────────────
    // Usadas por FontesTv. Ficam aqui para o transporte e a renovacao de token
    // serem os mesmos do resto; nenhuma delas registra URL em log.

    internal suspend fun fontes(
        conteudoId: String,
        conteudoTipo: String,
        temporada: Int?,
        numeroEp: Int?,
    ): JSONObject? = objeto(
        "/api/player/fontes",
        JSONObject()
            .put("conteudoId", conteudoId)
            .put("conteudoTipo", if (conteudoTipo == "filme") "filme" else "serie")
            .put("temporada", temporada ?: JSONObject.NULL)
            .put("numeroEp", numeroEp ?: JSONObject.NULL)
            .put("ambiente", "android"),
    )

    internal suspend fun fonteNativa(sessao: String, fonteId: String): String? =
        objeto(
            "/api/player/fonte-nativa",
            JSONObject().put("sessao", sessao).put("fonteId", fonteId),
        )?.let { texto(it, "embedUrl") }
}
