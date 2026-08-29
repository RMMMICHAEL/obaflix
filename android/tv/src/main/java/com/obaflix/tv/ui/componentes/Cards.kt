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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.unit.Dp
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
 * Reproduzem o item de poster da referencia (layout_item_vod_programs /
 * item_home_column_program): poster 133x195dp, nome **sempre** visivel abaixo
 * em duas linhas, selo de nota no canto e barra de progresso quando ha o que
 * mostrar. O foco cresce o card, acende a borda branca e clareia o nome — os
 * tres juntos, porque um sinal so nao se le a tres metros.
 *
 * A arte usa a moldura ja desenhada enquanto nao chega: fileira sem placeholder
 * pisca em cinza e pula, com placeholder a tela nasce estavel.
 */

@Composable
private fun MolduraArte(
    largura: Dp,
    altura: Dp,
    focado: Boolean,
    modifier: Modifier = Modifier,
    conteudo: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit,
) {
    val escala = escalaFoco(focado, alvo = 1.06f)
    val forma = RoundedCornerShape(Medidas.Canto)
    Box(
        modifier = modifier
            .width(largura)
            .height(altura)
            .escalar(escala)
            .shadow(if (focado) 14.dp else 0.dp, forma)
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
        Box(Modifier.fillMaxSize().padding(8.dp), contentAlignment = Alignment.Center) {
            Text(
                text = titulo,
                color = Cores.TextoApagado,
                fontSize = Escala.Miudo,
                textAlign = TextAlign.Center,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.BoxScope.BarraProgresso(fracao: Float) {
    if (fracao <= 0f) return
    Box(
        modifier = Modifier
            .align(Alignment.BottomStart)
            .fillMaxWidth()
            .height(5.dp)
            .background(Color.Black.copy(alpha = 0.55f)),
    ) {
        Box(Modifier.fillMaxWidth(fracao).fillMaxHeight().background(Cores.Destaque))
    }
}

/** Selo de nota no canto inferior esquerdo, como o mTextScore da referencia. */
@Composable
private fun androidx.compose.foundation.layout.BoxScope.SeloNota(nota: Double?) {
    if (nota == null) return
    Box(
        modifier = Modifier
            .align(Alignment.BottomEnd)
            .padding(5.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(Color.Black.copy(alpha = 0.7f))
            .padding(horizontal = 5.dp, vertical = 1.dp),
    ) {
        Text(
            text = String.format("%.1f", nota),
            color = Cores.Nota,
            fontSize = Escala.Miudo,
            fontWeight = FontWeight.Bold,
        )
    }
}

/** Nome sob o poster: sempre visivel, clareia no foco (sel_text_color_white). */
@Composable
private fun NomeCard(texto: String, focado: Boolean, largura: Dp) {
    Text(
        text = texto,
        color = if (focado) Cores.Texto else Cores.TextoFraco,
        fontSize = Escala.Miudo,
        fontWeight = if (focado) FontWeight.Bold else FontWeight.Normal,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
        modifier = Modifier.width(largura).padding(top = 6.dp, start = 3.dp, end = 3.dp),
    )
}

@Composable
fun CardPoster(
    item: Item,
    chaveFoco: String,
    largura: Dp = Medidas.PosterLargura,
    altura: Dp = Medidas.PosterAltura,
    aoFocar: (Item) -> Unit = {},
    aoAbrir: (Item) -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()

    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(largura)) {
        MolduraArte(
            largura = largura,
            altura = altura,
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
        NomeCard(item.titulo, focado, largura)
    }
}

/**
 * Card deitado, para Continuar Assistindo.
 *
 * Usa o backdrop e nao o poster: quem volta para um conteudo ja sabe o que e, e
 * a cena diz "voce parou aqui" melhor que a capa. Espelha o
 * item_home_history_list da referencia (sombra na base + progresso).
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
        MolduraArte(
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
            ArteOuTitulo(ApiObaflix.imagem(item.background ?: item.poster, "w500"), item.titulo)
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(44.dp)
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
                    modifier = Modifier.align(Alignment.BottomStart).padding(8.dp, 10.dp),
                )
            }
            BarraProgresso(item.progresso)
        }
        NomeCard(item.titulo, focado, Medidas.PaisagemLargura)
    }
}

/**
 * Card de episodio deitado, para a faixa do player (thumb + numero).
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

    Column(modifier = Modifier.width(Medidas.PaisagemLargura)) {
        MolduraArte(
            largura = Medidas.PaisagemLargura,
            altura = Medidas.PaisagemAltura,
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
                    .height(40.dp)
                    .background(
                        Brush.verticalGradient(
                            listOf(Color.Transparent, Color.Black.copy(alpha = 0.85f)),
                        ),
                    ),
            )
            Row(
                modifier = Modifier.align(Alignment.BottomStart).padding(8.dp, 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (emReproducao) {
                    Box(Modifier.width(7.dp).height(7.dp).clip(RoundedCornerShape(4.dp)).background(Cores.Destaque))
                    Spacer(Modifier.width(5.dp))
                }
                Text("E" + episodio.numeroEp, color = Cores.Texto, fontSize = Escala.Miudo, fontWeight = FontWeight.Bold)
            }
            if (!episodio.disponivel) {
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                    Text("Indisponível", color = Cores.TextoFraco, fontSize = Escala.Miudo)
                }
            }
            BarraProgresso(progresso)
        }
        NomeCard(episodio.rotulo, focado, Medidas.PaisagemLargura)
    }
}

/**
 * Botao/atalho horizontal.
 *
 * Serve para filtro, acao e temporada: em televisao o que distingue um do outro
 * e a posicao, nao a forma. Um unico desenho de foco deixa a navegacao
 * previsivel.
 */
@Composable
fun Pilula(
    texto: String,
    selecionado: Boolean = false,
    principal: Boolean = false,
    chaveFoco: String? = null,
    modifier: Modifier = Modifier,
    /**
     * Aplica so por receber foco, com espera.
     *
     * Para filtro — ano, temporada, categoria — mover a seta ja e a escolha. O
     * `LaunchedEffect(focado)` cancela sozinho quando o foco sai, entao
     * atravessar dez anos nao dispara dez consultas.
     */
    aplicaNoFoco: Boolean = false,
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.05f)

    LaunchedEffect(focado) {
        if (!aplicaNoFoco || !focado || selecionado) return@LaunchedEffect
        kotlinx.coroutines.delay(280)
        aoClicar()
    }
    val forma = RoundedCornerShape(6.dp)

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
            .padding(horizontal = 18.dp, vertical = 9.dp),
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

/** Cabecalho de secao (icone + titulo 20sp), como item_home_column. */
@Composable
fun TituloSecao(texto: String, modifier: Modifier = Modifier) {
    Row(modifier = modifier.padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(4.dp).height(20.dp).clip(RoundedCornerShape(2.dp)).background(Cores.Destaque))
        EspacoH(10.dp)
        Text(text = texto, color = Cores.Texto, fontSize = Escala.Secao, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun EspacoV(altura: Dp) {
    Spacer(Modifier.height(altura))
}

@Composable
fun EspacoH(largura: Dp) {
    Spacer(Modifier.width(largura))
}

/** Linha de metadados: nota (ambar) · tipo · ano · gêneros. Some o que falta. */
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

val EspacoEntreCards = Arrangement.spacedBy(Medidas.EspacoCards)
