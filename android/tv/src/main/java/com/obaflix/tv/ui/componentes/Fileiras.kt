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
 *
 * ## Por que nao ha `focusProperties.enter` aqui
 *
 * Uma tentativa anterior (0.7.27) forcava o foco de entrada para o card de
 * indice 0 via `focusProperties { enter = { primeiro } }`, para nao cair no
 * card geometricamente mais proximo de uma fileira vizinha de largura
 * diferente. Em TV fisica isso travava o app de forma reproduzivel: descer o
 * D-pad para a fileira seguinte congelava a navegacao por completo, sem
 * excecao reconhecida pela rede de seguranca do isAttached em MainActivity —
 * o unico teste existente verificava a presenca do texto no arquivo, nao o
 * foco vivo (ver comentario em FileirasTest.kt). Sem um teste instrumentado
 * de Compose para provar a correcao antes de reintroduzi-la, o comportamento
 * volta a ser so a busca 2D padrao do Compose.
 */
@Composable
fun FileiraCatalogo(
    fileira: Fileira,
    margem: Dp,
    aoFocar: (Item) -> Unit,
    aoAbrir: (Item) -> Unit,
) {
    // Fileira sem card nao participa da navegacao.
    if (fileira.itens.isEmpty()) return

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
                    CardPaisagem(
                        item = item,
                        chaveFoco = chave,
                        aoFocar = aoFocar,
                        aoAbrir = aoAbrir,
                    )
                } else {
                    CardPoster(item, chave, aoFocar = aoFocar, aoAbrir = aoAbrir)
                }
            }
        }
    }
}

/**
 * Fileiras que participam da navegacao: somente as que possuem card.
 */
fun fileirasNavegaveis(fileiras: List<Fileira>): List<Fileira> =
    fileiras.filter { it.itens.isNotEmpty() }

/** A Home possui ao menos um alvo navegavel. */
fun homeNavegavel(home: com.obaflix.tv.catalogo.Home): Boolean =
    home.destaques.isNotEmpty() || fileirasNavegaveis(home.fileiras).isNotEmpty()

/**
 * Quantas colunas cabem na largura util. A referencia usa 6 para o catalogo;
 * calculamos para 720p, 1080p e 4K caberem sem sobrar borda nem vazar.
 */
fun colunas(larguraDisponivelDp: Int): Int {
    val passo = Medidas.PosterLargura.value + Medidas.EspacoCards.value
    return ((larguraDisponivelDp + Medidas.EspacoCards.value) / passo).toInt().coerceIn(4, 9)
}
