package com.obaflix.tv.ui.componentes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Navegacao vertical entre fileiras.
 *
 * ## O que este arquivo consegue provar, e o que nao consegue
 *
 * O comportamento de foco do Compose so se observa com a composicao viva —
 * exige teste instrumentado (`compose-ui-test`) num aparelho ou emulador de TV,
 * que este projeto ainda nao tem configurado. Nao ha como, em JVM pura, apertar
 * a seta para baixo e conferir onde o cursor parou.
 *
 * O que da para travar aqui e a **fiacao**: que a fileira declara `enter`, que o
 * requisitor de entrada esta no card de indice 0, e que a rolagem volta ao
 * inicio quando o cursor sai — as tres pecas de que o comportamento depende. Se
 * alguem remover qualquer uma numa refatoracao, isto quebra antes de virar um
 * D-Pad que nao responde.
 */
class FileirasTest {

    private val fonte: String by lazy {
        File("src/main/java/com/obaflix/tv/ui/componentes/Fileiras.kt").readText()
    }

    private val semComentarios: String by lazy {
        fonte
            .replace(Regex("""/\*[\s\S]*?\*/"""), " ")
            .lines()
            .joinToString("\n") { linha ->
                val corte = linha.indexOf("//")
                if (corte >= 0) linha.substring(0, corte) else linha
            }
    }

    @Test
    fun `o arquivo que este teste protege existe`() {
        // Sem isto, mover o componente transformaria os testes abaixo em no-op
        // silencioso — passariam lendo uma string vazia.
        assertTrue("Fileiras.kt nao encontrado", fonte.contains("fun FileiraCatalogo"))
    }

    @Test
    fun `a fileira declara a entrada de foco`() {
        // `enter` so e consultado quando o foco ENTRA no grupo: seta para baixo e
        // para cima. E o mecanismo que leva ao primeiro card.
        assertTrue(
            "a fileira deixou de declarar focusProperties.enter",
            semComentarios.contains("focusProperties") && semComentarios.contains("enter ="),
        )
    }

    @Test
    fun `a entrada aponta para o requisitor do primeiro card`() {
        assertTrue("enter nao aponta para `primeiro`", semComentarios.contains("enter = { primeiro }"))
        // E o requisitor tem de estar no indice 0, nao em outro qualquer.
        assertTrue(
            "o requisitor de entrada saiu do card de indice 0",
            semComentarios.contains("if (indice == 0) Modifier.focusRequester(primeiro)"),
        )
    }

    @Test
    fun `a fileira volta ao inicio quando perde o foco`() {
        // Sem isto, subir de volta para uma fileira rolada pediria foco a um card
        // que a LazyRow ja descartou, e a seta ficaria sem resposta.
        assertTrue(
            "a rolagem nao volta ao inicio ao sair da fileira",
            semComentarios.contains("scrollToItem(0)"),
        )
        assertTrue(
            "a volta ao inicio deveria acontecer so quando o foco sai",
            semComentarios.contains("!estado.hasFocus"),
        )
    }

    @Test
    fun `a navegacao horizontal nao foi tocada`() {
        // Esquerda e direita andam DENTRO do grupo e nao passam por `enter`.
        // Um `left`/`right` explicito aqui significaria que alguem mexeu no que
        // devia ficar como estava.
        assertFalse("apareceu override de navegacao horizontal", semComentarios.contains("left ="))
        assertFalse("apareceu override de navegacao horizontal", semComentarios.contains("right ="))
    }

    @Test
    fun `o grupo de foco continua existindo`() {
        // focusGroup + chave estavel foram o que corrigiu o crash de
        // "LayoutCoordinate operations are only valid when isAttached is true".
        assertTrue(semComentarios.contains("focusGroup()"))
        assertTrue(semComentarios.contains("key = { _, item ->"))
    }

    // -- Aritmetica de colunas (pura) -----------------------------------------

    @Test
    fun `colunas cabem na largura sem vazar`() {
        // 720p, 1080p e 4K em dp de TV.
        assertTrue(colunas(960) in 4..9)
        assertTrue(colunas(1280) in 4..9)
        assertTrue(colunas(1920) in 4..9)
    }

    @Test
    fun `mais largura nunca devolve menos colunas`() {
        var anterior = colunas(600)
        for (largura in 600..2400 step 60) {
            val atual = colunas(largura)
            assertTrue("colunas diminuiu de $anterior para $atual em $largura", atual >= anterior)
            anterior = atual
        }
    }

    @Test
    fun `largura absurda fica dentro dos limites`() {
        assertEquals(4, colunas(0))
        assertEquals(4, colunas(-100))
        assertEquals(9, colunas(100_000))
    }
}
