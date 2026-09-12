package com.obaflix.ads

import org.json.JSONObject

/**
 * O JavaScript que liga `window.obaflixAds` a ponte nativa.
 *
 * Injetado pelo proprio aplicativo, nunca servido pelo site: o Obaflix na Vercel
 * e o Electron continuam exatamente como estao, e nenhum navegador comum recebe
 * uma linha disto.
 *
 * ## Por que ele e de 20 linhas, e o anterior tinha 672
 *
 * `AdGateScript` (branch `local/obaflix-current`) precisava interceptar cliques,
 * ancoras, trocas de rota e navegacao do player para descobrir *quando* havia
 * intencao de reproduzir — porque a decisao era do aparelho e ele tinha de
 * adivinhar o momento. Aqui a interface React pede o anuncio explicitamente,
 * depois de o servidor dizer que ele e necessario. Nao ha o que interceptar.
 *
 * O script so expoe a capacidade. Quem a usa e `useAnuncio.tsx`.
 */
object AdsScript {

    /**
     * Monta o script com o `capability` desta sessao.
     *
     * O valor entra por `JSONObject.quote` — montar JavaScript por concatenacao
     * e o habito que um dia encontra uma string que ninguem validou.
     */
    fun montar(capability: String): String {
        val cap = JSONObject.quote(capability)
        return """
(function () {
  if (window.obaflixAds) return;
  var nativo = window.${AdsBridge.NOME_JS};
  if (!nativo || typeof nativo.mostrarAnuncio !== 'function') return;

  // Superficie minima: a capacidade desta sessao e uma funcao. O React chama
  // mostrarAnuncio(capability, desafioId) e espera window.__obaflixAnuncioConcluido,
  // que o nativo invoca com o mesmo desafioId — e o que descarta callback
  // tardia de um pedido anterior.
  Object.defineProperty(window, 'obaflixAds', {
    value: Object.freeze({
      capability: $cap,
      mostrarAnuncio: function (capability, desafioId) {
        nativo.mostrarAnuncio(capability, desafioId);
      }
    }),
    writable: false,
    configurable: false
  });
})();
""".trimIndent()
    }
}
