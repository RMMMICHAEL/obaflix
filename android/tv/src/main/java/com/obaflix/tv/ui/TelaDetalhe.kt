package com.obaflix.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Detalhe
import com.obaflix.tv.catalogo.Episodio
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.navegacao.Camada
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.player.Pedido
import com.obaflix.tv.ui.componentes.CardPoster
import com.obaflix.tv.ui.componentes.EspacoH
import com.obaflix.tv.ui.componentes.EspacoV
import com.obaflix.tv.ui.componentes.LinhaMeta
import com.obaflix.tv.ui.componentes.Pilula
import com.obaflix.tv.ui.componentes.enderecoDe
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel
import kotlinx.coroutines.launch

/**
 * Ficha do conteudo — reproduz o activity_voddetails.
 *
 * Coluna de informacao a esquerda, janela de preview a direita; abaixo, a linha
 * de botoes (Assistir, Favorito, …); depois, para serie, o seletor de temporada
 * e os episodios numerados; por fim, "Você também pode gostar". Tudo na mesma
 * tela: a referencia nao faz a pessoa trocar de contexto para escolher episodio.
 *
 * O progresso vem de Continuar Assistindo — o mesmo estado que o site e o app
 * movel gravam. Nao ha marcacao local de "assistido" aqui.
 */
@Composable
fun TelaDetalhe(destino: Camada.Detalhe) {
    var detalhe by remember(destino.id) { mutableStateOf<Detalhe?>(null) }
    var relacionados by remember(destino.id) { mutableStateOf<List<Item>>(emptyList()) }
    var erro by remember(destino.id) { mutableStateOf(false) }
    var progressos by remember(destino.id) { mutableStateOf<Map<String, Item>>(emptyMap()) }
    var temporada by remember(destino.id) { mutableStateOf<Int?>(null) }
    var favorito by remember(destino.id) { mutableStateOf(false) }
    var recarga by remember(destino.id) { mutableStateOf(0) }

    val botaoPrincipal = remember { FocusRequester() }
    val margem = margemHorizontal()

    // Tres chamadas independentes, em paralelo e cada uma escrevendo o seu
    // estado assim que chega. Em sequencia, a ficha so aparecia depois da soma
    // das tres — e a mais lenta segurava as outras duas sem motivo.
    //
    // Cada bloco e um LaunchedEffect proprio: se um servidor demora, ele atrasa
    // apenas a sua parte da tela. Trocar de ficha cancela todos, entao resposta
    // atrasada da ficha anterior nao sobrescreve a nova.
    LaunchedEffect(destino.id, recarga) {
        val carregado = ApiObaflix.detalhe(destino.id, destino.tipo)
        if (carregado == null) {
            erro = true
        } else {
            detalhe = carregado
            if (temporada == null) temporada = carregado.temporadas.firstOrNull()
        }
    }

    LaunchedEffect(destino.id, recarga) {
        progressos = ApiObaflix.continuarAssistindo().orEmpty().associateBy { it.chaveProgresso }
    }

    LaunchedEffect(destino.id) {
        favorito = ApiObaflix.estaNaLista(destino.id, destino.tipo)
    }

    LaunchedEffect(detalhe) {
        val base = detalhe?.item ?: return@LaunchedEffect
        relacionados = ApiObaflix.relacionados(base)
    }

    // Foco no botao Assistir assim que a ficha existe, com insistencia: nenhuma
    // tela pode nascer sem um elemento focado, e a previa (PlayerView) ja nao
    // disputa o D-pad. Para de tentar quando esta ficha deixa de ser o topo.
    LaunchedEffect(detalhe, com.obaflix.tv.ui.componentes.FocoBridge.pulso) {
        if (detalhe == null) return@LaunchedEffect
        repeat(10) {
            if (Navegacao.pilha.lastOrNull() !== destino) return@LaunchedEffect
            runCatching { botaoPrincipal.requestFocus() }
            kotlinx.coroutines.delay(60)
        }
    }

    BackHandler(enabled = true) { Navegacao.voltar() }

    val noTopo = Navegacao.pilha.lastOrNull() === destino
    var esteveCoberto by remember(destino.id) { mutableStateOf(false) }
    LaunchedEffect(noTopo) {
        if (!noTopo) esteveCoberto = true
        else if (esteveCoberto) { esteveCoberto = false; recarga++ }
    }

    val base = detalhe?.item ?: destino.previa

    Box(Modifier.fillMaxSize().background(Cores.Fundo)) {
        ApiObaflix.imagem(base?.background, "w1280")?.let { url ->
            AsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Box(
            Modifier.fillMaxSize().background(
                Brush.horizontalGradient(
                    0f to Cores.Fundo.copy(alpha = 0.97f),
                    0.55f to Cores.Fundo.copy(alpha = 0.72f),
                    1f to Cores.Fundo.copy(alpha = 0.25f),
                ),
            ),
        )
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to Cores.Fundo.copy(alpha = 0.55f),
                    0.4f to Color.Transparent,
                    0.72f to Cores.Fundo.copy(alpha = 0.9f),
                    1f to Cores.Fundo,
                ),
            ),
        )

        when {
            base == null && erro -> Aviso("Não foi possível abrir esta ficha.")
            base == null -> Aviso("Carregando…")
            else -> Conteudo(
                base = base,
                detalhe = detalhe,
                relacionados = relacionados,
                temporada = temporada,
                progressos = progressos,
                favorito = favorito,
                margem = margem,
                botaoPrincipal = botaoPrincipal,
                aoTrocarTemporada = { temporada = it },
                aoTrocarFavorito = { favorito = it },
                conteudoId = destino.id,
                conteudoTipo = destino.tipo,
                ativo = noTopo,
            )
        }
    }
}

