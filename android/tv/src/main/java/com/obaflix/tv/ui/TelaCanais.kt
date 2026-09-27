@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.obaflix.tv.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.CanalTv
import com.obaflix.tv.catalogo.CatalogoDeCanais
import com.obaflix.tv.catalogo.Concessao
import com.obaflix.tv.navegacao.Aba
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.ui.componentes.EfeitoRestauraFoco
import com.obaflix.tv.ui.componentes.LocalFocoMoldura
import com.obaflix.tv.ui.componentes.enderecoDe
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel
import kotlinx.coroutines.delay

/**
 * Canais ao vivo na televisao — a mesma identidade da tela web/Electron.
 *
 * Painel de canais a esquerda (~30%: categorias + lista) e previa grande a
 * direita, ocupando o resto. Sem EPG: nao ha fonte confiavel de programacao, e
 * um horario inventado erra na tela de quem olha.
 *
 * ## Previa com espera, e um player so
 *
 * Passar o foco por um canal **nao** pede `/play` na hora: a previa so abre se
 * o foco **parar** no canal por `ATRASO_PREVIA_MS`. Quem atravessa a lista com
 * a seta nao abre uma sessao por canal. Existe um unico ExoPlayer na tela
 * (`PlayerDeCanalTv`), compartilhado entre a previa e a tela cheia: trocar de
 * canal encerra o anterior por inteiro antes de abrir o proximo.
 *
 * ## Controle remoto
 *
 * - ↑/↓ na lista navegam; a lista rola acompanhando o foco.
 * - OK abre o canal em tela cheia (o mesmo player, sem novo `/play`).
 * - Em tela cheia, ↑ vai para o proximo canal e ↓ para o anterior, sem sair da
 *   tela cheia (com a mesma espera, para nao abrir um `/play` por toque).
 * - BACK sai da tela cheia e devolve o foco ao canal em reproducao.
 */
