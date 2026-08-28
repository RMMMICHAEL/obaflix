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
    val Fundo = Color(0xFF08080B)
    /** Vinheta sobre a arte de fundo da Home. */
    val Veu = Color(0xFF08080B)
    val Superficie = Color(0xFF16161D)
    val SuperficieAlta = Color(0xFF23232C)
    val Destaque = Color(0xFFE5292E)
    val Texto = Color(0xFFF4F4F6)
    val TextoFraco = Color(0xFF9AA3AF)
    val TextoApagado = Color(0xFF6B7280)
    /** Realce do item focado. Branco puro: e o unico ponteiro que a TV tem. */
    val FocoHalo = Color(0xFFFFFFFF)
    val Ok = Color(0xFF6FD49C)
    val Alerta = Color(0xFFE0B265)
    val Falha = Color(0xFFF09186)
    val Nota = Color(0xFFF5C518)
}

object Escala {
    val Hero: TextUnit = 46.sp
    val Titulo: TextUnit = 34.sp
    val Secao: TextUnit = 22.sp
    val Corpo: TextUnit = 18.sp
    val Rotulo: TextUnit = 16.sp
    val Miudo: TextUnit = 14.sp
}

/**
 * Medidas dos cartoes.
 *
 * Ficam num objeto so porque a fileira, o card e o calculo de quantos cabem na
 * grade precisam concordar. Quando divergem, a grade quebra na terceira coluna
 * e so aparece em televisao de proporcao diferente da que se testou.
 */
object Medidas {
    val PosterLargura: Dp = 168.dp
    val PosterAltura: Dp = 252.dp
    val PaisagemLargura: Dp = 300.dp
    val PaisagemAltura: Dp = 169.dp
    val EpisodioLargura: Dp = 260.dp
    val EpisodioAltura: Dp = 146.dp
    val EspacoCards: Dp = 18.dp
    val EspacoFileiras: Dp = 30.dp
    val Canto: Dp = 10.dp
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