@Composable
private fun Conteudo(
    base: Item,
    detalhe: Detalhe?,
    relacionados: List<Item>,
    temporada: Int?,
    progressos: Map<String, Item>,
    favorito: Boolean,
    margem: androidx.compose.ui.unit.Dp,
    botaoPrincipal: FocusRequester,
    aoTrocarTemporada: (Int) -> Unit,
    aoTrocarFavorito: (Boolean) -> Unit,
    conteudoId: String,
    conteudoTipo: String,
    ativo: Boolean,
) {
    val escopo = rememberCoroutineScope()
    val ehSerie = base.ehSerie
    val episodios = remember(detalhe, temporada) {
        if (detalhe == null || temporada == null) emptyList() else detalhe.episodiosDa(temporada)
    }

    val emAndamento = remember(progressos, detalhe, base) {
        if (!ehSerie) progressos[base.id]
        else detalhe?.episodios?.firstNotNullOfOrNull { ep -> progressos[ep.id] }
    }

    val proximo = remember(emAndamento, detalhe, temporada, episodios) {
        when {
            !ehSerie -> null
            emAndamento?.episodioId != null -> detalhe?.episodios?.firstOrNull { it.id == emAndamento.episodioId }
            else -> detalhe?.episodios?.firstOrNull() ?: episodios.firstOrNull()
        }
    }

    fun pedido(episodio: Episodio?, doComeco: Boolean): Pedido {
        val progresso = if (doComeco) 0 else progressos[episodio?.id ?: base.id]?.progressoSeg ?: 0
        return Pedido(
            conteudoId = base.id,
            conteudoTipo = base.tipo,
            titulo = base.titulo,
            backdrop = base.background,
            temporada = episodio?.temporada,
            numeroEp = episodio?.numeroEp,
            episodioId = episodio?.id,
            tituloEpisodio = episodio?.titulo,
            posicaoSeg = progresso,
            episodios = detalhe?.episodios.orEmpty(),
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = margemVertical(), bottom = 24.dp),
    ) {
        // ── Cabecalho: info a esquerda, preview a direita ─────────────────────
        Row(modifier = Modifier.fillMaxWidth().padding(start = margem, end = margem)) {
            Column(Modifier.weight(1.4f)) {
                val logo = ApiObaflix.imagem(base.logo, "w500")
                if (logo != null) {
                    AsyncImage(
                        model = logo,
                        contentDescription = base.titulo,
                        contentScale = ContentScale.Fit,
                        alignment = Alignment.CenterStart,
                        modifier = Modifier.fillMaxWidth(0.72f).height(84.dp),
                    )
                } else {
                    Text(
                        text = base.titulo,
                        color = Cores.Texto,
                        fontSize = Escala.Hero,
                        fontWeight = FontWeight.Black,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }

                EspacoV(12.dp)
                LinhaMeta(
                    ano = base.ano,
                    nota = base.nota,
                    generos = (detalhe?.item?.generos ?: base.generos).map { it.nome },
                    tipo = rotuloTipo(base.tipo),
                )

                if (detalhe != null && ehSerie && detalhe.temporadas.isNotEmpty()) {
                    EspacoV(6.dp)
                    Text(
                        text = detalhe.temporadas.size.toString() + " temporada" +
                            (if (detalhe.temporadas.size > 1) "s" else "") +
                            "  ·  " + detalhe.episodios.size + " episódios",
                        color = Cores.TextoApagado,
                        fontSize = Escala.Rotulo,
                    )
                }

                EspacoV(14.dp)
                base.sinopse?.let {
                    Text(
                        text = it,
                        color = Cores.TextoFraco,
                        fontSize = Escala.Corpo,
                        maxLines = 4,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth(0.94f),
                    )
                }
            }

            PreviaMuda(
                pedido = pedido(proximo, doComeco = true),
                arte = base.background ?: base.poster,
                ativo = ativo,
                modifier = Modifier
                    .weight(1f)
                    .height(215.dp)
                    .padding(start = 30.dp, top = 4.dp),
            )
        }

        // ── Botoes de acao ────────────────────────────────────────────────────
        EspacoV(22.dp)
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = margem, end = margem).focusGroup(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val rotuloPrincipal = when {
                ehSerie && emAndamento != null && proximo != null ->
                    "Continuar T" + proximo.temporada + " E" + proximo.numeroEp
                emAndamento != null && emAndamento.progressoSeg > 0 -> "Continuar"
                else -> "Assistir"
            }
            BotaoAcao(
                icone = "▶",
                texto = rotuloPrincipal,
                principal = true,
                modifier = Modifier.focusRequester(botaoPrincipal),
                aoClicar = { Navegacao.abrir(Camada.Player(pedido(proximo, doComeco = false))) },
            )
            if (emAndamento != null && emAndamento.progressoSeg > 0) {
                BotaoAcao(icone = "↺", texto = "Do início") {
                    Navegacao.abrir(Camada.Player(pedido(proximo, doComeco = true)))
                }
            }
            BotaoAcao(
                icone = if (favorito) "★" else "☆",
                texto = if (favorito) "Favorito" else "Favoritar",
            ) {
                escopo.launch {
                    val novo = ApiObaflix.alternarLista(conteudoId, conteudoTipo, favorito)
                    aoTrocarFavorito(novo)
                }
            }
            BotaoAcao(icone = "←", texto = "Voltar") { Navegacao.voltar() }
        }

        // ── Temporadas + episodios ────────────────────────────────────────────
        if (ehSerie && detalhe != null && detalhe.temporadas.isNotEmpty()) {
            EspacoV(26.dp)
            SeletorTemporada(detalhe.temporadas, temporada, margem, aoTrocarTemporada)
            EspacoV(12.dp)
            GradeEpisodios(
                episodios = episodios,
                progressos = progressos,
                emAndamento = emAndamento?.episodioId,
                margem = margem,
                aoAbrir = { ep -> Navegacao.abrir(Camada.Player(pedido(ep, doComeco = false))) },
            )
        }

        // ── Relacionados ──────────────────────────────────────────────────────
        if (relacionados.isNotEmpty()) {
            EspacoV(26.dp)
            Text(
                text = "Você também pode gostar",
                color = Cores.Texto,
                fontSize = Escala.Secao,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(start = margem, bottom = 10.dp),
            )
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(Medidas.EspacoCards),
                contentPadding = PaddingValues(start = margem, end = margem, top = 4.dp, bottom = 12.dp),
                modifier = Modifier.focusGroup(),
            ) {
                itemsIndexed(relacionados, key = { _, it -> it.id }) { indice, item ->
                    CardPoster(
                        item = item,
                        chaveFoco = enderecoDe("relacionados", indice),
                        largura = Medidas.SimilarLargura,
                        altura = Medidas.SimilarAltura,
                        aoAbrir = { Navegacao.abrirDetalhe(it) },
                    )
                }
            }
        }
    }
}