@Composable
fun TelaCanais() {
    val foco = LocalFocoMoldura.current
    val controle = rememberPlayerDeCanalTv()

    var catalogo by remember { mutableStateOf<CatalogoDeCanais?>(null) }
    var falhou by remember { mutableStateOf(false) }
    var categoria by remember { mutableStateOf("todos") }
    var tentativa by remember { mutableIntStateOf(0) }
    var telaCheia by remember { mutableStateOf(false) }
    var focadoId by remember { mutableStateOf<String?>(null) }
    /** Pedido de devolver o foco ao canal atual (saida da tela cheia). */
    var devolverFoco by remember { mutableIntStateOf(0) }

    LaunchedEffect(tentativa) {
        falhou = false
        val r = ApiObaflix.canais()
        if (r == null) falhou = true else catalogo = r
    }

    val dados = catalogo
    val visiveis = remember(dados, categoria) {
        dados?.canais?.filter { categoria == "todos" || it.categoria == categoria }.orEmpty()
    }
    /** Numero estavel do canal: a posicao no catalogo, independente do filtro. */
    val numeroDe = remember(dados) { dados?.canais?.withIndex()?.associate { it.value.id to it.index + 1 }.orEmpty() }
    val rotuloDe = remember(dados) { dados?.categorias?.associate { it.id to it.rotulo }.orEmpty() }

    val lista = rememberLazyListState()
    val requisitores = remember { mutableMapOf<String, FocusRequester>() }
    fun requisitorDe(id: String) = requisitores.getOrPut(id) { FocusRequester() }
    val primeiro = remember { FocusRequester() }
    var algumFocado by remember { mutableStateOf(false) }

    EfeitoRestauraFoco(
        pronto = visiveis.isNotEmpty() && !telaCheia,
        primeiro = primeiro,
        temFoco = { algumFocado },
        tag = "TelaCanais",
        permitido = { !foco.barraComFoco && !telaCheia },
    )

    // Previa com espera: so abre se o foco parar no canal.
    LaunchedEffect(focadoId, telaCheia) {
        val id = focadoId ?: return@LaunchedEffect
        if (telaCheia) return@LaunchedEffect
        delay(ATRASO_PREVIA_MS)
        visiveis.firstOrNull { it.id == id }?.let(controle::abrir)
    }

    // Saida da tela cheia: foco de volta no canal em reproducao, rolando ate ele.
    LaunchedEffect(devolverFoco) {
        if (devolverFoco == 0) return@LaunchedEffect
        val id = controle.canal?.id ?: return@LaunchedEffect
        val indice = visiveis.indexOfFirst { it.id == id }
        if (indice < 0) return@LaunchedEffect
        lista.scrollToItem(indice)
        withFrameNanos { }
        runCatching { requisitorDe(id).requestFocus() }
    }

    fun agir(canal: CanalTv) {
        val estado = controle.estado
        if (controle.canal?.id == canal.id && estado is EstadoDoCanal.Erro) {
            when (estado.motivo) {
                is Concessao.PrecisaDeUpgrade -> Navegacao.abrirPlanos()
                else -> controle.atualizar()
            }
            return
        }
        controle.abrir(canal)
        focadoId = canal.id
        telaCheia = true
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(CoresLive.Fundo)
            .padding(start = Medidas.Margem, end = Medidas.Margem, bottom = 24.dp),
    ) {
        Cabecalho()

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
            // plano nao e falta de canal no ar.
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

            else -> Row(
                horizontalArrangement = Arrangement.spacedBy(20.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                // PAINEL: categorias + lista (so a lista rola)
                Column(
                    modifier = Modifier
                        .fillMaxWidth(0.3f)
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(16.dp))
                        .background(CoresLive.Superficie)
                        .border(1.dp, CoresLive.Borda.copy(alpha = 0.7f), RoundedCornerShape(16.dp))
                        .padding(12.dp),
                ) {
                    if (dados.categorias.size > 1) {
                        LazyRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            contentPadding = PaddingValues(horizontal = 2.dp, vertical = 4.dp),
                            modifier = Modifier.fillMaxWidth().focusGroup(),
                        ) {
                            items(dados.categorias, key = { it.id }) { c ->
                                ChipDeCategoria(
                                    texto = c.rotulo,
                                    selecionado = categoria == c.id,
                                    chaveFoco = "canais-cat#" + c.id,
                                    aoClicar = { categoria = c.id },
                                )
                            }
                        }
                        Spacer(Modifier.height(10.dp))
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
                        LazyColumn(
                            state = lista,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 6.dp),
                            modifier = Modifier.fillMaxSize().focusGroup(),
                        ) {
                            itemsIndexed(visiveis, key = { _, c -> c.id }) { i, canal ->
                                LinhaDeCanal(
                                    canal = canal,
                                    numero = numeroDe[canal.id] ?: (i + 1),
                                    subtitulo = rotuloDe[canal.categoria].orEmpty(),
                                    ativo = controle.canal?.id == canal.id,
                                    chaveFoco = enderecoDe("canais-" + categoria, i),
                                    modifier = Modifier
                                        .focusRequester(requisitorDe(canal.id))
                                        .then(if (i == 0) Modifier.focusRequester(primeiro) else Modifier),
                                    aoFocar = {
                                        algumFocado = true
                                        focadoId = canal.id
                                    },
                                    aoAbrir = { agir(canal) },
                                )
                            }
                        }
                    }
                }

                // PREVIA: ocupa todo o resto
                Previa(
                    controle = controle,
                    telaCheia = telaCheia,
                    modifier = Modifier.weight(1f).fillMaxHeight(),
                )
            }
        }
    }

    if (telaCheia && controle.canal != null) {
        TelaCheiaDeCanal(
            controle = controle,
            canais = visiveis,
            aoTrocar = { novo ->
                controle.abrir(novo)
                focadoId = novo.id
            },
            aoSair = {
                telaCheia = false
                devolverFoco++
            },
        )
    }
}

/** Espera antes de abrir a previa do canal focado. */
private const val ATRASO_PREVIA_MS = 650L
/** Espera antes de trocar de canal com ↑/↓ na tela cheia. */
private const val ATRASO_TROCA_MS = 600L
/** Controles da tela cheia somem depois deste tempo sem tecla. */
private const val CONTROLES_SOMEM_MS = 4_000L

@Composable
private fun Cabecalho() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier.padding(top = 6.dp, bottom = 16.dp),
    ) {
        IconeAoVivo(tamanho = 30.dp)
        Column {
            Text(
                text = "Canais ao vivo",
                color = Color.White,
                fontSize = 28.sp,
                fontWeight = FontWeight.ExtraBold,
            )
            Text(
                text = "Assista seus canais favoritos em tempo real.",
                color = CoresLive.TextoApagado,
                fontSize = 14.sp,
            )
        }
    }
}

