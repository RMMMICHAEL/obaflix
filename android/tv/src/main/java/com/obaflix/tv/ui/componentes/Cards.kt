package com.obaflix.tv.ui.componentes

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Episodio
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.ui.Cores
import com.obaflix.tv.ui.Escala
import com.obaflix.tv.ui.Medidas

/**
 * Cartoes do catalogo.
 *
 * Tres formatos, uma so linguagem visual: mesma borda de foco, mesma escala,
 * mesmo canto, mesma barra de progresso. O que muda e a proporcao — retrato
 * para poster, paisagem para o que precisa de cena (continuar assistindo,
 * episodio).
 *
 * Enquanto a arte nao chega, o lugar dela ja esta desenhado com o titulo em
 * cima do preenchimento. Fileira sem placeholder pisca em cinza e depois pula;
 * com placeholder, a tela nasce estavel e so ganha nitidez.
 */

@Composable
private fun MolduraCard(
    largura: androidx.compose.ui.unit.Dp,
    altura: androidx.compose.ui.unit.Dp,
    focado: Boolean,
    modifier: Modifier = Modifier,
    conteudo: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit,
) {
    val escala = escalaFoco(focado)
    val forma = RoundedCornerShape(Medidas.Canto)
    Box(
        modifier = modifier
            .width(largura)
            .height(altura)
            .escalar(escala)
            .shadow(if (focado) 16.dp else 0.dp, forma)
            .clip(forma)
            .background(Cores.Superficie)
            .border(
                width = if (focado) 3.dp else 0.dp,
                color = if (focado) Cores.FocoHalo else Color.Transparent,
                shape = forma,
            ),
        content = conteudo,
    )
}