/** Botao de acao com icone + rotulo, como a linha mLayoutButtons da referencia. */
@Composable
private fun BotaoAcao(
    icone: String,
    texto: String,
    principal: Boolean = false,
    modifier: Modifier = Modifier,
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.05f)
    val forma = RoundedCornerShape(6.dp)
    val fundo = when {
        focado -> Cores.FocoHalo
        principal -> Cores.Destaque
        else -> Cores.Superficie
    }
    val corTexto = if (focado) Color(0xFF101014) else Cores.Texto

    Row(
        modifier = modifier
            .height(Medidas.BotaoAcaoAltura)
            .escalar(escala)
            .clip(forma)
            .background(fundo)
            .focavel(interacao = interacao, aoClicar = aoClicar)
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(text = icone, color = corTexto, fontSize = Escala.Rotulo, fontWeight = FontWeight.Black)
        Text(text = texto, color = corTexto, fontSize = Escala.Rotulo, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

@Composable
private fun SeletorTemporada(
    temporadas: List<Int>,
    atual: Int?,
    margem: androidx.compose.ui.unit.Dp,
    aoTrocar: (Int) -> Unit,
) {
    LazyRow(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(start = margem, end = margem, top = 4.dp, bottom = 4.dp),
        modifier = Modifier.focusGroup(),
    ) {
        itemsIndexed(temporadas, key = { _, t -> t }) { _, t ->
            Pilula(texto = "Temporada " + t, selecionado = t == atual, aoClicar = { aoTrocar(t) })
        }
    }
}

/**
 * Episodios como botoes numerados, como o mSelectionView da referencia.
 *
 * O primeiro carrega um ícone de play; os demais, o numero. O que esta em
 * andamento fica destacado, e os indisponiveis aparecem apagados.
 */
@Composable
private fun GradeEpisodios(
    episodios: List<Episodio>,
    progressos: Map<String, Item>,
    emAndamento: String?,
    margem: androidx.compose.ui.unit.Dp,
    aoAbrir: (Episodio) -> Unit,
) {
    if (episodios.isEmpty()) {
        Box(Modifier.fillMaxWidth().padding(horizontal = margem)) {
            Text("Nenhum episódio nesta temporada.", color = Cores.TextoApagado, fontSize = Escala.Rotulo)
        }
        return
    }
    val rolagem = rememberLazyListState()
    LazyRow(
        state = rolagem,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(start = margem, end = margem, top = 4.dp, bottom = 8.dp),
        modifier = Modifier.fillMaxWidth().focusGroup(),
    ) {
        itemsIndexed(episodios, key = { _, ep -> ep.id }) { indice, ep ->
            BotaoEpisodio(
                rotulo = if (indice == 0) "▶" else ep.numeroEp.toString(),
                emAndamento = ep.id == emAndamento,
                progresso = progressos[ep.id]?.progresso ?: 0f,
                disponivel = ep.disponivel,
                aoClicar = { if (ep.disponivel) aoAbrir(ep) },
            )
        }
    }
}

@Composable
private fun BotaoEpisodio(
    rotulo: String,
    emAndamento: Boolean,
    progresso: Float,
    disponivel: Boolean,
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.1f)
    val forma = RoundedCornerShape(6.dp)
    val fundo = when {
        focado -> Cores.FocoHalo
        emAndamento -> Cores.Destaque
        else -> Cores.Superficie
    }
    val cor = when {
        focado -> Color(0xFF101014)
        !disponivel -> Cores.TextoApagado
        else -> Cores.Texto
    }

    Box(
        modifier = Modifier
            .width(64.dp)
            .height(52.dp)
            .escalar(escala)
            .clip(forma)
            .background(fundo)
            .border(
                width = if (emAndamento && !focado) 0.dp else 1.dp,
                color = if (focado) Color.Transparent else Cores.SuperficieAlta,
                shape = forma,
            )
            .focavel(interacao = interacao, aoClicar = aoClicar),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = rotulo, color = cor, fontSize = Escala.Corpo, fontWeight = FontWeight.Bold)
        if (progresso > 0f) {
            Box(
                Modifier
                    .align(Alignment.BottomStart)
                    .fillMaxWidth()
                    .height(3.dp)
                    .background(Color.Black.copy(alpha = 0.4f)),
            ) {
                Box(Modifier.fillMaxWidth(progresso).fillMaxHeight().background(Cores.Nota))
            }
        }
    }
}