/** Icone de transmissao: ponto central e duas ondas de cada lado. */
@Composable
private fun IconeAoVivo(tamanho: Dp, cor: Color = CoresLive.Vermelho) {
    Canvas(modifier = Modifier.size(tamanho)) {
        val c = Offset(size.width / 2, size.height / 2)
        val traco = Stroke(width = size.minDimension * 0.08f)
        drawCircle(cor, radius = size.minDimension * 0.1f, center = c)
        listOf(0.28f, 0.44f).forEach { r ->
            val raio = size.minDimension * r
            val topo = Offset(c.x - raio, c.y - raio)
            val area = Size(raio * 2, raio * 2)
            drawArc(cor, startAngle = 135f, sweepAngle = 90f, useCenter = false, topLeft = topo, size = area, style = traco)
            drawArc(cor, startAngle = -45f, sweepAngle = 90f, useCenter = false, topLeft = topo, size = area, style = traco)
        }
    }
}

@Composable
private fun ChipDeCategoria(texto: String, selecionado: Boolean, chaveFoco: String, aoClicar: () -> Unit) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val forma = RoundedCornerShape(50)
    Box(
        modifier = Modifier
            .clip(forma)
            .background(if (selecionado) CoresLive.Vermelho else CoresLive.SuperficieAlta)
            .border(
                width = if (focado) 2.dp else 1.dp,
                color = when {
                    focado -> Color.White
                    selecionado -> CoresLive.Brilho
                    else -> CoresLive.Borda
                },
                shape = forma,
            )
            .focavel(interacao = interacao, chaveFoco = chaveFoco, aoClicar = aoClicar)
            .padding(horizontal = 14.dp, vertical = 7.dp),
    ) {
        Text(
            text = texto,
            color = if (selecionado || focado) Color.White else Color(0xFFD4D4D8),
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

/**
 * Um canal na lista: numero, logo, nome/categoria e `● AO VIVO` no canal em
 * reproducao. Focado: borda e brilho vermelhos, fortes o bastante para o D-pad.
 */
@Composable
private fun LinhaDeCanal(
    canal: CanalTv,
    numero: Int,
    subtitulo: String,
    ativo: Boolean,
    chaveFoco: String,
    modifier: Modifier,
    aoFocar: () -> Unit,
    aoAbrir: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.02f)
    val forma = RoundedCornerShape(12.dp)

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = modifier
            .fillMaxWidth()
            .height(68.dp)
            .escalar(escala)
            .then(
                if (focado) {
                    Modifier.shadow(16.dp, forma, ambientColor = CoresLive.Brilho, spotColor = CoresLive.Brilho)
                } else {
                    Modifier
                },
            )
            .clip(forma)
            .background(
                when {
                    focado -> Brush.horizontalGradient(listOf(Color(0xFF3B0A11), Color(0xFF1A0C10)))
                    ativo -> Brush.horizontalGradient(listOf(Color(0x33E50914), Color(0x0FE50914)))
                    else -> SolidColor(CoresLive.SuperficieAlta)
                },
            )
            .border(
                width = if (focado) 2.dp else 1.dp,
                color = when {
                    focado -> CoresLive.Brilho
                    ativo -> CoresLive.Vermelho.copy(alpha = 0.75f)
                    else -> CoresLive.Borda.copy(alpha = 0.7f)
                },
                shape = forma,
            )
            .focavel(interacao = interacao, chaveFoco = chaveFoco, aoFocar = aoFocar, aoClicar = aoAbrir)
            .padding(horizontal = 12.dp),
    ) {
        Text(
            text = numero.toString().padStart(3, '0'),
            color = CoresLive.TextoApagado,
            fontSize = 12.sp,
            modifier = Modifier.width(28.dp),
        )
        LogoDoCanal(canal, Modifier.size(width = 56.dp, height = 42.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = canal.nome,
                color = Color.White,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitulo.isNotBlank()) {
                Text(text = subtitulo, color = CoresLive.TextoApagado, fontSize = 12.sp, maxLines = 1)
            }
        }
        if (ativo) SeloAoVivo()
    }
}

/** Logo real quando existe; senao as iniciais, o fallback que a TV ja usava. */
@Composable
private fun LogoDoCanal(canal: CanalTv, modifier: Modifier) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier.clip(RoundedCornerShape(8.dp)).background(Color(0x66000000)),
    ) {
        if (canal.logoUrl.isNullOrBlank()) {
            Text(
                text = canal.nome.take(3).uppercase(),
                color = Color(0xFF6B6B72),
                fontSize = 14.sp,
                fontWeight = FontWeight.Black,
            )
        } else {
            AsyncImage(model = canal.logoUrl, contentDescription = null, modifier = Modifier.padding(4.dp))
        }
    }
}

