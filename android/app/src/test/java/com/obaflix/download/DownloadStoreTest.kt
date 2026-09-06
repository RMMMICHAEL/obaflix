package com.obaflix.download

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** KeyValueStore em memoria — a razao de a interface existir. */
private class MemoriaStore : KeyValueStore {
    val dados = HashMap<String, String>()
    override fun ler(chave: String): String? = dados[chave]
    override fun gravar(chave: String, valor: String) {
        dados[chave] = valor
    }
}

class DownloadStoreTest {

    private fun registro(
        id: Int = 1,
        pid: String = "serie:1:t1:e1",
        state: DownloadState = DownloadState.FILA,
        kind: MediaKind = MediaKind.MP4,
        criadoEm: Long = 1000L,
    ) = DownloadRecord(
        id = id,
        pid = pid,
        titulo = "Episodio 1",
        kind = kind,
        state = state,
        url = "https://cdn.exemplo.com/v.mp4?token=abc123",
        referer = "https://provedor.exemplo/embed",
        userAgent = "Mozilla/5.0",
        criadoEm = criadoEm,
    )

    @Test
    fun `grava e le de volta`() {
        val store = DownloadStore(MemoriaStore())
        store.salvar(registro(id = 7))

        val lido = store.porId(7)
        assertNotNull(lido)
        assertEquals("serie:1:t1:e1", lido!!.pid)
        assertEquals(MediaKind.MP4, lido.kind)
        assertEquals(DownloadState.FILA, lido.state)
    }

    @Test
    fun `estado nao terminal preserva a autorizacao da fonte`() {
        val store = DownloadStore(MemoriaStore())
        store.salvar(registro(state = DownloadState.BAIXANDO))
        assertTrue(store.porId(1)!!.url.isNotEmpty())
    }

    @Test
    fun `concluir apaga url referer e userAgent`() {
        // O ponto central: um registro terminal gravado no disco nao pode
        // conter nada que sirva para rebuscar a midia na origem.
        val store = DownloadStore(MemoriaStore())
        store.salvar(registro(state = DownloadState.CONCLUIDO))

        val lido = store.porId(1)!!
        assertEquals("", lido.url)
        assertNull(lido.referer)
        assertNull(lido.userAgent)
    }

    @Test
    fun `falhar e cancelar tambem apagam a autorizacao`() {
        val store = DownloadStore(MemoriaStore())
        store.salvar(registro(id = 1, state = DownloadState.FALHOU))
        store.salvar(registro(id = 2, pid = "p2", state = DownloadState.CANCELADO))

        assertEquals("", store.porId(1)!!.url)
        assertEquals("", store.porId(2)!!.url)
    }

    @Test
    fun `o token nao sobra no armazenamento bruto`() {
        // Nao basta o objeto vir limpo: o que ficou gravado tambem precisa estar.
        val backing = MemoriaStore()
        val store = DownloadStore(backing)
        store.salvar(registro(state = DownloadState.CONCLUIDO))

        val bruto = backing.dados.values.joinToString(" ")
        assertTrue("token vazou para o armazenamento", !bruto.contains("token=abc123"))
        assertTrue("referer vazou para o armazenamento", !bruto.contains("provedor.exemplo"))
    }

    @Test
    fun `json publico nunca carrega a url`() {
        val store = DownloadStore(MemoriaStore())
        store.salvar(registro(state = DownloadState.BAIXANDO))

        val publico = store.paraJsonPublico()
        assertTrue(!publico.contains("cdn.exemplo.com"))
        assertTrue(!publico.contains("token=abc123"))
        assertTrue(publico.contains("Episodio 1"))
    }

    @Test
    fun `ativoPorPid ignora os terminais`() {
        val store = DownloadStore(MemoriaStore())
        store.salvar(registro(id = 1, state = DownloadState.CONCLUIDO))
        // Ja baixou e clicou de novo: a copia anterior pode ter sido apagada da
        // pasta, entao isto e um pedido novo, nao um clique duplo.
        assertNull(store.ativoPorPid("serie:1:t1:e1"))

        store.salvar(registro(id = 2, state = DownloadState.BAIXANDO, criadoEm = 2000L))
        assertEquals(2, store.ativoPorPid("serie:1:t1:e1")!!.id)
    }

    @Test
    fun `proximoNaFila respeita a ordem de criacao`() {
        val store = DownloadStore(MemoriaStore())
        store.salvar(registro(id = 2, pid = "b", criadoEm = 2000L))
        store.salvar(registro(id = 1, pid = "a", criadoEm = 1000L))
        store.salvar(registro(id = 3, pid = "c", state = DownloadState.CONCLUIDO, criadoEm = 500L))

        assertEquals(1, store.proximoNaFila()!!.id)
    }

    @Test
    fun `novoId nao repete`() {
        val store = DownloadStore(MemoriaStore())
        val ids = (1..5).map { store.novoId() }
        assertEquals(ids.size, ids.toSet().size)
    }

    @Test
    fun `reconciliar na subida encerra o que ficou baixando`() {
        // Processo morto no meio: sem isto o registro fica BAIXANDO para sempre
        // e a tela mostra um download eterno em 37%.
        val backing = MemoriaStore()
        DownloadStore(backing).salvar(registro(state = DownloadState.BAIXANDO))

        val corrigidos = DownloadStore(backing).reconciliarNaSubida()
        assertEquals(DownloadState.FALHOU, corrigidos.single().state)
        assertEquals("", corrigidos.single().url)
    }

    @Test
    fun `reconciliar nao mexe no que ja terminou`() {
        val backing = MemoriaStore()
        DownloadStore(backing).salvar(registro(state = DownloadState.CONCLUIDO))

        assertEquals(DownloadState.CONCLUIDO, DownloadStore(backing).reconciliarNaSubida().single().state)
    }

    @Test
    fun `remover tira da lista`() {
        val store = DownloadStore(MemoriaStore())
        store.salvar(registro(id = 1))
        store.remover(1)
        assertNull(store.porId(1))
    }

    @Test
    fun `progresso de mp4 vem dos bytes`() {
        val r = registro(kind = MediaKind.MP4).copy(bytesBaixados = 25L, bytesTotal = 100L)
        assertEquals(25, r.progresso)
    }

    @Test
    fun `progresso de hls vem dos segmentos`() {
        // Somar bytes exigiria um HEAD por segmento, e um episodio tem centenas.
        val r = registro(kind = MediaKind.HLS).copy(segmentosBaixados = 3, segmentosTotal = 4, bytesTotal = -1L)
        assertEquals(75, r.progresso)
    }

    @Test
    fun `progresso indeterminado quando nao ha total`() {
        assertEquals(-1, registro().copy(bytesTotal = -1L).progresso)
    }

    @Test
    fun `concluido e sempre cem por cento`() {
        val r = registro(state = DownloadState.CONCLUIDO).copy(bytesBaixados = 0L, bytesTotal = -1L)
        assertEquals(100, r.progresso)
    }

    @Test
    fun `armazenamento corrompido nao derruba a lista`() {
        val backing = MemoriaStore()
        backing.gravar("registros", "isto nao e json")
        assertEquals(emptyList<DownloadRecord>(), DownloadStore(backing).todos())
    }
}
