package com.obaflix.ads

import android.content.Context

/**
 * Persistencia do contador de episodios em SharedPreferences.
 *
 * Comportamento escolhido, explicito de proposito:
 *
 *  - **Sobrevive** a recriacao da Activity (rotacao, troca de tema, mudanca de
 *    configuracao), a morte do processo e ao fechamento do aplicativo. Guardar
 *    so em memoria faria o ciclo reiniciar em qualquer recriacao da UI, e o
 *    usuario nunca veria o anuncio do segundo episodio.
 *  - **Nao** e sincronizado com backend nesta etapa — nao ha API de planos nem
 *    de frequencia. O ciclo e local ao aparelho, e isso e suficiente para a
 *    regra "um a cada 2 episodios".
 *  - **Some** se o usuario limpar os dados do aplicativo ou reinstalar. Aceito:
 *    o pior caso e um anuncio a menos, nunca um a mais nem reproducao travada.
 *
 * Escrita com `apply()`: assincrona, sem tocar o disco na thread principal.
 */
class PrefsAdCounterStore(context: Context) : AdCounterStore {

    private val prefs =
        context.applicationContext.getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE)

    override var episodiosNoCiclo: Int
        get() = prefs.getInt(CHAVE_CICLO, 0)
        set(value) {
            prefs.edit().putInt(CHAVE_CICLO, value).apply()
        }

    private companion object {
        const val ARQUIVO = "obaflix_ads"
        const val CHAVE_CICLO = "episodios_no_ciclo"
    }
}