@Composable
private fun SeloAoVivo(grande: Boolean = false) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(CoresLive.Vermelho)
            .padding(horizontal = if (grande) 10.dp else 7.dp, vertical = if (grande) 5.dp else 3.dp),
    ) {
        Box(Modifier.size(if (grande) 7.dp else 5.dp).clip(CircleShape).background(Color.White))
        Text(
            text = "AO VIVO",
            color = Color.White,
            fontSize = if (grande) 12.sp else 10.sp,
            fontWeight = FontWeight.Black,
        )
    }
}

@Composable
private fun SeloResolucao(altura: Int) {
    Text(
        text = "${altura}p",
        color = Color.White,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(Color(0x8C000000))
            .border(1.dp, Color(0x26FFFFFF), RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

/** A superficie do ExoPlayer. So uma esta presa ao player por vez. */
@Composable
private fun SuperficieDoPlayer(controle: PlayerDeCanalTv, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            PlayerView(ctx).apply {
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                setShutterBackgroundColor(android.graphics.Color.BLACK)
                isFocusable = false
            }
        },
        update = { it.player = controle.player },
        onRelease = { it.player = null },
    )
}

/** Logo do canal, AO VIVO e resolucao (so quando o player a reporta). */
@Composable
private fun SobreposicaoSuperior(controle: PlayerDeCanalTv, canal: CanalTv, modifier: Modifier = Modifier) {
    Row(
        verticalAlignment = Alignment.Top,
        modifier = modifier
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color(0x99000000), Color.Transparent)))
            .padding(16.dp),
    ) {
        if (!canal.logoUrl.isNullOrBlank()) {
            AsyncImage(
                model = canal.logoUrl,
                contentDescription = canal.nome,
                modifier = Modifier.size(width = 96.dp, height = 40.dp),
            )
        }
        Spacer(Modifier.weight(1f))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            SeloAoVivo(grande = true)
            val altura = controle.alturaDoVideo
            if (controle.estado == EstadoDoCanal.Tocando && altura != null) SeloResolucao(altura)
        }
    }
}

/** Conectando / erro, por cima do video. */
@Composable
private fun EstadoSobreOVideo(controle: PlayerDeCanalTv, dicaDeAcao: String?) {
    when (val e = controle.estado) {
        EstadoDoCanal.Conectando -> Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.fillMaxSize().background(Color(0xB3000000)),
        ) {
            Text("Conectando…", color = CoresLive.TextoApagado, fontSize = 15.sp)
        }
        is EstadoDoCanal.Erro -> Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.fillMaxSize().background(Color(0xE6000000)),
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(tituloDoErro(e.motivo), color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Text(detalheDoErro(e.motivo), color = CoresLive.TextoApagado, fontSize = 14.sp)
                if (dicaDeAcao != null) Text(dicaDeAcao, color = Color.White, fontSize = 13.sp)
            }
        }
        else -> Unit
    }
}

private fun tituloDoErro(m: Concessao) = when (m) {
    is Concessao.PrecisaDeUpgrade -> "Canal não incluso no seu plano"
    Concessao.SemSessao -> "Sessão expirada"
    Concessao.Indisponivel -> "Canal indisponível"
    else -> "Não foi possível reproduzir"
}

private fun detalheDoErro(m: Concessao) = when (m) {
    is Concessao.PrecisaDeUpgrade -> m.nivelExigido
        ?.let { "Este canal faz parte do plano ${it.replaceFirstChar { c -> c.uppercase() }}." }
        ?: "Seu plano não inclui este canal."
    Concessao.SemSessao -> "Faça o pareamento novamente para continuar."
    Concessao.Indisponivel -> "Este canal não está no ar agora."
    else -> "A transmissão foi interrompida."
}

private fun dicaDoErro(m: Concessao) = when (m) {
    is Concessao.PrecisaDeUpgrade -> "OK · Ver planos"
    Concessao.SemSessao, Concessao.Indisponivel -> null
    else -> "OK · Tentar de novo"
}

