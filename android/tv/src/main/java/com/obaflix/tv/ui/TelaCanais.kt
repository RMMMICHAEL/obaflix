package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.CanalTv
import com.obaflix.tv.catalogo.CatalogoDeCanais
import com.obaflix.tv.navegacao.Aba
import com.obaflix.tv.navegacao.Camada
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.ui.componentes.EfeitoRestauraFoco
import com.obaflix.tv.ui.componentes.LocalFocoMoldura
import com.obaflix.tv.ui.componentes.Pilula
import com.obaflix.tv.ui.componentes.enderecoDe
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel

/**
 * Canais ao vivo na televisao.
 *
 * ## A regra que manda nesta tela
 *
 * **Passar o foco nao pede concessao, e nao inicia video.** So OK/ENTER abre um
 * canal. Nao e detalhe de interface: cada concessao resolve o canal no provedor
 * e cria uma sessao no Redis, e uma grade de cem canais percorrida com a seta
 * abriria cem sessoes em poucos segundos — contra o nosso backend e contra o
 * provedor ao mesmo tempo.
 *
 * Isso e o oposto do que a barra de abas faz (la, o foco ja troca a aba), e a
 * diferenca e proposital: trocar de aba custa um GET de catalogo; abrir um
 * canal custa uma sessao de reproducao.
 *
 * A pilula de categoria tambem **nao** usa `aplicaNoFoco`, pelo mesmo motivo em
 * escala menor: e filtro em memoria, mas trocar de categoria move o foco para a
 * grade, e atravessar onze categorias saltaria o cursor onze vezes.
 *
 * ## Sem cadeado, e sem EPG
 *
 * O catalogo ja vem recortado por entitlement, entao todo card aqui e abrivel e
 * nao ha estado de "bloqueado" para desenhar. Isso nao dispensa a checagem no
 * OK: a concessao decide do zero, porque um plano pode cair entre a listagem e
 * o toque.
 *
 * Nao ha programa, horario nem progresso — nao existe fonte confiavel nesta
 * fase. O selo AO VIVO e o que se sabe.
 */
