/**
 * Registro dos providers de canais ao vivo.
 *
 * Um provider é descrito por duas coisas: como montar a URL da página do player
 * a partir de um `providerChannelId`, e quais hosts de mídia ele tem direito de
 * devolver. Nada mais — não há credencial, cookie nem chave aqui, porque este
 * provider não usa nenhum (ver a tabela da Fase A em `docs/canais-fase-a.md`).
 *
 * ## Por que os hosts de CDN vêm do ambiente
 *
 * O host da página do player já está no repositório desde
 * `src/lib/mediaProviders.ts`, e repeti-lo aqui não acrescenta exposição. Os
 * hosts de **mídia** são outra história: a regra de vazamento do projeto trata
 * domínio de CDN em diff como bloqueador, e com razão — é a metade da
 * informação que falta para alguém montar a URL sozinho. Então eles entram por
 * `CANAIS_CDN_ALLOWLIST`, e o repositório carrega só o formato, nunca o valor.
 *
 *   CANAIS_CDN_ALLOWLIST="cdn-a.example.test,cdn-b.example.test"
 *
 * Sem a variável, `hostDeMidiaPermitido` recusa tudo. É o comportamento certo:
 * uma allowlist vazia que nega é um canal fora do ar; uma allowlist vazia que
 * libera é um SSRF.
 */

/** Chave interna do provider. Nunca é o domínio, e nunca sai numa resposta. */
export type ProviderDeCanal = "megafrix";

interface DefinicaoDeProvider {
  /**
   * Monta a URL da página do player. O `providerChannelId` é interpolado num
   * único lugar, e `montarUrlDoPlayer` valida o formato antes — um id com `/`,
   * `?` ou `..` reescreveria o caminho e mudaria o host de destino.
   */
  paginaDoPlayer(providerChannelId: string): string;
  /** Host da página do player, para a checagem de allowlist da resolução. */
  hostDoPlayer: string;
}

const PROVIDERS: Record<ProviderDeCanal, DefinicaoDeProvider> = {
  megafrix: {
    hostDoPlayer: process.env.CANAIS_PLAYER_HOST || "megafrixapi.com",
    paginaDoPlayer: (id) =>
      `https://${process.env.CANAIS_PLAYER_HOST || "megafrixapi.com"}/desktop/player/channel.php?id=${encodeURIComponent(id)}`,
  },
};

export function ehProviderConhecido(v: string): v is ProviderDeCanal {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, v);
}

/**
 * Só letras, dígitos, `_` e `-`. Deliberadamente mais estreito do que o que o
 * provider aceitaria: o conjunto que a Fase A observou nos 136 canais cabe
 * aqui, e o que não cabe não é um canal — é uma tentativa de sair do caminho.
 */
const ID_DE_CANAL = /^[A-Za-z0-9_-]{1,64}$/;

export function ehIdDeProviderValido(id: string): boolean {
  return ID_DE_CANAL.test(id);
}

export function montarUrlDoPlayer(provider: ProviderDeCanal, providerChannelId: string): string {
  if (!ehIdDeProviderValido(providerChannelId)) {
    throw new Error("providerChannelId fora do formato");
  }
  return PROVIDERS[provider].paginaDoPlayer(providerChannelId);
}

export function hostDoPlayer(provider: ProviderDeCanal): string {
  return PROVIDERS[provider].hostDoPlayer;
}

// ── Allowlist de hosts de mídia ──────────────────────────────────────────────

/**
 * Sufixo, e sempre com o ponto: `.exemplo.com` não pode casar `malexemplo.com`.
 * Mesmo critério do Worker (`hostPermitido` em `workers/media-proxy`), de
 * propósito — as duas pontas precisam concordar sobre o que é permitido, senão
 * uma delas vira o elo frouxo.
 */
function casaSufixo(host: string, permitido: string): boolean {
  return host === permitido || host.endsWith(`.${permitido}`);
}

export function hostsDeMidiaPermitidos(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return (env.CANAIS_CDN_ALLOWLIST || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function hostDeMidiaPermitido(
  host: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const alvo = host.toLowerCase();
  const lista = hostsDeMidiaPermitidos(env);
  if (lista.length === 0) return false;
  return lista.some((permitido) => casaSufixo(alvo, permitido));
}
