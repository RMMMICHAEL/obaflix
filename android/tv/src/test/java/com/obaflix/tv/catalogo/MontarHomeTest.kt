package com.obaflix.tv.catalogo

import com.obaflix.tv.ui.componentes.fileirasNavegaveis
import com.obaflix.tv.ui.componentes.homeNavegavel
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Montagem da Home a partir do payload de /api/tv/home.
 *
 * Cenario do smoke de homologacao: o banco isolado nao tem fonte cadastrada, e
 * "Mais bem avaliados" chega vazia entre fileiras preenchidas. Fileira vazia
 * nao pode chegar a tela — nao tem card para receber o foco da seta.
 */
class MontarHomeTest {

    private fun item(id: String, tipo: String = "filme") =
        JSONObject().put("id", id).put("titulo", "Titulo $id").put("tipo", tipo)

    private fun vetor(vararg itens: JSONObject) = JSONArray().apply { itens.forEach { put(it) } }

    private fun modelo(id: String) = Item(
        id = id, titulo = id, poster = null, background = null, logo = null,
        sinopse = null, ano = null, nota = null, tipo = "filme",
    )

    /** Primeira preenchida, intermediaria vazia, seguinte preenchida. */
    private val payloadComFileiraVazia = JSONObject()
        .put("emAlta", vetor(item("a1"), item("a2", "serie")))
        .put("popularesFilmes", vetor(item("f1"), item("f2")))
        .put("top10Filmes", vetor(item("f1")))
        .put("avaliadosFilmes", JSONArray())
        .put("novosFilmes", vetor(item("f3")))
        .put("popularesSeries", JSONArray())
        .put("top10Series", JSONArray())
        .put("avaliadosSeries", JSONArray())
        .put(
            "categorias",
            JSONArray()
                .put(JSONObject().put("titulo", "Drama").put("itens", JSONArray()))
                .put(JSONObject().put("titulo", "Acao").put("itens", vetor(item("x1"), item("x1"), item("x2")))),
        )

    @Test
    fun `fileira vazia entre preenchidas nao chega a Home`() {
        val home = ApiObaflix.montarHome(payloadComFileiraVazia, continuar = emptyList())

        assertEquals(
            listOf("em-alta", "filmes-populares", "filmes-top10", "filmes-novos", "cat-1-Acao"),
            home.fileiras.map { it.id },
        )
        assertTrue("saiu fileira sem card", home.fileiras.all { it.itens.isNotEmpty() })
    }

    @Test
    fun `categoria sem itens some e categoria com repeticao nao repete key`() {
        val home = ApiObaflix.montarHome(payloadComFileiraVazia, continuar = null)
        val acao = home.fileiras.single { it.id == "cat-1-Acao" }
        assertEquals(listOf("x1", "x2"), acao.itens.map { it.id })
        assertFalse(home.fileiras.any { it.titulo == "Drama" })
    }

    @Test
    fun `continuar assistindo vazio ou indisponivel nao vira fileira`() {
        assertFalse(ApiObaflix.montarHome(payloadComFileiraVazia, emptyList()).fileiras.any { it.id == "continuar" })
        assertFalse(ApiObaflix.montarHome(payloadComFileiraVazia, null).fileiras.any { it.id == "continuar" })
        val comProgresso = ApiObaflix.montarHome(payloadComFileiraVazia, listOf(modelo("c1")))
        assertEquals("continuar", comProgresso.fileiras.first().id)
    }

    @Test
    fun `payload inteiramente vazio nao produz Home navegavel`() {
        val home = ApiObaflix.montarHome(JSONObject().put("emAlta", JSONArray()), continuar = emptyList())
        assertTrue(home.fileiras.isEmpty())
        assertFalse("Home sem card nao pode pedir foco nem montar lista", homeNavegavel(home))
    }

    @Test
    fun `a tela filtra fileira vazia mesmo quando ela chega por outra origem`() {
        val fileiras = listOf(
            Fileira("primeira", "Primeira", listOf(modelo("p1"))),
            Fileira("vazia", "Vazia", emptyList()),
            Fileira("seguinte", "Seguinte", listOf(modelo("s1"))),
        )
        assertEquals(listOf("primeira", "seguinte"), fileirasNavegaveis(fileiras).map { it.id })
        assertTrue(homeNavegavel(Home(emptyList(), fileiras)))
        assertFalse(homeNavegavel(Home(emptyList(), listOf(Fileira("vazia", "Vazia", emptyList())))))
    }
}
