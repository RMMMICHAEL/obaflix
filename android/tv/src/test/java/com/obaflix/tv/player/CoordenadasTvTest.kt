package com.obaflix.tv.player

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * O contrato de coordenadas da TV com `/api/player/fonte-nativa` — o mesmo do
 * player do site: `tentativa` so vai quando e maior que zero, `tentativas`
 * ausente vale 1, e cada indice e tentado uma vez, ate o teto do servidor.
 */
class CoordenadasTvTest {

    @After
    fun limpar() = CoordenadasTv.esquecerTudo()

    @Test
    fun `tentativa zero manda o corpo de sempre`() {
        val corpo = CoordenadasTv.corpo("s", "f", 0)
        assertFalse(corpo.has("tentativa"))
        assertEquals("s", corpo.getString("sessao"))
        assertEquals("f", corpo.getString("fonteId"))
        assertEquals(2, CoordenadasTv.corpo("s", "f", 2).getInt("tentativa"))
    }

    @Test
    fun `servidor antigo ou valor invalido vale uma tentativa, e o teto e 4`() {
        assertEquals(1, CoordenadasTv.total(JSONObject("""{"embedUrl":"x"}""")))
        assertEquals(1, CoordenadasTv.total(JSONObject("""{"tentativas":0}""")))
        assertEquals(1, CoordenadasTv.total(JSONObject("""{"tentativas":"abc"}""")))
        assertEquals(3, CoordenadasTv.total(JSONObject("""{"tentativas":3}""")))
        assertEquals(4, CoordenadasTv.total(JSONObject("""{"tentativas":99}""")))
    }

    @Test
    fun `cada indice uma vez, em ordem, e depois acabou`() {
        assertEquals(1, CoordenadasTv.proxima(setOf(0), 3))
        assertEquals(0, CoordenadasTv.proxima(setOf(2), 3))
        assertEquals(2, CoordenadasTv.proxima(setOf(0, 1), 3))
        assertNull(CoordenadasTv.proxima(setOf(0, 1, 2), 3))
        assertNull(CoordenadasTv.proxima(setOf(0), 1))
        assertNull(CoordenadasTv.proxima(setOf(0, 1, 2, 3), 99))
    }

    @Test
    fun `a que reproduziu e retomada primeiro, e indice invalido nao e guardado`() {
        assertEquals(0, CoordenadasTv.lembrada("fonte-a"))
        CoordenadasTv.lembrar("fonte-a", 2)
        assertEquals(2, CoordenadasTv.lembrada("fonte-a"))
        CoordenadasTv.lembrar("fonte-b", 7)
        assertEquals(0, CoordenadasTv.lembrada("fonte-b"))
        // Canonica falhou, continua funcionou: T2E1 -> T1E27 na mesma fonte.
        val feitas = mutableSetOf(0)
        assertEquals(1, CoordenadasTv.proxima(feitas, 2))
    }
}
