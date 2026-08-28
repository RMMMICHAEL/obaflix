package com.obaflix.tv.catalogo

import com.obaflix.ObaflixApp
import com.obaflix.bridge.ObaLog
import com.obaflix.tv.BuildConfig
import com.obaflix.tv.sessao.SessaoTv
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

/**
 * Cliente do catalogo.
 *
 * Duas rotas por enquanto: `/api/home` monta as fileiras e nao exige sessao, e
 * `/api/continuar-assistindo` exige — e a unica coisa da Home que e da conta.
 */

data class Item(
    val id: String,
    val titulo: String,
    val poster: String?,
    val background: String?,
    val logo: String?,
    val sinopse: String?,
    val ano: Int?,
    val nota: Double?,
    val tipo: String,
    /** Preenchidos so em Continuar Assistindo. */
    val progressoSeg: Int = 0,
    val duracaoSeg: Int? = null,
    val temporada: Int? = null,
    val numeroEp: Int? = null,
) {
    /** Fracao assistida, para a barrinha do card. Zero quando nao se aplica. */
    val progresso: Float
        get() = if (duracaoSeg != null && duracaoSeg > 0) {
            (progressoSeg.toFloat() / duracaoSeg).coerceIn(0f, 1f)
        } else 0f

    val rotuloEpisodio: String?
        get() = if (temporada != null && numeroEp != null) "T$temporada:E$numeroEp" else null
}

data class Fileira(val titulo: String, val itens: List<Item>, val paisagem: Boolean = false)

data class Home(val destaque: Item?, val fileiras: List<Fileira>)

object ApiObaflix {

    /**
     * O catalogo mistura caminho do TMDB e URL completa no mesmo campo — depende
     * de qual sincronizacao gravou o registro. Resolver aqui evita espalhar esse
     * detalhe por cada tela.
     */
    fun imagem(caminho: String?, tamanho: String = "w500"): String? {
        if (caminho.isNullOrBlank()) return null
        if (caminho.startsWith("http")) return caminho
        return "https://image.tmdb.org/t/p/$tamanho$caminho"
    }

    private fun item(o: JSONObject, tipoPadrao: String): Item = Item(
        id = o.optString("id"),
        titulo = o.optString("titulo").ifBlank { "Sem título" },
        poster = o.optString("poster").takeIf { it.isNotBlank() && it != "null" },
        background = o.optString("background").takeIf { it.isNotBlank() && it != "null" },
        logo = o.optString("logo").takeIf { it.isNotBlank() && it != "null" },
        sinopse = o.optString("sinopse").takeIf { it.isNotBlank() && it != "null" },
        ano = o.optInt("ano").takeIf { it > 0 },
        nota = o.optDouble("nota").takeIf { !it.isNaN() && it > 0 },
        tipo = o.optString("tipo").takeIf { it.isNotBlank() && it != "null" } ?: tipoPadrao,
        progressoSeg = o.optInt("progressoSeg"),
        duracaoSeg = o.optInt("duracaoSeg").takeIf { it > 0 },
        temporada = o.optInt("temporada").takeIf { it > 0 },
        numeroEp = o.optInt("numeroEp").takeIf { it > 0 },
    )

    private fun lista(raiz: JSONObject, chave: String, tipoPadrao: String): List<Item> {
        val arr = raiz.optJSONArray(chave) ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { item(it, tipoPadrao) }
        }
    }

    private fun requisicao(caminho: String, comToken: Boolean): Request =
        Request.Builder()
            .url("${BuildConfig.OBAFLIX_URL}$caminho")
            .header("User-Agent", SessaoTv.userAgent)
            .apply {
                if (comToken) SessaoTv.accessToken()?.let { header("Authorization", "Bearer $it") }
            }
            .get()
            .build()

    private suspend fun buscarTexto(caminho: String, comToken: Boolean): String? =
        withContext(Dispatchers.IO) {
            runCatching {
                ObaflixApp.httpClient.newCall(requisicao(caminho, comToken)).execute().use { r ->
                    if (r.isSuccessful) r.body?.string() else null
                }
            }.onFailure {
                ObaLog.alerta(ObaLog.Fase.SESSAO, "catalogo_falhou",
                    "rota" to caminho, "erro" to it.javaClass.simpleName)
            }.getOrNull()
        }

    /**
     * Monta a Home.
     *
     * Continuar Assistindo entra primeiro quando existe — e o motivo mais comum
     * de alguem ligar a televisao. As duas chamadas sao independentes; se a de
     * conta falhar, o catalogo aparece do mesmo jeito.
     */
    suspend fun home(): Home? {
        val corpo = buscarTexto("/api/home", comToken = false) ?: return null
        val raiz = runCatching { JSONObject(corpo) }.getOrNull() ?: return null

        val fileiras = mutableListOf<Fileira>()

        continuarAssistindo()?.takeIf { it.isNotEmpty() }?.let {
            fileiras += Fileira("Continuar assistindo", it, paisagem = true)
        }

        fun adicionar(titulo: String, chave: String, tipo: String) {
            val itens = lista(raiz, chave, tipo)
            if (itens.isNotEmpty()) fileiras += Fileira(titulo, itens)
        }

        adicionar("Em alta", "destaquesFilmes", "filme")
        adicionar("Lançamentos", "lancamentosFilmes", "filme")
        adicionar("Séries", "lancamentosSeries", "serie")
        adicionar("Séries em destaque", "destaquesSeries", "serie")
        adicionar("Animes", "animes", "anime")
        adicionar("Desenhos", "desenhos", "desenho")

        val destaque = lista(raiz, "hero", "filme").firstOrNull()
            ?: fileiras.firstOrNull { !it.paisagem }?.itens?.firstOrNull()

        return Home(destaque, fileiras)
    }

    /**
     * Continuar assistindo. Exige sessao.
     *
     * 401 aqui costuma significar apenas que o access token de 15 minutos
     * venceu; a raiz renova antes de reclamar. Devolver lista vazia mantem a
     * Home utilizavel enquanto isso.
     */
    suspend fun continuarAssistindo(): List<Item>? {
        val corpo = buscarTexto("/api/continuar-assistindo", comToken = true) ?: return null
        val arr = runCatching { JSONArray(corpo) }.getOrNull() ?: return null
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { item(it, it.optString("conteudoTipo").ifBlank { "filme" }) }
        }
    }
}
