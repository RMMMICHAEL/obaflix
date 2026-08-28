package com.obaflix.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.foundation.focusGroup
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
import com.obaflix.tv.ui.componentes.CardEpisodio
import com.obaflix.tv.ui.componentes.EspacoV
import com.obaflix.tv.ui.componentes.LinhaMeta
import com.obaflix.tv.ui.componentes.Pilula
import com.obaflix.tv.ui.componentes.enderecoDe

/**
 * Ficha do conteudo.
 *
 * Uma tela so resolve filme e serie. Para serie, temporada e episodios ficam
 * abaixo das informacoes, na mesma tela: obrigar a pessoa a entrar em "ver
 * temporadas" e depois em "temporada 1" e tres OKs para chegar onde ela ja
 * sabia que queria ir.
 *
 * O progresso mostrado no episodio vem de Continuar Assistindo — o mesmo estado
 * que o site e o aplicativo movel gravam. Nao ha marcacao local de "assistido"
 * nesta televisao; se houvesse, ela discordaria dos outros aparelhos no
 * primeiro episodio visto fora dela.
 */
@Composable
fun TelaDetalhe(destino: Camada.Detalhe) {
    var detalhe by remember(destino.id) { mutableStateOf<Detalhe?>(null) }
    var erro by remember(destino.id) { mutableStateOf(false) }
    var progressos by remember(destino.id) { mutableStateOf<Map<String, Item>>(emptyMap()) }
    var temporada by remember(destino.id) { mutableStateOf<Int?>(null) }
    var recarga by remember(destino.id) { mutableStateOf(0) }

    val botaoPrincipal = remember { FocusRequester() }
    val margem = margemHorizontal()

    // Recarrega tambem ao voltar do player (recarga muda): o progresso do que
    // acabou de ser assistido tem de aparecer no episodio sem sair da ficha.
    LaunchedEffect(destino.id, recarga) {
        val carregado = ApiObaflix.detalhe(destino.id, destino.tipo)
        if (carregado == null) {
            erro = true
        } else {
            detalhe = carregado
            if (temporada == null) temporada = carregado.temporadas.firstOrNull()
        }
        progressos = ApiObaflix.continuarAssistindo()
            .orEmpty()
            .associateBy { it.chaveProgresso }
    }

    LaunchedEffect(detalhe) {
        if (detalhe != null) runCatching { botaoPrincipal.requestFocus() }
    }

    BackHandler(enabled = true) { Navegacao.voltar() }

    // Volta do player: pede o progresso de novo, para o episodio recem-visto
    // aparecer com a barra preenchida sem sair da ficha. So recarrega quem
    // esteve coberto — na primeira composicao nao ha nada a atualizar.
    val noTopo = Navegacao.pilha.lastOrNull() === destino
    var esteveCoberto by remember(destino.id) { mutableStateOf(false) }
    LaunchedEffect(noTopo) {
        if (!noTopo) {
            esteveCoberto = true
        } else if (esteveCoberto) {
            esteveCoberto = false
            recarga++
        }
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
        // Dois degrades cruzados: um da esquerda, onde fica o texto, e um da
        // base, onde ficam os episodios. Juntos garantem leitura sobre qualquer
        // cena sem apagar a arte no canto superior direito.
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
                    0.75f to Cores.Fundo.copy(alpha = 0.85f),
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
                temporada = temporada,
                progressos = progressos,
                margem = margem,
                botaoPrincipal = botaoPrincipal,
                aoTrocarTemporada = { temporada = it },
            )
        }
    }
}

