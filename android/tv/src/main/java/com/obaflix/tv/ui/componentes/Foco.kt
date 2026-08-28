package com.obaflix.tv.ui.componentes

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.graphicsLayer

/**
 * Restauracao de foco entre telas.
 *
 * Quando a pessoa entra num conteudo e volta, a Home tem de devolver o cursor
 * ao mesmo card — nao ao primeiro da primeira fileira. As fileiras continuam
 * compostas por baixo da sobreposicao, entao a rolagem ja se preserva sozinha;
 * o que falta e dizer a qual card o foco pertence.
 *
 * A solucao e um endereco unico ("fileira#indice") guardado enquanto se navega
 * e um unico FocusRequester circulando por composicao local. So o card que
 * corresponde ao endereco salvo o instala — os outros recebem null e nao pagam
 * nada por isso.
 */
class Restaurador {

    /**
     * Um requisitor por endereco, e nao um so que muda de dono.
     *
     * A diferenca importa no desempenho. Se o endereco focado fosse estado
     * observavel lido por cada card — para o card certo instalar o requisitor —,
     * cada toque de seta recomporia todos os cards visiveis da tela. Aqui o
     * card pega o seu requisitor uma vez e nunca mais le nada: mover o foco
     * deixa de custar recomposicao.
     */
    private val requisitores = HashMap<String, FocusRequester>()

    private var endereco: String? = null

    fun lembrar(chave: String) {
        endereco = chave
    }

    fun requisitorDe(chave: String): FocusRequester {
        // Teto de seguranca: uma sessao longa passando por muitas fileiras nao
        // pode acumular requisitor indefinidamente. Zerar custa perder a
        // restauracao de um retorno, o que e invisivel perto de vazar memoria.
        if (requisitores.size > 2000) requisitores.clear()
        return requisitores.getOrPut(chave) { FocusRequester() }
    }

    /**
     * Pede o foco de volta. Falha em silencio de proposito: se o card saiu da
     * composicao (fileira reordenada, catalogo recarregado), quem assume e a
     * primeira posicao focavel, e uma excecao aqui derrubaria a tela inteira.
     */
    fun restaurar() {
        val alvo = endereco ?: return
        runCatching { requisitores[alvo]?.requestFocus() }
    }
}

val LocalRestaurador = compositionLocalOf { Restaurador() }

/** Endereco estavel de um card dentro de uma fileira. */
fun enderecoDe(fileira: String, indice: Int): String = fileira + "#" + indice

/**
 * Torna um elemento navegavel por controle remoto.
 *
 * `clickable` ja trata DPAD_CENTER e ENTER como clique e ja torna o alvo
 * focavel — nao ha por que somar um `focusable` e um `onKeyEvent` a cada card.
 * A indicacao padrao (ripple) e removida: em televisao quem sinaliza estado e a
 * escala e a borda do proprio card, e o ripple de toque nao faz sentido a tres
 * metros.
 */
@Composable
fun Modifier.focavel(
    interacao: MutableInteractionSource,
    chaveFoco: String? = null,
    aoFocar: () -> Unit = {},
    aoClicar: () -> Unit,
): Modifier {
    val restaurador = LocalRestaurador.current
    val requisitor = chaveFoco?.let { chave ->
        remember(chave) { restaurador.requisitorDe(chave) }
    }
    return this
        .then(if (requisitor != null) Modifier.focusRequester(requisitor) else Modifier)
        .onFocusChanged { estado ->
            if (estado.isFocused) {
                if (chaveFoco != null) restaurador.lembrar(chaveFoco)
                aoFocar()
            }
        }
        .clickable(interactionSource = interacao, indication = null, onClick = aoClicar)
}

/**
 * Crescimento do item focado.
 *
 * 120 ms e o ponto em que o movimento e percebido como resposta e nao como
 * animacao: rapido o bastante para acompanhar quem segura a seta, longo o
 * bastante para o olho notar qual card mudou.
 */
@Composable
fun escalaFoco(focado: Boolean, alvo: Float = 1.08f): State<Float> =
    animateFloatAsState(
        targetValue = if (focado) alvo else 1f,
        animationSpec = tween(durationMillis = 120),
        label = "escalaFoco",
    )

/**
 * Aplica a escala de foco na camada de desenho.
 *
 * `graphicsLayer` e nao `scale` porque o valor e lido dentro do bloco de
 * desenho: a animacao troca de quadro sem recompor o card nem remedir a
 * fileira. Numa fileira de vinte posteres, essa diferenca e a diferenca entre
 * navegar liso e navegar aos trancos numa TV Box.
 */
fun Modifier.escalar(escala: State<Float>): Modifier = this.graphicsLayer {
    scaleX = escala.value
    scaleY = escala.value
}
