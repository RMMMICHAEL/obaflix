/**
 * Extração da URL de mídia a partir do HTML do player.
 *
 * Puro e sem I/O — nenhuma dependência de Node —, para rodar igual nos dois
 * lados: no backend, na resolução inicial (`resolver.ts`), e no **edge**, na
 * re-resolução quando o upstream rotaciona (`workers/media-proxy/src/canais.ts`).
 * É por ser sem dependências que o Worker pode importá-lo.
 *
 * ## O que mudou de premissa
 *
 * `player_url`/`providerChannelId` é a **identidade estável** do canal;
 * `media_url` é **descoberta transitória** e nunca é fonte de verdade. A mesma
 * página do player pode passar a conter uma URL de mídia diferente de um momento
 * para o outro — daí esta extração ser reexecutada quando a mídia atual falha,
 * e não só uma vez no cadastro.
 */

/**
 * Extrai candidatos a URL de mídia do HTML do player.
 *
 * Casa `.m3u8` e `.mp4` em atribuição de configuração (`source:`, `file:`,
 * `src:`) **e** solta no HTML, porque o player deste provider escreve a URL
 * direto num literal. A ordem do documento é preservada: o primeiro candidato
 * válido vence, que é o que o player faria.
 *
 * Não executa JavaScript. Um provider que só monta a URL em runtime não é
 * resolvido aqui — e não deve passar a ser por meio de um `eval` no backend.
 */
export function extrairCandidatosDeMidia(html: string): string[] {
  const achados: string[] = [];
  const vistos = new Set<string>();
  const padrao = /https:\/\/[A-Za-z0-9._~%-]+\/[A-Za-z0-9._~%/+-]*\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
  for (const m of html.matchAll(padrao)) {
    const url = m[0];
    if (!vistos.has(url)) {
      vistos.add(url);
      achados.push(url);
    }
  }
  return achados;
}
