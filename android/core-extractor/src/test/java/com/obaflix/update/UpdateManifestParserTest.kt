package com.obaflix.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateManifestParserTest {

    @Test
    fun `manifesto valido com as duas plataformas`() {
        val json = """
            {
              "schemaVersion": 1,
              "android": {
                "versionName": "1.1.0",
                "versionCode": 10,
                "url": "https://app.obaflix.online/Obaflix-1.1.0.apk",
                "size": 10600000,
                "sha256": "${"a".repeat(64)}"
              },
              "androidTv": {
                "versionName": "0.8.0",
                "versionCode": 37,
                "url": "https://app.obaflix.online/Obaflix-TV-0.8.0.apk"
              }
            }
        """.trimIndent()

        val manifesto = UpdateManifestParser.parse(json)

        assertEquals(1, manifesto.schemaVersion)
        assertEquals(10, manifesto.android?.versionCode)
        assertEquals("1.1.0", manifesto.android?.versionName)
        assertEquals(10600000L, manifesto.android?.size)
        assertEquals(64, manifesto.android?.sha256?.length)
        assertEquals(37, manifesto.androidTv?.versionCode)
        // sha256 e size nao vieram nesta entrada — devem ficar nulos, nao zerados.
        assertNull(manifesto.androidTv?.sha256)
        assertNull(manifesto.androidTv?.size)
    }

    @Test
    fun `plataforma ausente no JSON nao quebra a leitura das outras`() {
        val manifesto = UpdateManifestParser.parse(
            """{"android":{"versionName":"1.0","versionCode":1,"url":"https://x.example/a.apk"}}""",
        )
        assertNull(manifesto.androidTv)
        assertEquals(1, manifesto.android?.versionCode)
    }

    @Test
    fun `entrada com url http eh rejeitada mesmo com o resto valido`() {
        val manifesto = UpdateManifestParser.parse(
            """{"android":{"versionName":"1.0","versionCode":1,"url":"http://inseguro.example/a.apk"}}""",
        )
        assertNull(manifesto.android)
    }

    @Test
    fun `versionCode zero ou negativo eh rejeitado`() {
        val zero = UpdateManifestParser.parse(
            """{"android":{"versionName":"1.0","versionCode":0,"url":"https://x.example/a.apk"}}""",
        )
        val negativo = UpdateManifestParser.parse(
            """{"android":{"versionName":"1.0","versionCode":-3,"url":"https://x.example/a.apk"}}""",
        )
        assertNull(zero.android)
        assertNull(negativo.android)
    }

    @Test
    fun `versionName vazio eh rejeitado`() {
        val manifesto = UpdateManifestParser.parse(
            """{"android":{"versionName":"","versionCode":1,"url":"https://x.example/a.apk"}}""",
        )
        assertNull(manifesto.android)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `json malformado lanca excecao`() {
        UpdateManifestParser.parse("{ isto nao e json")
    }

    @Test
    fun `sha256 mal formado eh ignorado sem invalidar a entrada`() {
        val manifesto = UpdateManifestParser.parse(
            """{"android":{"versionName":"1.0","versionCode":1,"url":"https://x.example/a.apk","sha256":"nao-e-hex"}}""",
        )
        assertEquals(1, manifesto.android?.versionCode)
        assertNull(manifesto.android?.sha256)
    }

    @Test
    fun `sha256 em maiusculas eh normalizado para minusculas`() {
        val manifesto = UpdateManifestParser.parse(
            """{"android":{"versionName":"1.0","versionCode":1,"url":"https://x.example/a.apk","sha256":"${"A".repeat(64)}"}}""",
        )
        assertEquals("a".repeat(64), manifesto.android?.sha256)
    }
}
