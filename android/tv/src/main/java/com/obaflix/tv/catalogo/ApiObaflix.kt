package com.obaflix.tv.catalogo

import android.content.Context
import com.obaflix.ObaflixApp
import com.obaflix.bridge.ObaLog
import com.obaflix.tv.BuildConfig
import com.obaflix.tv.sessao.PareamentoTv
import com.obaflix.tv.sessao.SessaoTv
import kotlinx.coroutines.Dispatchers
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

    private fun requisicao(caminho: String, corpo: JSONObject?): Request =
        Request.Builder()
            .url(BuildConfig.OBAFLIX_URL + caminho)
            .header("User-Agent", SessaoTv.userAgent)
            .apply {
                SessaoTv.accessToken()?.let { header("Authorization", "Bearer " + it) }
                if (corpo != null) post(corpo.toString().toRequestBody(JSON)) else get()
            }
            .build()

    private data class Resposta(val status: Int, val corpo: String?)

    private fun chamar(caminho: String, corpo: JSONObject?): Resposta = runCatching {
        ObaflixApp.httpClient.newCall(requisicao(caminho, corpo)).execute().use { r ->
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
    private suspend fun executar(caminho: String, corpo: JSONObject?): String? =
        withContext(Dispatchers.IO) {
            val primeira = chamar(caminho, corpo)
            if (primeira.status != 401) return@withContext primeira.corpo

            val ctx = contexto ?: return@withContext null
            val renovou = travaRenovacao.withLock { PareamentoTv.renovar(ctx) }
            if (!renovou) return@withContext null
            chamar(caminho, corpo).corpo
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
    )

    private fun itens(arr: JSONArray?, tipoPadrao: String): List<Item> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { item(it, tipoPadrao) }
        }
    }

    private fun lista(raiz: JSONObject, chave: String, tipoPadrao: String): List<Item> =
        itens(raiz.optJSONArray(chave), tipoPadrao)

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
        val raiz = objeto("/api/home") ?: return null

        val fileiras = mutableListOf<Fileira>()

        continuarAssistindo()?.takeIf { it.isNotEmpty() }?.let {
            fileiras += Fileira("continuar", "Continuar assistindo", it, paisagem = true)
        }

        fun adicionar(id: String, titulo: String, chave: String, tipo: String) {
            val itens = lista(raiz, chave, tipo)
            if (itens.isNotEmpty()) fileiras += Fileira(id, titulo, itens)
        }

        adicionar("filmes-alta", "Em alta", "destaquesFilmes", "filme")
        adicionar("filmes-novos", "Lançamentos", "lancamentosFilmes", "filme")
        adicionar("series-alta", "Séries populares", "destaquesSeries", "serie")
        adicionar("series-novas", "Novas séries", "lancamentosSeries", "serie")
        adicionar("animes", "Animes", "animes", "anime")
        adicionar("desenhos", "Kids", "desenhos", "desenho")

        // O hero do site ja vem sorteado e com arte grande; o destaque duplo da
        // televisao usa os primeiros que tenham backdrop, porque um banner sem
        // arte de fundo vira retangulo cinza no meio da tela.
        val comArte = lista(raiz, "hero", "filme").filter { it.background != null }
        val destaques = if (comArte.size >= 2) comArte.take(6) else {
            (comArte + fileiras.filter { !it.paisagem }
                .flatMap { it.itens }
                .filter { it.background != null })
                .distinctBy { it.id }
                .take(6)
        }

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
        }
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

        val o = objeto("/api/series/" + id) ?: return null
        val base = item(o, tipo)
        val arr = vetor("/api/series/" + id + "/episodios")
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
        }
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