@Composable
private fun Previa(controle: PlayerDeCanalTv, telaCheia: Boolean, modifier: Modifier) {
    val forma = RoundedCornerShape(16.dp)
    Box(
        modifier = modifier
            .clip(forma)
            .background(Color.Black)
            .border(1.dp, CoresLive.Borda.copy(alpha = 0.8f), forma),
    ) {
        val canal = controle.canal
        if (canal == null) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
                modifier = Modifier
                    .fillMaxSize()
                    .background(Brush.radialGradient(listOf(Color(0x1FE50914), Color.Transparent))),
            ) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(64.dp)
                        .clip(CircleShape)
                        .background(CoresLive.Superficie)
                        .border(1.dp, CoresLive.Borda, CircleShape),
                ) { IconeAoVivo(tamanho = 30.dp) }
                Text("Selecione um canal", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "Pare o foco em um canal para ver a prévia. OK abre em tela cheia.",
                    color = CoresLive.TextoApagado,
                    fontSize = 14.sp,
                )
            }
        } else {
            // Em tela cheia a superficie mora no dialogo; aqui fica so o fundo.
            if (!telaCheia) SuperficieDoPlayer(controle, Modifier.fillMaxSize())
            SobreposicaoSuperior(controle, canal, Modifier.align(Alignment.TopCenter))
            EstadoSobreOVideo(controle, (controle.estado as? EstadoDoCanal.Erro)?.motivo?.let(::dicaDoErro))

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000))))
                    .padding(horizontal = 18.dp, vertical = 14.dp),
            ) {
                Text(
                    text = canal.nome,
                    color = Color.White,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (controle.estado == EstadoDoCanal.Tocando) {
                    Text("OK · tela cheia", color = CoresLive.TextoApagado, fontSize = 13.sp)
                }
            }
        }
    }
}

/**
 * Tela cheia: o mesmo player, num dialogo que cobre tudo.
 *
 * ↑ proximo canal, ↓ anterior (com espera, sem sair da tela cheia). OK/setas
 * mostram os controles; BACK sai e o chamador devolve o foco ao canal.
 */
