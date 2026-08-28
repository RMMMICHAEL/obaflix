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
 * Fileira horizontal do catalogo.
 *
 * Duas medidas explicam o resto do arquivo:
 *
 *  - A folga **vertical** do `contentPadding` existe para o card focado poder
 *    crescer. Sem ela a LazyRow recorta a borda de cima e de baixo no exato
 *    momento em que o card precisa se destacar — o efeito vira defeito.
 *  - A folga **horizontal** e a margem segura. Ela nao vai no elemento pai
 *    porque o card tem de poder rolar ate a borda fisica da tela; e o conteudo
 *    que anda por baixo da margem, nao a margem que corta a fileira.
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
            contentPadding = PaddingValues(start = margem, end = margem, top = 6.dp, bottom = 14.dp),
            // focusGroup e chave estavel andam juntos aqui, e nao sao enfeite:
            // sem os dois, a travessia de foco alcancava um no que a LazyRow ja
            // tinha reciclado e o aplicativo caia com "LayoutCoordinate
            // operations are only valid when isAttached is true" ao navegar.
            modifier = Modifier.focusGroup(),
        ) {
            itemsIndexed(fileira.itens, key = { _, item -> fileira.id + item.chaveProgresso }) { indice, item ->
                val chave = enderecoDe(fileira.id, indice)
                if (fileira.paisagem) {
                    CardPaisagem(item, chave, aoFocar, aoAbrir)
                } else {
                    CardPoster(item, chave, aoFocar, aoAbrir)
                }
            }
        }
    }
}

/**
 * Quantas colunas cabem na largura util.
 *
 * Calculado e nao fixado em seis: 720p, 1080p e 4K chegam aqui com larguras de
 * dp diferentes, e uma grade fixa ou sobra borda numa ou vaza na outra.
 */
fun colunas(larguraTelaDp: Int, margemDp: Int): Int {
    val util = larguraTelaDp - margemDp * 2
    val passo = Medidas.PosterLargura.value + Medidas.EspacoCards.value
    return ((util + Medidas.EspacoCards.value) / passo).toInt().coerceIn(3, 9)
}