@Composable
private fun Conteudo(
    base: Item,
    detalhe: Detalhe?,
    temporada: Int?,
    progressos: Map<String, Item>,
    margem: androidx.compose.ui.unit.Dp,
    botaoPrincipal: FocusRequester,
    aoTrocarTemporada: (Int) -> Unit,
) {
    val ehSerie = base.ehSerie
    val episodios = remember(detalhe, temporada) {
        if (detalhe == null || temporada == null) emptyList() else detalhe.episodiosDa(temporada)
    }

    // Onde a pessoa parou. Para serie, o episodio em andamento manda no botao
    // principal: "Continuar T2 E5" e melhor do que "Assistir" quando ha algo
    // comecado, e evita que ela procure na faixa qual era mesmo o episodio.
    val emAndamento = remember(progressos, detalhe, base) {
        if (!ehSerie) {
            progressos[base.id]
        } else {
            detalhe?.episodios?.firstNotNullOfOrNull { ep -> progressos[ep.id] }
        }
    }

    val proximo = remember(emAndamento, detalhe, temporada, episodios) {
        when {
            !ehSerie -> null
            emAndamento?.episodioId != null ->
                detalhe?.episodios?.firstOrNull { it.id == emAndamento.episodioId }
            else -> detalhe?.episodios?.firstOrNull() ?: episodios.firstOrNull()
        }
    }

    fun pedido(episodio: Episodio?, doComeco: Boolean): Pedido {
        val progresso = if (doComeco) {
            0
        } else {
            progressos[episodio?.id ?: base.id]?.progressoSeg ?: 0
        }
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
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = margem)) {
            Column(Modifier.weight(1.4f)) {
                val logo = ApiObaflix.imagem(base.logo, "w500")
                if (logo != null) {
                    AsyncImage(
                        model = logo,
                        contentDescription = base.titulo,
                        contentScale = ContentScale.Fit,
                        alignment = Alignment.CenterStart,
                        modifier = Modifier.fillMaxWidth(0.7f).height(92.dp),
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

                EspacoV(14.dp)
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

                EspacoV(16.dp)
                base.sinopse?.let {
                    Text(
                        text = it,
                        color = Cores.TextoFraco,
                        fontSize = Escala.Corpo,
                        maxLines = 4,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth(0.92f),
                    )
                }

                EspacoV(22.dp)
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    val rotuloPrincipal = when {
                        ehSerie && emAndamento != null && proximo != null ->
                            "Continuar T" + proximo.temporada + " E" + proximo.numeroEp
                        ehSerie -> "Assistir"
                        emAndamento != null && emAndamento.progressoSeg > 0 -> "Continuar"
                        else -> "Assistir"
                    }
                    Pilula(
                        texto = rotuloPrincipal,
                        principal = true,
                        modifier = Modifier.focusRequester(botaoPrincipal),
                        aoClicar = {
                            Navegacao.abrir(Camada.Player(pedido(proximo, doComeco = false)))
                        },
                    )
                    if (emAndamento != null && emAndamento.progressoSeg > 0) {
                        Pilula(texto = "Do início", aoClicar = {
                            Navegacao.abrir(Camada.Player(pedido(proximo, doComeco = true)))
                        })
                    }
                    Pilula(texto = "Voltar", aoClicar = { Navegacao.voltar() })
                }
            }

            // Moldura de previa. Comeca como arte parada e vira video sem som
            // se a pessoa permanecer na ficha — ver PreviaMuda para o porque da
            // espera. Enquanto ela apenas navega, nada de midia e consumido.
            PreviaMuda(
                pedido = pedido(proximo, doComeco = true),
                arte = base.background ?: base.poster,
                modifier = Modifier
                    .weight(1f)
                    .height(240.dp)
                    .padding(start = 28.dp, top = 6.dp),
            )
        }

        if (ehSerie && detalhe != null && detalhe.temporadas.isNotEmpty()) {
            EspacoV(26.dp)
            SeletorTemporada(detalhe.temporadas, temporada, margem, aoTrocarTemporada)
            EspacoV(14.dp)
            FaixaEpisodiosDetalhe(
                episodios = episodios,
                progressos = progressos,
                emAndamento = emAndamento?.episodioId,
                margem = margem,
                aoAbrir = { ep ->
                    Navegacao.abrir(Camada.Player(pedido(ep, doComeco = false)))
                },
            )
        }
    }
}

/**
 * Seletor de temporada.
 *
 * A troca e instantanea porque todos os episodios ja vieram na abertura da
 * ficha, numa requisicao so. Buscar por temporada faria a faixa piscar em
 * branco a cada seta.
 */
@Composable
private fun SeletorTemporada(
    temporadas: List<Int>,
    atual: Int?,
    margem: androidx.compose.ui.unit.Dp,
    aoTrocar: (Int) -> Unit,
) {
    LazyRow(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(horizontal = margem, vertical = 4.dp),
        modifier = Modifier.focusGroup(),
    ) {
        itemsIndexed(temporadas, key = { _, t -> t }) { _, t ->
            Pilula(
                texto = "Temporada " + t,
                selecionado = t == atual,
                aoClicar = { aoTrocar(t) },
            )
        }
    }
}

@Composable
private fun FaixaEpisodiosDetalhe(
    episodios: List<Episodio>,
    progressos: Map<String, Item>,
    emAndamento: String?,
    margem: androidx.compose.ui.unit.Dp,
    aoAbrir: (Episodio) -> Unit,
) {
    if (episodios.isEmpty()) {
        Box(Modifier.fillMaxWidth().padding(horizontal = margem)) {
            Text(
                text = "Nenhum episódio cadastrado nesta temporada.",
                color = Cores.TextoApagado,
                fontSize = Escala.Rotulo,
            )
        }
        return
    }

    val rolagem = rememberLazyListState()
    LazyRow(
        state = rolagem,
        horizontalArrangement = Arrangement.spacedBy(Medidas.EspacoCards),
        contentPadding = PaddingValues(start = margem, end = margem, top = 6.dp, bottom = 16.dp),
        modifier = Modifier.fillMaxHeight().focusGroup(),
    ) {
        itemsIndexed(episodios, key = { _, ep -> ep.id }) { indice, episodio ->
            CardEpisodio(
                episodio = episodio,
                progresso = progressos[episodio.id]?.progresso ?: 0f,
                emReproducao = episodio.id == emAndamento,
                chaveFoco = enderecoDe("episodios", indice),
                aoAbrir = aoAbrir,
            )
        }
    }
}