@Composable
private fun TelaCheiaDeCanal(
    controle: PlayerDeCanalTv,
    canais: List<CanalTv>,
    aoTrocar: (CanalTv) -> Unit,
    aoSair: () -> Unit,
) {
    Dialog(
        onDismissRequest = aoSair,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
            dismissOnClickOutside = false,
        ),
    ) {
        val raiz = remember { FocusRequester() }
        val botaoPrincipal = remember { FocusRequester() }
        var controlesVisiveis by remember { mutableStateOf(true) }
        var interacoes by remember { mutableIntStateOf(0) }
        /** Canal escolhido com ↑/↓; vira reproducao depois da espera. */
        var alvo by remember { mutableStateOf(controle.canal) }

        LaunchedEffect(Unit) { runCatching { raiz.requestFocus() } }

        // Controles somem sozinhos com o video tocando; o foco volta a raiz antes
        // de o botao sumir, para nunca ficar preso num no que saiu da tela.
        LaunchedEffect(interacoes, controle.estado) {
            if (controle.estado !is EstadoDoCanal.Tocando) {
                controlesVisiveis = true
                return@LaunchedEffect
            }
            delay(CONTROLES_SOMEM_MS)
            runCatching { raiz.requestFocus() }
            controlesVisiveis = false
        }

        LaunchedEffect(alvo) {
            val a = alvo ?: return@LaunchedEffect
            if (a.id == controle.canal?.id) return@LaunchedEffect
            delay(ATRASO_TROCA_MS)
            aoTrocar(a)
        }

        fun mover(delta: Int) {
            if (canais.isEmpty()) return
            val atual = canais.indexOfFirst { it.id == alvo?.id }
            val proximo = if (atual < 0) 0 else Math.floorMod(atual + delta, canais.size)
            alvo = canais[proximo]
            controlesVisiveis = true
            interacoes++
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black)
                .onPreviewKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    when (e.key) {
                        Key.DirectionUp -> { mover(+1); true }
                        Key.DirectionDown -> { mover(-1); true }
                        else -> {
                            interacoes++
                            if (!controlesVisiveis) {
                                controlesVisiveis = true
                                // A primeira tecla so revela os controles.
                                if (e.key == Key.DirectionCenter || e.key == Key.Enter ||
                                    e.key == Key.DirectionLeft || e.key == Key.DirectionRight
                                ) {
                                    runCatching { botaoPrincipal.requestFocus() }
                                    true
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        }
                    }
                }
                .focusRequester(raiz)
                .focusable(),
        ) {
            SuperficieDoPlayer(controle, Modifier.fillMaxSize())

            val exibido = alvo ?: controle.canal
            if (exibido != null) {
                SobreposicaoSuperior(controle, exibido, Modifier.align(Alignment.TopCenter))
            }
            EstadoSobreOVideo(controle, dicaDeAcao = null)

            if (controlesVisiveis && exibido != null) {
                BarraDeControles(
                    controle = controle,
                    canal = exibido,
                    trocando = exibido.id != controle.canal?.id,
                    botaoPrincipal = botaoPrincipal,
                    aoSair = aoSair,
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}

@Composable
private fun BarraDeControles(
    controle: PlayerDeCanalTv,
    canal: CanalTv,
    trocando: Boolean,
    botaoPrincipal: FocusRequester,
    aoSair: () -> Unit,
    modifier: Modifier,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(14.dp),
        modifier = modifier
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xE6000000))))
            .padding(horizontal = 40.dp, vertical = 28.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = canal.nome,
                color = Color.White,
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (trocando) Text("Trocando…", color = CoresLive.TextoApagado, fontSize = 15.sp)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            val erro = controle.estado as? EstadoDoCanal.Erro
            when {
                erro?.motivo is Concessao.PrecisaDeUpgrade -> BotaoDeControle(
                    rotulo = "Ver planos",
                    requisitor = botaoPrincipal,
                    aoClicar = { Navegacao.abrirPlanos() },
                )
                erro != null -> BotaoDeControle(
                    rotulo = "↻  Tentar de novo",
                    requisitor = botaoPrincipal,
                    aoClicar = controle::atualizar,
                )
                else -> BotaoDeControle(
                    rotulo = if (controle.reproduzindo) "❚❚" else "▶︎",
                    redondo = true,
                    requisitor = botaoPrincipal,
                    aoClicar = controle::alternarPausa,
                )
            }
            if (erro == null) {
                BotaoDeControle(
                    rotulo = if (controle.atualizando) "↻  Atualizando…" else "↻  Atualizar canal",
                    aoClicar = controle::atualizar,
                )
            }
            SeloAoVivo(grande = true)
            Spacer(Modifier.weight(1f))
            Text("▲▼ trocar canal", color = CoresLive.TextoApagado, fontSize = 13.sp)
            BotaoDeControle(rotulo = "Sair da tela cheia", aoClicar = aoSair)
        }
    }
}

@Composable
private fun BotaoDeControle(
    rotulo: String,
    redondo: Boolean = false,
    requisitor: FocusRequester? = null,
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.06f)
    val forma = if (redondo) CircleShape else RoundedCornerShape(50)
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .then(if (requisitor != null) Modifier.focusRequester(requisitor) else Modifier)
            .escalar(escala)
            .then(if (redondo) Modifier.size(56.dp) else Modifier.height(48.dp))
            .clip(forma)
            .background(if (focado) CoresLive.Vermelho.copy(alpha = 0.3f) else Color(0x33FFFFFF))
            .border(if (focado) 2.dp else 1.dp, if (focado) CoresLive.Brilho else Color(0x26FFFFFF), forma)
            .focavel(interacao = interacao, aoClicar = aoClicar)
            .padding(horizontal = if (redondo) 0.dp else 20.dp),
    ) {
        Text(rotulo, color = Color.White, fontSize = if (redondo) 18.sp else 15.sp, fontWeight = FontWeight.SemiBold)
    }
}

/**
 * Estado sem lista: carregando, vazio, categoria vazia ou erro.
 *
 * Recebe o `primeiro` requisitor porque numa televisao um estado sem nenhum
 * alvo focavel prende o cursor. Quando ha acao, ela e o alvo; quando nao ha, a
 * tela devolve o foco para a barra de cima.
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
                Text(detalhe, color = CoresLive.TextoApagado, fontSize = 14.sp)
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
                        .clip(RoundedCornerShape(50))
                        .background(if (focado) CoresLive.Vermelho else CoresLive.SuperficieAlta)
                        .border(1.dp, if (focado) CoresLive.Brilho else CoresLive.Borda, RoundedCornerShape(50))
                        .focavel(interacao = interacao, aoClicar = aoAgir)
                        .padding(horizontal = 20.dp, vertical = 10.dp),
                )
            }
        }
    }
}
