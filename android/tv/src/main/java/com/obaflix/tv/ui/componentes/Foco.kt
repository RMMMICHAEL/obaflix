package com.obaflix.tv.ui.componentes

import android.util.Log
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.graphicsLayer
import kotlinx.coroutines.delay

/** Log temporario do ciclo de foco. Filtre por `adb logcat -s ObaFoco`. */
const val TAG_FOCO = "ObaFoco"

/**
 * Ponte para recuperar o foco de fora da composicao (da Activity).
 *
 * Serve a um caso so: o bug conhecido do Compose 1.6 em que a busca de foco 2D,
 * durante um key event, alcanca um no que o `bringIntoView` acabou de
 * desanexar num segundo passe de layout, e lanca "LayoutCoordinate operations
 * are only valid when isAttached is true". A Activity intercepta essa excecao
 * especifica, consome a tecla e chama `recuperar` para limpar o foco quebrado —
 * o proximo toque parte de um estado valido, sem crash e sem travar o D-pad.
 */
object FocoBridge {
    @Volatile
    var recuperar: (() -> Unit)? = null

    /**
     * Pulso de recuperacao. A Activity o incrementa (via `recuperar`) depois de
     * limpar um foco quebrado; as telas observam este valor e refazem a
     * restauracao, devolvendo o cursor ao card sem esperar um novo toque.
     */
    var pulso by mutableStateOf(0)
}

/**
 * Restauracao de foco entre telas.
 *
 * Quando a pessoa entra num conteudo e volta, a Home tem de devolver o cursor
 * ao mesmo card — nao ao primeiro. Guardamos o endereco do ultimo card focado
 * ("fileira#indice") e o FocusRequester de cada card, para pedir o foco de volta
 * ao card certo quando a tela reaparece.
 *
 * O que mudou depois do crash "LayoutCoordinate operations are only valid when
 * isAttached is true": a tela de baixo **nao fica mais composta** sob o overlay
 * (ver AppTv). Antes ficava, e a LazyRow reciclava o card que ainda constava
 * como focado; a proxima seta fazia a busca de foco andar por um no ja
 * desanexado e derrubava o app. Sem a tela de baixo composta, nao existe no
 * desanexado com foco — e a restauracao aqui so pede foco a card que existe.
 */
class Restaurador {

    private val requisitores = HashMap<String, FocusRequester>()

    /** Ultimo card focado, lido na restauracao. Publico so para leitura. */
    var endereco: String? = null
        private set

    fun lembrar(chave: String) {
        endereco = chave
    }

    fun requisitorDe(chave: String): FocusRequester {
        if (requisitores.size > 2000) requisitores.clear()
        return requisitores.getOrPut(chave) { FocusRequester() }
    }

    /** Requisitor do card salvo, se ja existe um. Null quando nao ha o que restaurar. */
    fun requisitorSalvo(): FocusRequester? = endereco?.let { requisitores[it] }
}

val LocalRestaurador = compositionLocalOf { Restaurador() }

/**
 * Quem manda no foco vertical da moldura.
 *
 * Existe para separar duas coisas que estavam grudadas: **trocar de aba** e
 * **entrar no conteudo**. A aba troca ao mover a seta na barra de cima; o
 * conteudo carrega sozinho; mas o cursor tinha de continuar na barra, para a
 * pessoa poder percorrer Inicio → Filmes → Series → Kids → Animes sem ser
 * jogada para os cards a cada passo e ter de subir de novo.
 *
 * Antes nao havia essa separacao: a restauracao de foco de cada tela disparava
 * assim que os dados chegavam, e como trocar de aba faz dados chegarem, ela
 * puxava o foco para o primeiro card toda vez. `barraComFoco` e o sinal que
 * impede isso — enquanto a barra tem o cursor, nenhuma tela o toma.
 */
class FocoMoldura {

    private val abas = HashMap<String, FocusRequester>()

