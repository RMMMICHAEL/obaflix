package com.obaflix.tv.ui.componentes

import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.obaflix.tv.catalogo.Fileira
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.ui.Medidas
import kotlinx.coroutines.launch

/**
 * Fileira horizontal do catalogo — o item_home_column da referencia.
 *
 * A folga **vertical** do contentPadding existe para o card focado poder
 * crescer sem ser recortado. A folga **horizontal** e a margem de tela; ela nao
 * vai no elemento pai porque o card tem de poder rolar ate a borda fisica — e o
 * conteudo que anda por baixo da margem, nao a margem que corta a fileira.
 *
 * focusGroup + chave estavel andam juntos: sem os dois, a travessia de foco
 * alcancava um no ja reciclado pela LazyRow e o app caia com "LayoutCoordinate
 * operations are only valid when isAttached is true" ao navegar.
 *
 * ## Entrar na fileira sempre pelo primeiro card
 *
 * A busca de foco 2D do Compose escolhe, ao descer, o card geometricamente mais
 * proximo — o que preserva a coluna. Numa grade isso e o certo; numa fileira de
 * carrossel, nao: quem estava no 5o card de "Em alta" descia e caia no 5o de
 * "Populares", uma posicao que nao escolheu e que muitas vezes esta fora da
 * tela porque as fileiras tem larguras de card diferentes.
 *
 * `enter` resolve na origem certa: ele so e consultado quando o foco **entra**
 * no grupo, ou seja, nas setas para cima e para baixo. Esquerda e direita
 * andam dentro do mesmo grupo e nao passam por aqui — a navegacao horizontal
 * fica exatamente como estava.
 */
@Composable
fun FileiraCatalogo(
    fileira: Fileira,
    margem: Dp,
    aoFocar: (Item) -> Unit,
    aoAbrir: (Item) -> Unit,
) {
    val rolagem = rememberLazyListState()
    val escopo = rememberCoroutineScope()
    val primeiro = remember { FocusRequester() }

    Column {
        TituloSecao(fileira.titulo, Modifier.padding(start = margem))
        LazyRow(
            state = rolagem,
            horizontalArrangement = EspacoEntreCards,
            contentPadding = PaddingValues(start = margem, end = margem, top = 4.dp, bottom = 10.dp),
            modifier = Modifier
                .focusGroup()
                .focusProperties { enter = { primeiro } }
                // Devolve a fileira ao inicio quando o cursor sai dela.
                //
                // Nao e cosmetico: `enter` pede foco ao card de indice 0, e a
                // LazyRow descarta o que esta fora da janela. Sem isto, subir de
                // volta para uma fileira que ficou rolada la no meio pediria foco
                // a um no que nao existe mais, e a seta simplesmente nao
                // responderia. Rolar ao sair garante que o indice 0 esta sempre
                // composto quando alguem entra.
                //
                // A restauracao entre telas (Foco.kt) nao se perde com isso: ela
                // pede foco direto ao card salvo, e com a fileira no inicio os
                // primeiros cards continuam compostos — que ja era a unica
                // situacao em que ela funcionava, porque a tela de baixo nao fica
                // composta sob o overlay e a rolagem se perde de qualquer forma.
                .onFocusChanged { estado ->
                    if (!estado.hasFocus && rolagem.firstVisibleItemIndex != 0) {
                        escopo.launch { runCatching { rolagem.scrollToItem(0) } }
                    }
                },
        ) {
            itemsIndexed(
                fileira.itens,
                key = { _, item -> fileira.id + item.chaveProgresso },
            ) { indice, item ->
                val chave = enderecoDe(fileira.id, indice)
                // So o primeiro card carrega o requisitor de entrada da fileira.
                val entrada = if (indice == 0) Modifier.focusRequester(primeiro) else Modifier
                if (fileira.paisagem) {
                    CardPaisagem(item, chave, aoFocar = aoFocar, modifier = entrada, aoAbrir = aoAbrir)
                } else {
                    CardPoster(item, chave, aoFocar = aoFocar, modifier = entrada, aoAbrir = aoAbrir)
                }
            }
        }
    }
}

/**
 * Quantas colunas cabem na largura util. A referencia usa 6 para o catalogo;
 * calculamos para 720p, 1080p e 4K caberem sem sobrar borda nem vazar.
 */
fun colunas(larguraDisponivelDp: Int): Int {
    val passo = Medidas.PosterLargura.value + Medidas.EspacoCards.value
    return ((larguraDisponivelDp + Medidas.EspacoCards.value) / passo).toInt().coerceIn(4, 9)
}
