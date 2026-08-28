package com.obaflix.tv.ui.componentes

import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.obaflix.tv.catalogo.Fileira
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.ui.Medidas

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
 */
@Composable
fun FileiraCatalogo(
    fileira: Fileira,
    margem: Dp,
    aoFocar: (Item) -> Unit,
    aoAbrir: (Item) -> Unit,
) {
    Column {
        TituloSecao(fileira.titulo, Modifier.padding(start = margem))
        LazyRow(
            horizontalArrangement = EspacoEntreCards,
            contentPadding = PaddingValues(start = margem, end = margem, top = 4.dp, bottom = 10.dp),
            modifier = Modifier.focusGroup(),
        ) {
            itemsIndexed(
                fileira.itens,
                key = { _, item -> fileira.id + item.chaveProgresso },
            ) { indice, item ->
                val chave = enderecoDe(fileira.id, indice)
                if (fileira.paisagem) {
                    CardPaisagem(item, chave, aoFocar, aoAbrir)
                } else {
                    CardPoster(item, chave, aoFocar = aoFocar, aoAbrir = aoAbrir)
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
