package com.obaflix.tv.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.darkColorScheme

/**
 * Valores de 10 pes.
 *
 * A TV e lida a cerca de tres metros. O que funciona no celular fica ilegivel
 * aqui, entao o piso e 16sp e o corpo padrao e 18sp — o dobro do que um app de
 * telefone usaria para o mesmo papel.
 */
object Cores {
    /** Preto quase puro: em painel OLED o fundo some e so o poster fica. */
    val Fundo = Color(0xFF0A0A0D)
    /** Vinheta sobre a arte de fundo da Home. */
    val Veu = Color(0xFF0A0A0D)
    val Superficie = Color(0xFF16161D)
    val SuperficieAlta = Color(0xFF23232C)
    /** Barra lateral e trilhos, um degrau acima do fundo. */
    val Painel = Color(0xFF101015)
    val Destaque = Color(0xFFE5292E)
    val Texto = Color(0xFFFFFFFF)
    /** color_font_normal (#c4c4c4) da referencia: nome de card, texto de apoio. */
    val TextoFraco = Color(0xFFC4C4C4)
    /** color_detail_font_des (#858d94): rotulos de campo na ficha. */
    val TextoApagado = Color(0xFF858D94)
    /** Realce do item focado. Branco puro: e o unico ponteiro que a TV tem. */
    val FocoHalo = Color(0xFFFFFFFF)
    val Ok = Color(0xFF6FD49C)
    val Alerta = Color(0xFFE0B265)
    val Falha = Color(0xFFF09186)
    /** color_font_height_light (#ffaa00): nota e destaques numericos. */
    val Nota = Color(0xFFFFAA00)
}

/**
 * Tamanhos de texto.
 *
 * Vindos da referencia (design 1920x1080), convertidos de px para sp na razao
 * 1sp = 2px: titulo da ficha 58px->29sp, secao 40px->20sp, campo 28px->14sp.
 * O piso continua legivel a tres metros.
 */
object Escala {
    val Hero: TextUnit = 40.sp
    val Titulo: TextUnit = 29.sp
    val Secao: TextUnit = 20.sp
    val Corpo: TextUnit = 16.sp
    val Rotulo: TextUnit = 15.sp
    val Miudo: TextUnit = 13.sp
}

/**
 * Medidas, derivadas dos XML da referencia (design 1920x1080, dp = px / 2).
 *
 * Ficam num objeto so porque a fileira, o card e o calculo de quantos cabem na
 * grade precisam concordar. A densidade e proposital: a referencia usa poster
 * de 266x390px (133x195dp) com 6 colunas, e nao o card grande e espacado que
 * deixava a tela com aspecto de prototipo.
 */
object Medidas {
    /** Poster retrato: 266x390px na referencia. */
    val PosterLargura: Dp = 133.dp
    val PosterAltura: Dp = 195.dp
    /** Card deitado (continuar/horizon): 410x230px. */
    val PaisagemLargura: Dp = 205.dp
    val PaisagemAltura: Dp = 115.dp
    /** Poster de relacionados: 200x294px. */
    val SimilarLargura: Dp = 118.dp
    val SimilarAltura: Dp = 173.dp
    /** Banner de destaque: 867x542px, dois lado a lado. */
    val BannerAltura: Dp = 268.dp
    /** Margem de tela: 90px. */
    val Margem: Dp = 45.dp
    /** horizontalSpacing 10px entre posters. */
    val EspacoCards: Dp = 6.dp
    val EspacoFileiras: Dp = 22.dp
    val Canto: Dp = 6.dp
    /** Barra lateral da tela de catalogo: 320px. */
    val RailLargura: Dp = 168.dp
    /** Painel do teclado de busca: 400dp fixos na referencia. */
    val TecladoLargura: Dp = 380.dp
    /** Botao de acao da ficha: 276x68px. */
    val BotaoAcaoAltura: Dp = 40.dp
}

/**
 * Tema do aplicativo de TV.
 *
 * O esquema escuro e o padrao e nao ha alternativa clara: televisao se assiste
 * em sala com pouca luz, e fundo claro em tela grande cansa e lava o contraste
 * do poster. Nao e economia de trabalho — e a escolha certa para o meio.
 *
 * Os componentes do Compose for TV leem o esquema daqui para desenhar o foco.
 * As cores de texto sao passadas explicitamente em cada chamada, para o
 * contraste sobre `Cores.Fundo` nao depender de um padrao que pode mudar entre
 * versoes alpha da biblioteca.
 */
@Composable
fun TemaObaflixTv(conteudo: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(), content = conteudo)
}