@Composable
private fun ArteOuTitulo(url: String?, titulo: String) {
    if (url != null) {
        AsyncImage(
            model = url,
            contentDescription = titulo,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )
    } else {
        Box(Modifier.fillMaxSize().padding(12.dp), contentAlignment = Alignment.Center) {
            Text(
                text = titulo,
                color = Cores.TextoFraco,
                fontSize = Escala.Miudo,
                textAlign = TextAlign.Center,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * Barra de progresso.
 *
 * So aparece onde ha o que mostrar. Uma barra vazia em todo card viraria ruido
 * e tiraria justamente o sinal que faz Continuar Assistindo funcionar de longe.
 */
@Composable
private fun androidx.compose.foundation.layout.BoxScope.BarraProgresso(fracao: Float) {
    if (fracao <= 0f) return
    Box(
        modifier = Modifier
            .align(Alignment.BottomStart)
            .fillMaxWidth()
            .height(5.dp)
            .background(Color.Black.copy(alpha = 0.6f)),
    ) {
        Box(Modifier.fillMaxWidth(fracao).fillMaxHeight().background(Cores.Destaque))
    }
}

/** Selo de nota, no canto da arte. Some quando o catalogo nao tem nota. */
@Composable
private fun androidx.compose.foundation.layout.BoxScope.SeloNota(nota: Double?) {
    if (nota == null) return
    Box(
        modifier = Modifier
            .align(Alignment.TopEnd)
            .padding(6.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(Color.Black.copy(alpha = 0.66f))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Text(
            text = String.format("%.1f", nota),
            color = Cores.Nota,
            fontSize = Escala.Miudo,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
fun CardPoster(
    item: Item,
    chaveFoco: String,
    aoFocar: (Item) -> Unit = {},
    aoAbrir: (Item) -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()

    Column(modifier = Modifier.width(Medidas.PosterLargura)) {
        MolduraCard(
            largura = Medidas.PosterLargura,
            altura = Medidas.PosterAltura,
            focado = focado,
            modifier = Modifier.focavel(
                interacao = interacao,
                chaveFoco = chaveFoco,
                aoFocar = { aoFocar(item) },
                aoClicar = { aoAbrir(item) },
            ),
        ) {
            ArteOuTitulo(ApiObaflix.imagem(item.poster, "w342"), item.titulo)
            SeloNota(item.nota)
            BarraProgresso(item.progresso)
        }
        Text(
            text = item.titulo,
            color = if (focado) Cores.Texto else Cores.TextoFraco,
            fontSize = Escala.Miudo,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

/**
 * Card deitado, para Continuar Assistindo.
 *
 * Usa o backdrop e nao o poster: quem volta para um conteudo ja sabe o que e, e
 * a cena do filme diz "voce parou aqui" melhor do que a capa.
 */
@Composable
fun CardPaisagem(
    item: Item,
    chaveFoco: String,
    aoFocar: (Item) -> Unit = {},
    aoAbrir: (Item) -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()

    Column(modifier = Modifier.width(Medidas.PaisagemLargura)) {
        MolduraCard(
            largura = Medidas.PaisagemLargura,
            altura = Medidas.PaisagemAltura,
            focado = focado,
            modifier = Modifier.focavel(
                interacao = interacao,
                chaveFoco = chaveFoco,
                aoFocar = { aoFocar(item) },
                aoClicar = { aoAbrir(item) },
            ),
        ) {
            ArteOuTitulo(
                ApiObaflix.imagem(item.background ?: item.poster, "w780"),
                item.titulo,
            )
            // Degrade so na base: o rotulo do episodio precisa ser legivel sobre
            // qualquer cena, e escurecer a arte inteira apagaria o card.
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(56.dp)
                    .background(
                        Brush.verticalGradient(
                            listOf(Color.Transparent, Color.Black.copy(alpha = 0.85f)),
                        ),
                    ),
            )
            item.rotuloEpisodio?.let {
                Text(
                    text = it,
                    color = Cores.Texto,
                    fontSize = Escala.Miudo,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.align(Alignment.BottomStart).padding(10.dp, 12.dp),
                )
            }
            BarraProgresso(item.progresso)
        }
        Text(
            text = item.titulo,
            color = if (focado) Cores.Texto else Cores.TextoFraco,
            fontSize = Escala.Miudo,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

/**
 * Card de episodio.
 *
 * Mostra a fracao ja assistida vinda de Continuar Assistindo — e o mesmo
 * progresso sincronizado do site, nao um segundo controle local.
 */
@Composable
fun CardEpisodio(
    episodio: Episodio,
    progresso: Float,
    emReproducao: Boolean,
    chaveFoco: String,
    aoAbrir: (Episodio) -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()

    Column(modifier = Modifier.width(Medidas.EpisodioLargura)) {
        MolduraCard(
            largura = Medidas.EpisodioLargura,
            altura = Medidas.EpisodioAltura,
            focado = focado,
            modifier = Modifier.focavel(
                interacao = interacao,
                chaveFoco = chaveFoco,
                aoClicar = { aoAbrir(episodio) },
            ),
        ) {
            ArteOuTitulo(ApiObaflix.imagem(episodio.thumbnail, "w300"), episodio.rotulo)
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(48.dp)
                    .background(
                        Brush.verticalGradient(
                            listOf(Color.Transparent, Color.Black.copy(alpha = 0.85f)),
                        ),
                    ),
            )
            Row(
                modifier = Modifier.align(Alignment.BottomStart).padding(10.dp, 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (emReproducao) {
                    Box(
                        Modifier.size(8.dp).clip(RoundedCornerShape(4.dp)).background(Cores.Destaque),
                    )
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    text = "E" + episodio.numeroEp,
                    color = Cores.Texto,
                    fontSize = Escala.Miudo,
                    fontWeight = FontWeight.Bold,
                )
            }
            if (!episodio.disponivel) {
                Box(
                    Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.55f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(text = "Indisponível", color = Cores.TextoFraco, fontSize = Escala.Miudo)
                }
            }
            BarraProgresso(progresso)
        }
        Text(
            text = episodio.rotulo,
            color = if (focado) Cores.Texto else Cores.TextoFraco,
            fontSize = Escala.Miudo,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

/**
 * Botao horizontal de filtro e de acao.
 *
 * O mesmo componente serve para "Gênero", "Assistir" e "Temporada 2": em
 * televisao o que distingue um do outro e a posicao na tela, nao a forma. Um
 * unico desenho de foco para tudo deixa a navegacao previsivel.
 */
@Composable
fun Pilula(
    texto: String,
    selecionado: Boolean = false,
    principal: Boolean = false,
    chaveFoco: String? = null,
    modifier: Modifier = Modifier,
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.05f)
    val forma = RoundedCornerShape(50)

    val fundo = when {
        focado -> Cores.FocoHalo
        principal -> Cores.Destaque
        selecionado -> Cores.SuperficieAlta
        else -> Cores.Superficie
    }
    val corTexto = when {
        focado -> Color(0xFF101014)
        principal || selecionado -> Cores.Texto
        else -> Cores.TextoFraco
    }

    Box(
        modifier = modifier
            .escalar(escala)
            .clip(forma)
            .background(fundo)
            .border(
                width = if (selecionado && !focado) 2.dp else 0.dp,
                color = if (selecionado && !focado) Cores.Destaque else Color.Transparent,
                shape = forma,
            )
            .focavel(interacao = interacao, chaveFoco = chaveFoco, aoClicar = aoClicar)
            .padding(horizontal = 22.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = texto,
            color = corTexto,
            fontSize = Escala.Rotulo,
            fontWeight = if (principal || selecionado) FontWeight.Bold else FontWeight.Normal,
            maxLines = 1,
        )
    }
}

/** Cabecalho de secao. Existe para as fileiras e as grades falarem igual. */
@Composable
fun TituloSecao(texto: String, modifier: Modifier = Modifier) {
    Text(
        text = texto,
        color = Cores.Texto,
        fontSize = Escala.Secao,
        fontWeight = FontWeight.Bold,
        modifier = modifier.padding(bottom = 12.dp),
    )
}

/** Espaco vertical nomeado, para as telas nao ficarem cheias de Spacer solto. */
@Composable
fun EspacoV(altura: androidx.compose.ui.unit.Dp) {
    Spacer(Modifier.height(altura))
}

@Composable
fun EspacoH(largura: androidx.compose.ui.unit.Dp) {
    Spacer(Modifier.width(largura))
}

/** Linha de metadados: ano · gêneros · nota. Some o que o catalogo nao tem. */
@Composable
fun LinhaMeta(
    ano: Int?,
    nota: Double?,
    generos: List<String>,
    tipo: String?,
    modifier: Modifier = Modifier,
) {
    val partes = buildList {
        tipo?.let { add(it) }
        ano?.let { add(it.toString()) }
        if (generos.isNotEmpty()) add(generos.take(3).joinToString(", "))
    }
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        if (nota != null) {
            Text(
                text = String.format("%.1f", nota),
                color = Cores.Nota,
                fontSize = Escala.Rotulo,
                fontWeight = FontWeight.Bold,
            )
            EspacoH(12.dp)
        }
        Text(
            text = partes.joinToString("  ·  "),
            color = Cores.TextoFraco,
            fontSize = Escala.Rotulo,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Arrangement padrao das fileiras, para o espacamento nao divergir por tela. */
val EspacoEntreCards = Arrangement.spacedBy(Medidas.EspacoCards)
