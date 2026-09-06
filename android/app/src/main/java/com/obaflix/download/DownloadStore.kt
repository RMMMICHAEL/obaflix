package com.obaflix.download

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Onde a lista de downloads fica gravada.
 *
 * Abstraido atras de uma interface pequena por um motivo pratico: o corpo do
 * [DownloadStore] — ordem da fila, geracao de id, apagar a autorizacao ao virar
 * terminal — e a parte que da errado, e e toda testavel em JVM pura. Amarrar
 * isso a `SharedPreferences` obrigaria Robolectric so para exercitar logica que
 * nao tem nada de Android.
 */
interface KeyValueStore {
    fun ler(chave: String): String?
    fun gravar(chave: String, valor: String)
}

class PrefsKeyValueStore(context: Context) : KeyValueStore {
    private val prefs = context.getSharedPreferences("obaflix_downloads", Context.MODE_PRIVATE)
    override fun ler(chave: String): String? = prefs.getString(chave, null)
    override fun gravar(chave: String, valor: String) {
        prefs.edit().putString(chave, valor).apply()
    }
}

/**
 * A lista de downloads, persistida.
 *
 * Guarda tudo num unico documento JSON em vez de uma chave por download: a
 * lista e curta (dezenas de itens), sempre lida inteira para desenhar a tela, e
 * uma escrita unica nao deixa a lista meio atualizada se o processo morrer no
 * meio — que e justamente o cenario de um servico de download sendo derrubado
 * pelo sistema.
 */
class DownloadStore(private val backing: KeyValueStore) {

    private companion object {
        const val CHAVE_REGISTROS = "registros"
        const val CHAVE_PROXIMO_ID = "proximo_id"
    }

    private val trava = Any()

    fun todos(): List<DownloadRecord> = synchronized(trava) { lerTudo() }

    fun porId(id: Int): DownloadRecord? = synchronized(trava) {
        lerTudo().firstOrNull { it.id == id }
    }

    /**
     * O download **vivo** desse conteudo, se houver.
     *
     * Ignora os terminais de proposito: quem ja baixou um episodio e clica
     * "Baixar" de novo esta pedindo para baixar de novo (a copia anterior pode
     * ter sido apagada da pasta), enquanto quem clica com um download em
     * andamento so clicou duas vezes.
     */
    fun ativoPorPid(pid: String): DownloadRecord? = synchronized(trava) {
        lerTudo().firstOrNull { it.pid == pid && !it.state.terminal }
    }

    /** Proximo da fila, em ordem de criacao. */
    fun proximoNaFila(): DownloadRecord? = synchronized(trava) {
        lerTudo().filter { it.state == DownloadState.FILA }.minByOrNull { it.criadoEm }
    }

    fun emAndamento(): List<DownloadRecord> = synchronized(trava) {
        lerTudo().filter { !it.state.terminal }
    }

    fun novoId(): Int = synchronized(trava) {
        val atual = backing.ler(CHAVE_PROXIMO_ID)?.toIntOrNull() ?: 1
        backing.gravar(CHAVE_PROXIMO_ID, (atual + 1).toString())
        atual
    }

    /**
     * Insere ou substitui, sempre carimbando `atualizadoEm`.
     *
     * Um registro que chega em estado terminal perde url/referer/userAgent
     * aqui, no unico ponto por onde toda escrita passa. Deixar essa limpeza a
     * cargo de quem chama significaria depender de nunca esquecerem dela.
     */
    fun salvar(registro: DownloadRecord): DownloadRecord = synchronized(trava) {
        val normalizado = registro
            .copy(atualizadoEm = System.currentTimeMillis())
            .let { if (it.state.terminal) it.semSegredos() else it }

        val lista = lerTudo().filter { it.id != normalizado.id } + normalizado
        gravarTudo(lista.sortedBy { it.criadoEm })
        normalizado
    }

    fun remover(id: Int) = synchronized(trava) {
        gravarTudo(lerTudo().filter { it.id != id })
    }

    /**
     * Reconcilia a lista com a realidade na subida do processo.
     *
     * O sistema pode matar o servico a qualquer momento (memoria, limite de
     * tempo de servico em primeiro plano, o usuario forcando a parada). Quando
     * isso acontece nao roda nenhum `finally`: o registro fica gravado como
     * BAIXANDO para sempre, e a tela mostra um download eterno em 37%.
     *
     * Como a autorizacao da fonte foi apagada junto com o processo em memoria
     * — a URL gravada pode ate existir, mas o token dela ja venceu — nao ha
     * retomada honesta. Esses ficam FALHOU, e o usuario decide se pede de novo.
     */
    fun reconciliarNaSubida(): List<DownloadRecord> = synchronized(trava) {
        val lista = lerTudo()
        val corrigidos = lista.map { registro ->
            if (registro.state == DownloadState.BAIXANDO || registro.state == DownloadState.PREPARANDO) {
                registro.copy(state = DownloadState.FALHOU, falha = DownloadFailure.DESCONHECIDO).semSegredos()
            } else {
                registro
            }
        }
        if (corrigidos != lista) gravarTudo(corrigidos)
        corrigidos
    }

    private fun lerTudo(): List<DownloadRecord> {
        val bruto = backing.ler(CHAVE_REGISTROS) ?: return emptyList()
        return runCatching {
            val array = JSONArray(bruto)
            (0 until array.length()).mapNotNull { i ->
                runCatching { DownloadRecord.deJson(array.getJSONObject(i)) }.getOrNull()
            }
        }.getOrDefault(emptyList())
    }

    private fun gravarTudo(lista: List<DownloadRecord>) {
        val array = JSONArray()
        lista.forEach { array.put(it.paraJson()) }
        backing.gravar(CHAVE_REGISTROS, array.toString())
    }

    /** A lista como o JavaScript a recebe — sem nenhuma URL autorizada. */
    fun paraJsonPublico(): String {
        val array = JSONArray()
        todos().sortedByDescending { it.criadoEm }.forEach { array.put(it.paraJsonPublico()) }
        return JSONObject().put("downloads", array).toString()
    }
}