    /** A barra de cima esta com o cursor agora? */
    var barraComFoco by mutableStateOf(false)

    /** Chave da aba aberta, para o retorno do conteudo saber a quem subir. */
    var abaAtiva by mutableStateOf("")

    fun daAba(chave: String): FocusRequester = abas.getOrPut(chave) { FocusRequester() }

    /**
     * Requisitor da opcao correspondente a aba aberta.
     *
     * `FocusRequester.Default` quando ainda nao ha aba conhecida: pedir foco a
     * um requisitor sem no anexado lanca excecao, e o padrao devolve a busca
     * espacial comum — que e o comportamento certo para "nao sei ainda".
     */
    val requisitorAtivo: FocusRequester
        get() = abas[abaAtiva] ?: FocusRequester.Default
}

val LocalFocoMoldura = compositionLocalOf { FocoMoldura() }

/**
 * Restaura o foco de uma tela quando ela fica ativa e os dados chegaram.
 *
 * E a peca central da correcao do "so funciona depois do mouse". Regras:
 *
 *  - **So depois dos dados.** Pedir foco antes de os cards existirem falha
 *    calado (o no nao esta na composicao). O gatilho e `pronto`.
 *  - **Espera o frame.** `withFrameNanos` garante que a composicao ja mediu e
 *    posicionou os alvos antes do requestFocus — o equivalente ao awaitFrame.
 *  - **Insiste e verifica.** Repete ate `temFoco()` virar verdadeiro; sem esse
 *    sinal de confirmacao, um unico pedido que falha deixa a tela sem foco.
 *  - **Card salvo primeiro, primeiro item depois.** Nas primeiras tentativas
 *    tenta o card de onde a pessoa saiu; se ele nao aparece (troca de aba,
 *    catalogo diferente), cai para o primeiro focavel da tela.
 *  - **Nunca contra o cursor de quem esta navegando.** `permitido` e conferido
 *    a cada volta, e nao so na entrada: os dados de uma aba podem chegar
 *    segundos depois, quando a pessoa ja seguiu para outra opcao da barra, e
 *    puxar o foco naquele instante e ainda pior do que puxar no comeco.
 *
 * O `permitido` de cada tela tem de cobrir **a tela inteira**, e nao so a barra
 * de cima. Trocar de categoria ou de ano recarrega a lista: ela sai da
 * composicao por um instante e volta — e a restauracao, que existe para dar
 * cursor a quem nao tem nenhum, atropelava quem estava na barra lateral
 * escolhendo o filtro. Quem ja tem o cursor manda; a restauracao so age quando
 * ninguem tem.
 */
@Composable
fun EfeitoRestauraFoco(
    pronto: Boolean,
    primeiro: FocusRequester,
    temFoco: () -> Boolean,
    tag: String,
    permitido: () -> Boolean = { true },
) {
    val restaurador = LocalRestaurador.current
    LaunchedEffect(pronto, FocoBridge.pulso) {
        if (!pronto) return@LaunchedEffect
        if (!permitido()) {
            Log.d(TAG_FOCO, "$tag pronto, mas o foco esta na barra — nao puxa")
            return@LaunchedEffect
        }
        Log.d(TAG_FOCO, "$tag pronto — restaurando (salvo=${restaurador.endereco}, pulso=${FocoBridge.pulso})")
        var i = 0
        while (i < 24 && !temFoco() && permitido()) {
            withFrameNanos { }
            val salvo = if (i < 8) restaurador.requisitorSalvo() else null
            val alvo = salvo ?: primeiro
            runCatching { alvo.requestFocus() }
                .onFailure { Log.d(TAG_FOCO, "$tag requestFocus falhou i=$i: ${it.javaClass.simpleName}") }
            delay(50)
            i++
        }
        Log.d(TAG_FOCO, "$tag restauracao terminou temFoco=${temFoco()} tentativas=$i")
    }
}

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
