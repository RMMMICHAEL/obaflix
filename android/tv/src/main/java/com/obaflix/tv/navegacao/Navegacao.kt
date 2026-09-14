package com.obaflix.tv.navegacao

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import com.obaflix.tv.catalogo.CanalTv
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.player.DecisaoDeReproducao
import com.obaflix.tv.player.Pedido

/**
 * As seis entradas do menu do topo.
 *
 * Cada uma existe porque o catalogo realmente a alimenta: Filmes vem de
 * /api/filmes; Series, Animes e Kids sao o mesmo /api/series com o campo
 * `tipo` que o banco ja guarda ("serie", "anime", "desenho"). Nenhuma aba foi
 * criada para preencher a barra — se o backend nao devolve, nao esta aqui.
 */
enum class Aba(val rotulo: String) {
    Inicio("INÍCIO"),
    Filmes("FILMES"),
    Series("SÉRIES"),
    Animes("ANIMES"),
    Kids("KIDS"),
    Canais("CANAIS"),
    Busca("BUSCAR"),
}

/**
 * Telas empilhadas **sobre** a moldura de abas.
 *
 * Ficam como sobreposicao, e nao como substituicao, para que a Home continue
 * composta por baixo. E o que faz o retorno cair exatamente na fileira e no
 * card de onde a pessoa saiu: nada foi descartado, so ficou coberto. Recriar a
 * Home na volta obrigaria a restaurar rolagem e foco na mao — e, pior, a
 * recarregar o catalogo inteiro.
 */
sealed interface Camada {
    /**
     * Ficha do conteudo. `previa` e o card que originou a abertura: com ele a
     * arte de fundo e o titulo aparecem no mesmo quadro em que o OK foi
     * apertado, sem esperar a requisicao da ficha.
     */
    data class Detalhe(val id: String, val tipo: String, val previa: Item?) : Camada

    /**
     * Reproducao em tela cheia.
     *
     * Comeca pela autorizacao (`PortaoDeReproducao`): o player do conteudo so
     * aparece depois de o servidor liberar. `autorizacaoPrevia` existe para a
     * troca de episodio dentro do player — quando o episodio seguinte pede a
     * promocao, a camada nova ja nasce com a decisao, sem perguntar duas vezes.
     */
    data class Player(
        val pedido: Pedido,
        val autorizacaoPrevia: DecisaoDeReproducao.PromocaoObrigatoria? = null,
        val memoria: MemoriaDoPortao = MemoriaDoPortao(),
    ) : Camada

    /**
     * Canal ao vivo em tela cheia.
     *
     * Camada propria, e nao `Player` com um `Pedido` fabricado: aquele carrega
     * temporada, episodio, progresso e lista de episodios, e canal ao vivo nao
     * tem nenhum dos quatro. Inventar um `Pedido` vazio faria o gravador de
     * progresso e o proximo-episodio rodarem sobre dados falsos.
     *
     * Guarda o canal, nunca a URL: a concessao e pedida dentro da tela, ao
     * entrar, e morre com ela.
     */
    data class PlayerDeCanal(val canal: CanalTv) : Camada

    /** Area de perfil: conta, favoritos, historico, continuar assistindo. */
    data object Perfil : Camada

    /**
     * Os planos. `memoria` guarda o card focado: a tela e descartada quando a
     * continuacao da assinatura abre por cima, e a volta precisa cair no mesmo
     * card, e nao no inicial.
     */
    data class Planos(val memoria: MemoriaDosPlanos = MemoriaDosPlanos()) : Camada

    /**
     * Continuar a assinatura do plano escolhido fora da TV: QR e endereco.
     *
     * Leva o plano como veio do servidor, para a tela mostrar nome e preco sem
     * uma segunda consulta e sem tabela local.
     */
    data class AssinarForaDaTv(val plano: com.obaflix.tv.assinatura.PlanoTv) : Camada
}

/** O que a vitrine lembra entre uma ida e uma volta. So foco — nada de conta. */
class MemoriaDosPlanos {
    var indiceFocado: Int? = null
}

/** O que o portao lembra quando os planos abrem por cima do convite. */
class MemoriaDoPortao {
    var foiAosPlanos: Boolean = false
}

/**
 * Estado de navegacao do aplicativo.
 *
 * Objeto unico e observavel, como a sessao. A alternativa — Navigation Compose
 * — traria um grafo, back stack proprio e recomposicao total da tela de origem
 * a cada volta; numa TV Box fraca isso aparece como um piscar de meio segundo
 * em cada BACK. Aqui BACK e uma remocao de lista.
 */
object Navegacao {

    var aba by mutableStateOf(Aba.Inicio)
        private set

    val pilha = emptyList<Camada>().toMutableStateList()

    /** Verdadeiro quando ha sobreposicao: a moldura de abas nao recebe foco. */
    val emCamada: Boolean get() = pilha.isNotEmpty()

    fun irPara(destino: Aba) {
        pilha.clear()
        // Sair de uma aba descarta o recorte dela. E aqui, e nao num
        // `onDispose` da tela, porque a tela tambem e descartada ao abrir uma
        // ficha ou o player — e voltar de um filme tem de cair no mesmo lugar
        // de onde se saiu, com o filtro intacto. So a troca de aba reinicia.
        if (destino != aba) com.obaflix.tv.catalogo.CacheTelas.esquecerFiltros(aba.name)
        aba = destino
    }

    fun abrir(camada: Camada) {
        pilha.add(camada)
    }

    /**
     * Abre a ficha de um item de catalogo.
     *
     * O tipo vem do proprio item porque serie, anime e desenho usam rotas
     * diferentes de filme — e um card de Continuar Assistindo pode ser
     * qualquer um dos quatro.
     */
    fun abrirDetalhe(item: Item) {
        abrir(Camada.Detalhe(item.id, item.tipo, item))
    }

    /**
     * Abre os planos por cima de onde a pessoa esta — barra, canais, convite,
     * recusa. Voltar devolve a origem.
     *
     * Nunca empilha planos sobre planos: um segundo "Ver planos" no mesmo lugar
     * criaria uma pilha que so se desfaz com varios BACK.
     */
    fun abrirPlanos() {
        if (pilha.lastOrNull() is Camada.Planos) return
        abrir(Camada.Planos())
    }

    /**
     * Troca a camada do topo sem crescer a pilha.
     *
     * Para quando a tela de cima deixa de fazer sentido e nao deve ser o destino
     * do BACK: o canal recusado que abre os planos (voltar cai na grade, e nao
     * num canal que recusaria de novo), ou o episodio seguinte que precisa de
     * promocao (voltar cai na ficha, e nao num player que ja passou).
     */
    fun substituirTopo(camada: Camada) {
        if (pilha.isEmpty()) {
            pilha.add(camada)
        } else {
            pilha[pilha.lastIndex] = camada
        }
    }

    /** Retrocede uma camada. Devolve false quando ja estava na moldura. */
    fun voltar(): Boolean {
        if (pilha.isEmpty()) return false
        pilha.removeAt(pilha.lastIndex)
        return true
    }

    /** Fecha tudo. Usado quando a sessao cai no meio da navegacao. */
    fun limpar() {
        pilha.clear()
        aba = Aba.Inicio
    }
}
