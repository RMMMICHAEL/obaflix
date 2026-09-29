package com.obaflix.tv.player

import org.json.JSONObject

/**
 * Coordenadas de episodio por fonte, do lado da TV.
 *
 * Alguns provedores numeram as temporadas de outro jeito que o catalogo (ver
 * `src/lib/episodeCoordinates.ts`). O servidor monta ate quatro coordenadas por
 * fonte e continua sendo a autoridade sobre elas: aqui so circula o indice. O
 * episodio do Obaflix — progresso, historico, proximo episodio — nao muda.
 *
 * E o mesmo contrato do player do site, do Electron e do aplicativo movel:
 * `/api/player/fonte-nativa` recebe `tentativa` e responde `tentativas`.
 */
internal object CoordenadasTv {
    /** Mesmo teto do servidor (`MAX_TENTATIVAS_COORDENADA`). */
    const val MAX = 4

    /** Corpo de `/api/player/fonte-nativa`. Sem `tentativa` na 0: igual ao de sempre. */
    fun corpo(sessao: String, fonteId: String, tentativa: Int): JSONObject =
        JSONObject().put("sessao", sessao).put("fonteId", fonteId).also {
            if (tentativa > 0) it.put("tentativa", tentativa)
        }

    /** Quantas coordenadas o servidor declarou. Ausente, invalido ou servidor antigo: 1. */
    fun total(raiz: JSONObject): Int {
        val n = raiz.optInt("tentativas", 1)
        return if (n < 1) 1 else minOf(n, MAX)
    }

    /** Proximo indice ainda nao tentado, em ordem; null quando acabou. */
    fun proxima(feitas: Set<Int>, total: Int): Int? =
        (0 until minOf(total, MAX)).firstOrNull { it !in feitas }

    // A que reproduziu, por fonte: renovacao e failover de volta a mesma fonte
    // recomecam por ela, e nao trocam de episodio no meio. O id da fonte e opaco
    // e novo a cada sessao; o mapa e pequeno e descarta os mais antigos.
    private val lembradas = object : LinkedHashMap<String, Int>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>?) = size > 64
    }

    @Synchronized
    fun lembrada(fonteId: String): Int = lembradas[fonteId] ?: 0

    @Synchronized
    fun lembrar(fonteId: String, tentativa: Int) {
        if (tentativa in 0 until MAX) lembradas[fonteId] = tentativa
    }

    @Synchronized
    internal fun esquecerTudo() = lembradas.clear()
}
