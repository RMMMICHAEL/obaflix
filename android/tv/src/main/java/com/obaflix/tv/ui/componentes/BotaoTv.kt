package com.obaflix.tv.ui.componentes

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import com.obaflix.tv.ui.Cores

/**
 * Botao grande para decisao — convite, planos, recusa, continuacao.
 *
 * Maior que o `BotaoAcao` da ficha de proposito: ali ha uma linha de acoes
 * secundarias; aqui cada botao e uma escolha que a pessoa le a tres metros e
 * confirma com o OK. 56 dp de altura e texto de 18 sp.
 *
 * O foco e inequivoco pelos tres sinais ao mesmo tempo — preenchimento branco,
 * texto escuro e escala —, e nao so por cor: quem enxerga mal a diferenca entre
 * vermelho e cinza ainda ve o branco.
 */
@Composable
fun BotaoTv(
    texto: String,
    modifier: Modifier = Modifier,
    principal: Boolean = false,
    cor: Color = Cores.Destaque,
    aoFocar: () -> Unit = {},
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.06f)
    val forma = RoundedCornerShape(10.dp)
    val fundo = when {
        focado -> Cores.FocoHalo
        principal -> cor
        else -> Cores.SuperficieAlta
    }

    Box(
        modifier = modifier
            .height(56.dp)
            .escalar(escala)
            .clip(forma)
            .background(fundo)
            .border(
                width = 1.dp,
                color = if (focado || principal) Color.Transparent else Cores.Texto.copy(alpha = 0.16f),
                shape = forma,
            )
            .focavel(interacao = interacao, aoFocar = aoFocar, aoClicar = aoClicar)
            .padding(horizontal = 28.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = texto,
            color = if (focado) Color(0xFF101014) else Cores.Texto,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}
