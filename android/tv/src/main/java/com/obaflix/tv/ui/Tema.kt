package com.obaflix.tv.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.TextUnit
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
    val Fundo = Color(0xFF111116)
    val Superficie = Color(0xFF1A1A21)
    val Destaque = Color(0xFFE5292E)
    val Texto = Color(0xFFF2F2F4)
    val TextoFraco = Color(0xFF9AA3AF)
    val Ok = Color(0xFF6FD49C)
    val Alerta = Color(0xFFE0B265)
    val Falha = Color(0xFFF09186)
}

object Escala {
    val Titulo: TextUnit = 40.sp
    val Secao: TextUnit = 24.sp
    val Corpo: TextUnit = 18.sp
    val Rotulo: TextUnit = 16.sp
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