@Composable
fun TelaCanais() {
    val foco = LocalFocoMoldura.current

    var catalogo by remember { mutableStateOf<CatalogoDeCanais?>(null) }
    var falhou by remember { mutableStateOf(false) }
    var categoria by remember { mutableStateOf("todos") }
    var tentativa by remember { mutableStateOf(0) }

    LaunchedEffect(tentativa) {
        falhou = false
        val r = ApiObaflix.canais()
        if (r == null) falhou = true else catalogo = r
    }

    val dados = catalogo
    val visiveis = remember(dados, categoria) {
        dados?.canais?.filter { categoria == "todos" || it.categoria == categoria }.orEmpty()
    }

    val primeiro = remember { FocusRequester() }
    var algumFocado by remember { mutableStateOf(false) }

    // Mesma regra das outras telas: a restauracao so age quando ninguem tem o
    // cursor, e nunca contra quem esta na barra de cima escolhendo a aba.
    EfeitoRestauraFoco(
        pronto = visiveis.isNotEmpty(),
        primeiro = primeiro,
        temFoco = { algumFocado },
        tag = "TelaCanais",
        permitido = { !foco.barraComFoco },
    )

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 48.dp)) {
        when {
            falhou -> Aviso(
                titulo = "Não foi possível carregar os canais",
                detalhe = "Verifique a conexão e tente de novo.",
                rotuloAcao = "Tentar de novo",
                aoAgir = { tentativa++ },
                requisitor = primeiro,
                aoFocar = { algumFocado = it },
            )

            dados == null -> Aviso(
                titulo = "Carregando canais…",
                detalhe = "",
                rotuloAcao = null,
                aoAgir = {},
                requisitor = primeiro,
                aoFocar = { algumFocado = it },
            )

            // Antes de "nenhum canal": a lista vazia de quem nao tem canais no
            // plano nao e falta de canal no ar, e dizer "voltam em breve" a
            // essa conta seria errado. Uma chamada so, onde o beneficio falta.
            dados.canais.isEmpty() && !dados.incluidoNoPlano -> Aviso(
                titulo = "Canais de TV não fazem parte do seu plano",
                detalhe = "Veja os planos com canais ao vivo.",
                rotuloAcao = "Ver planos",
                aoAgir = { Navegacao.abrirPlanos() },
                requisitor = primeiro,
                aoFocar = { algumFocado = it },
            )

            dados.canais.isEmpty() -> Aviso(
                titulo = "Nenhum canal disponível",
                detalhe = "Os canais ao vivo voltam em breve.",
                rotuloAcao = null,
                aoAgir = {},
                requisitor = primeiro,
                aoFocar = { algumFocado = it },
            )

            else -> {
                if (dados.categorias.size > 1) {
                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        contentPadding = PaddingValues(vertical = 12.dp),
                        modifier = Modifier.fillMaxWidth().focusGroup(),
                    ) {
                        items(dados.categorias, key = { it.id }) { c ->
                            Pilula(
                                texto = c.rotulo,
                                selecionado = categoria == c.id,
                                chaveFoco = "canais-cat#" + c.id,
                                aoClicar = { categoria = c.id },
                            )
                        }
                    }
                }

                if (visiveis.isEmpty()) {
                    Aviso(
                        titulo = "Categoria vazia",
                        detalhe = "Nenhum canal nesta categoria agora.",
                        rotuloAcao = "Ver todos",
                        aoAgir = { categoria = "todos" },
                        requisitor = primeiro,
                        aoFocar = { algumFocado = it },
                    )
                } else {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(6),
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                        contentPadding = PaddingValues(bottom = 48.dp),
                        modifier = Modifier.fillMaxSize().focusGroup(),
                    ) {
                        itemsIndexed(visiveis, key = { _, c -> c.id }) { i, canal ->
                            CardDeCanal(
                                canal = canal,
                                chaveFoco = enderecoDe("canais-" + categoria, i),
                                modifier = if (i == 0) Modifier.focusRequester(primeiro) else Modifier,
                                aoFocar = { algumFocado = it },
                                // Aqui, e so aqui, nasce uma sessao.
                                aoAbrir = { Navegacao.abrir(Camada.PlayerDeCanal(canal)) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * Um canal na grade.
 *
 * Card largo em vez de poster: logotipo de canal e horizontal, e espremer num
 * retangulo de cartaz deixaria metade deles ilegivel a tres metros.
 */
@Composable
private fun CardDeCanal(
    canal: CanalTv,
    chaveFoco: String,
    modifier: Modifier = Modifier,
    aoFocar: (Boolean) -> Unit,
    aoAbrir: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.06f)

    LaunchedEffect(focado) { if (focado) aoFocar(true) }

    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .height(132.dp)
            .escalar(escala)
            .clip(RoundedCornerShape(12.dp))
            .background(if (focado) Color(0xFF1F1F23) else Color(0xFF121214))
            .focavel(interacao = interacao, chaveFoco = chaveFoco, aoClicar = aoAbrir),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(12.dp),
        ) {
            if (canal.logoUrl.isNullOrBlank()) {
                // Fallback de logo ausente: as iniciais, nunca um vazio que faca
                // a grade parecer meio carregada.
                Text(
                    text = canal.nome.take(3).uppercase(),
                    color = Color(0xFF6B6B72),
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Black,
                    modifier = Modifier.height(56.dp),
                )
            } else {
                AsyncImage(
                    model = canal.logoUrl,
                    contentDescription = null,
                    modifier = Modifier.size(width = 104.dp, height = 56.dp),
                )
            }

            Text(
                text = canal.nome,
                color = if (focado) Color.White else Color(0xFFB4B4BB),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // Sem cadeado: `/api/canais` ja devolve so o que esta conta pode abrir,
        // entao nao existe card bloqueado nesta grade.
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
        ) {
            Selo("AO VIVO", Color(0xFFDC2626), Color.White)
        }
    }
}

@Composable
private fun Selo(texto: String, fundo: Color, cor: Color) {
    Text(
        text = texto,
        color = cor,
        fontSize = 9.sp,
        fontWeight = FontWeight.Black,
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(fundo)
            .padding(horizontal = 5.dp, vertical = 2.dp),
    )
}

/**
 * Estado sem grade: carregando, vazio, categoria vazia ou erro.
 *
 * Recebe o `primeiro` requisitor porque numa televisao um estado sem nenhum
 * alvo focavel prende o cursor: a seta nao tem para onde ir e a unica saida
 * vira o BACK. Quando ha acao, ela e o alvo; quando nao ha, a tela devolve o
 * foco para a barra de cima.
 */
@Composable
private fun Aviso(
    titulo: String,
    detalhe: String,
    rotuloAcao: String?,
    aoAgir: () -> Unit,
    requisitor: FocusRequester,
    aoFocar: (Boolean) -> Unit,
) {
    val foco = LocalFocoMoldura.current

    LaunchedEffect(rotuloAcao) {
        if (rotuloAcao == null) runCatching { foco.daAba(Aba.Canais.name).requestFocus() }
    }

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(titulo, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            if (detalhe.isNotBlank()) {
                Text(detalhe, color = Color(0xFF8A8A92), fontSize = 14.sp)
            }
            if (rotuloAcao != null) {
                val interacao = remember { MutableInteractionSource() }
                val focado by interacao.collectIsFocusedAsState()
                LaunchedEffect(focado) { if (focado) aoFocar(true) }
                Text(
                    text = rotuloAcao,
                    color = Color.White,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .focusRequester(requisitor)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (focado) Color(0xFFDC2626) else Color(0xFF27272A))
                        .focavel(interacao = interacao, aoClicar = aoAgir)
                        .padding(horizontal = 20.dp, vertical = 10.dp),
                )
            }
        }
    }
}
