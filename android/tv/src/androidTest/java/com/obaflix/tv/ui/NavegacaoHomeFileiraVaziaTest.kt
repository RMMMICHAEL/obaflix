package com.obaflix.tv.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.obaflix.tv.catalogo.Fileira
import com.obaflix.tv.catalogo.Home
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.ui.componentes.FileiraCatalogo
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Navegacao vertical da Home com fileira vazia no meio.
 *
 * Reproduz o cenario do smoke de homologacao: "Mais bem avaliados" vazia entre
 * fileiras preenchidas. Compoe a mesma ListaDaHome da TelaHome, sem rede nem
 * cache, e atravessa o cenario com a seta para baixo e para cima — o foco tem
 * de pular a fileira vazia e nada pode lancar excecao.
 *
 * Roda no emulador de TV: gradlew :tv:connectedUiTesteAndroidTest
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class NavegacaoHomeFileiraVaziaTest {

    @get:Rule
    val regra = createComposeRule()

    private fun item(id: String) = Item(
        id = id, titulo = id, poster = null, background = null, logo = null,
        sinopse = null, ano = null, nota = null, tipo = "filme",
    )

    private val home = Home(
        destaques = emptyList(),
        fileiras = listOf(
            Fileira("primeira", "Primeira", listOf(item("P1"), item("P2"), item("P3"))),
            Fileira("vazia", "Fileira vazia", emptyList()),
            Fileira("seguinte", "Seguinte", listOf(item("S1"), item("S2"))),
            Fileira("vazia-2", "Outra vazia", emptyList()),
            Fileira("ultima", "Ultima", listOf(item("U1"))),
        ),
    )

    private val abertos = mutableListOf<String>()

    private fun comporHome() {
        regra.setContent {
            TemaObaflixTv {
                Column(Modifier.fillMaxSize()) {
                    ListaDaHome(
                        dados = home,
                        margem = 24.dp,
                        aoFocarArte = {},
                        aoAbrir = { abertos += it.id },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }
    }

    /** O card e o no clicavel que contem o titulo (o nome abaixo dele nao e clicavel). */
    private fun card(titulo: String) = regra.onNode(hasText(titulo) and hasClickAction())

    private fun focado(titulo: String) = regra.onNode(isFocused() and hasText(titulo)).assertExists()

    private fun tecla(k: Key) {
        regra.onRoot().performKeyInput { pressKey(k) }
        regra.waitForIdle()
    }

    @Test
    fun fileiraVaziaNaoERenderizada() {
        comporHome()
        regra.onNode(hasText("Fileira vazia")).assertDoesNotExist()
        regra.onNode(hasText("Outra vazia")).assertDoesNotExist()
        regra.onNode(hasText("Seguinte")).assertExists()
    }

    @Test
    fun descerESubirAtravessandoFileiraVaziaSemCrash() {
        comporHome()
        card("P1").performSemanticsAction(SemanticsActions.RequestFocus)
        focado("P1")

        tecla(Key.DirectionDown)
        focado("S1")
        tecla(Key.DirectionDown)
        focado("U1")
        // Seta para baixo na ultima fileira: nao ha destino, e nao pode quebrar.
        tecla(Key.DirectionDown)
        focado("U1")

        tecla(Key.DirectionUp)
        focado("S1")
        tecla(Key.DirectionUp)
        focado("P1")
    }

    @Test
    fun entrarPelaFileiraSeguinteVindoDoMeioDaPrimeira() {
        comporHome()
        card("P1").performSemanticsAction(SemanticsActions.RequestFocus)
        tecla(Key.DirectionRight)
        tecla(Key.DirectionRight)
        focado("P3")

        // `enter` da fileira leva ao primeiro card, e a vazia nao participa.
        tecla(Key.DirectionDown)
        focado("S1")
        tecla(Key.DirectionUp)
        focado("P1")
    }

    @Test
    fun idaEVoltaRepetidasNaoPerdemOFoco() {
        comporHome()
        card("P1").performSemanticsAction(SemanticsActions.RequestFocus)
        repeat(8) {
            repeat(4) { tecla(Key.DirectionDown) }
            focado("U1")
            repeat(4) { tecla(Key.DirectionUp) }
            focado("P1")
        }
        tecla(Key.Enter)
        regra.runOnIdle { check(abertos == listOf("P1")) { "OK abriu $abertos" } }
    }

    @Test
    fun fileiraSemItensNaoCompoeNemRecebeFoco() {
        regra.setContent {
            TemaObaflixTv {
                Column {
                    FileiraCatalogo(
                        fileira = Fileira("vazia", "Sem itens", emptyList()),
                        margem = 24.dp,
                        aoFocar = {},
                        aoAbrir = {},
                    )
                }
            }
        }
        regra.onNode(hasText("Sem itens")).assertDoesNotExist()
        regra.onNode(isFocused()).assertDoesNotExist()
    }
}
