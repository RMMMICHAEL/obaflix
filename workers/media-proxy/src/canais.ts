/**
 * Entrega de canais ao vivo — o caminho novo deste Worker.
 *
 * Separado do proxy de filmes/séries de propósito, e não por organização: o
 * caminho antigo recebe a URL assinada pelo backend e a busca; este aqui **não
 * recebe URL nenhuma**, porque a URL de canal nunca sai do servidor. Misturar
 * os dois numa função só faria a regra "o cliente escolhe o alvo" e a regra "o
 * cliente nunca escolhe o alvo" conviverem no mesmo `if`.
 *
 * ## O problema que este arquivo resolve
 *
 * A Fase A mediu o provider de canais e achou duas coisas:
 *
 * 1. O manifesto responde **403 até que a página do player tenha sido buscada
 *    pelo mesmo IP**. Depois disso responde 200 para qualquer requisição — sem
 *    Referer, sem User-Agent, sem cookie. O estado é do provider, por par
 *    (IP, canal). Chamamos de *arm*.
 * 2. A URL de mídia é **permanente**. Não expira, não é assinada, e a mesma
 *    string vale no dia seguinte.
 *
 * O primeiro achado diz que **quem arma tem de ser quem busca** — se o backend
 * resolvesse e o aparelho tocasse, o CDN veria dois IPs e devolveria 403. O
 * segundo diz que entregar a URL ao aparelho é entregar o canal para sempre.
 *
 * Daí o desenho: o Worker arma e busca na **mesma invocação**, do mesmo egress,
 * e o aparelho nunca vê o upstream.
 *
 * ## As rotas
 *
 *   /canal/<sid>/master.m3u8   manifesto da sessão
 *   /canal/<sid>/v/<i>/<path>  manifesto filho (variante)
 *   /canal/<sid>/s/<i>/<path>  segmento
 *
 * `<i>` é o índice da base upstream **dentro da sessão no Redis**, nunca o
 * host. Todas exigem `?e=<exp>&k=<hmac>`.
 *
 * ## O que segura cada coisa
 *
 * | Controle | O que segura |
 * |---|---|
 * | HMAC sobre `escopo:sid:recurso:exp` | URL forjada pelo cliente |
 * | `exp` conferido antes do HMAC | replay de link antigo |
 * | Sessão no Redis, TTL curto | concessão revogada continuar valendo |
 * | Índice de base, não host | descoberta do CDN pela URL |
 * | Allowlist de host no upstream | vazamento de chave virar SSRF |
 * | Resposta montada campo a campo | domínio real vazar em header |
 *
 * Nenhum é opcional, e nenhum deles é "o" controle: a URL permanente do
 * provider significa que um vazamento não tem conserto por expiração.
 */

import { reescreverManifesto, vazaUpstream } from "../../../src/lib/canais/hls";
import {
  chaveDaSessao,
  materialAssinado,
  materialDaChave,
  semanaDaChave,
  TAMANHO_DA_ASSINATURA,
  type EscopoDeCanal,
} from "../../../src/lib/canais/assinatura";

export interface EnvCanais {
  ASSINATURA_SECRET: string;
  CDN_ALLOWLIST: string;
  APP_ORIGIN: string;
  /** Base pública deste Worker, para as URLs reescritas. Sem barra final. */
  CANAIS_MEDIA_BASE: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

/** Resposta única para toda recusa: o cliente nunca aprende o motivo. */
function negar(): Response {
  return new Response("Acesso negado", {
    status: 403,
    headers: { "Cache-Control": "no-store" },
  });
}

// ── Assinatura ───────────────────────────────────────────────────────────────

async function derivarChave(secret: string, semana: number): Promise<CryptoKey> {
  const material = new TextEncoder().encode(materialDaChave(secret, semana));
  const bruta = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", bruta, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function base64url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

async function hmac(
  env: EnvCanais,
  p: { escopo: EscopoDeCanal; sessionId: string; recurso: string; exp: number },
  semana: number,
): Promise<string> {
  const chave = await derivarChave(env.ASSINATURA_SECRET, semana);
  const dados = new TextEncoder().encode(materialAssinado(p));
  return base64url(await crypto.subtle.sign("HMAC", chave, dados)).slice(0, TAMANHO_DA_ASSINATURA);
}

async function assinaturaConfere(
  env: EnvCanais,
  p: { escopo: EscopoDeCanal; sessionId: string; recurso: string; exp: number },
  sig: string,
  agoraMs: number,
): Promise<boolean> {
  const w = semanaDaChave(agoraMs);
  for (const semana of [w, w - 1]) {
    if (iguaisEmTempoConstante(await hmac(env, p, semana), sig)) return true;
  }
  return false;
}

// ── Allowlist ────────────────────────────────────────────────────────────────

/** Sufixo, e sempre com o ponto: `.exemplo.com` não casa `malexemplo.com`. */
function hostPermitido(host: string, allowlist: string): boolean {
  const alvo = host.toLowerCase();
  return allowlist
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .some((p) => alvo === p || alvo.endsWith(`.${p}`));
}

// ── Sessão (Redis via REST do Upstash) ───────────────────────────────────────

interface SessaoDeCanal {
  canalId: string;
  sub: string;
  upstream: string;
  paginaDoPlayer: string;
  referer: string | null;
  userAgent: string | null;
  bases: string[];
  nonce: string;
  criadaEm: number;
  expiraEm: number;
}

/**
 * Redis, e não KV: o estado aqui decide autorização, e KV é eventualmente
 * consistente. Uma revogação levaria até um minuto para valer em todos os
 * pontos — e é nesse minuto que um replay funciona.
 */
async function comandoRedis(env: EnvCanais, cmd: (string | number)[]): Promise<unknown> {
  const r = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  const corpo = (await r.json()) as { result?: unknown };
  return corpo.result ?? null;
}

async function lerSessao(env: EnvCanais, sessionId: string): Promise<SessaoDeCanal | null> {
  let bruto: unknown;
  try {
    bruto = await comandoRedis(env, ["GET", chaveDaSessao(sessionId)]);
  } catch {
    return null;
  }
  if (typeof bruto !== "string") return null;
  try {
    const s = JSON.parse(bruto) as SessaoDeCanal;
    if (typeof s.upstream !== "string" || !Array.isArray(s.bases)) return null;
    if (typeof s.expiraEm !== "number" || s.expiraEm < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Regrava a sessão e renova o TTL. Janela deslizante: enquanto o player busca
 * manifesto a sessão vive; parou de buscar, ela morre sozinha em `ttlS`.
 */
async function gravarSessao(
  env: EnvCanais,
  sessionId: string,
  s: SessaoDeCanal,
  ttlS: number,
): Promise<void> {
  try {
    await comandoRedis(env, [
      "SET",
      chaveDaSessao(sessionId),
      JSON.stringify({ ...s, expiraEm: Date.now() + ttlS * 1000 }),
      "EX",
      ttlS,
    ]);
  } catch {
    // Falha ao renovar não derruba a reprodução em curso: a sessão ainda tem o
    // TTL antigo. O que não pode é a falha virar concessão — e não vira, porque
    // este caminho só escreve, nunca autoriza.
  }
}

const TTL_SESSAO_S = 30 * 60;
const TTL_MANIFESTO_S = 60 * 60;
const TTL_SEGMENTO_S = 5 * 60;

// ── Busca no upstream, com arm ───────────────────────────────────────────────

const TIMEOUT_MS = 15_000;

function cabecalhosParaUpstream(s: SessaoDeCanal, req: Request): Headers {
  const h = new Headers();
  for (const nome of ["range", "accept", "accept-encoding"]) {
    const v = req.headers.get(nome);
    if (v) h.set(nome, v);
  }
  // A Fase A mediu que este provider não exige nenhum dos dois. Os campos
  // existem na sessão para o dia em que um provider exigir — e nesse dia é aqui
  // que eles entram, não no aparelho.
  if (s.referer) {
    h.set("Referer", s.referer);
    try {
      h.set("Origin", new URL(s.referer).origin);
    } catch {
      /* referer inválido: segue sem Origin */
    }
  }
  if (s.userAgent) h.set("User-Agent", s.userAgent);
  return h;
}

/**
 * Busca a página do player. É isto que arma o grant do provider para o IP
 * **deste Worker** — o mesmo que vai buscar a mídia a seguir, na mesma
 * invocação.
 *
 * O corpo é descartado: quem extrai a URL de mídia é o backend, na resolução. O
 * que interessa aqui é só o efeito colateral.
 */
async function armar(env: EnvCanais, s: SessaoDeCanal): Promise<void> {
  try {
    const alvo = new URL(s.paginaDoPlayer);
    if (alvo.protocol !== "https:") return;
    const r = await fetch(alvo.toString(), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": s.userAgent ?? "Mozilla/5.0", Accept: "text/html,*/*" },
    });
    await r.body?.cancel().catch(() => {});
  } catch {
    // Falha ao armar não é conclusiva: o grant pode já estar de pé. Deixa a
    // busca da mídia decidir — ela é quem sabe se deu 403.
  }
}

/**
 * Busca no upstream e, se levar 403/401, **arma e tenta de novo, uma vez**.
 *
 * Uma vez, e não em laço: o 403 do provider tem duas causas possíveis — grant
 * ausente (que o arm resolve) e canal fora do ar (que o arm não resolve). Um
 * laço transformaria a segunda numa tempestade de requisições contra o provider
 * a cada player que ficasse tentando.
 */
async function buscarComArm(
  env: EnvCanais,
  s: SessaoDeCanal,
  url: string,
  req: Request,
): Promise<Response> {
  const buscar = () =>
    fetch(url, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: cabecalhosParaUpstream(s, req),
      // `manual`: seguir redirect sairia da allowlist sem revalidar.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  let r = await buscar();
  if (r.status === 403 || r.status === 401) {
    await r.body?.cancel().catch(() => {});
    await armar(env, s);
    r = await buscar();
  }
  return r;
}

/** Três portas antes de qualquer fetch: https, sem credenciais, allowlist. */
function alvoAceitavel(env: EnvCanais, bruta: string): URL | null {
  let u: URL;
  try {
    u = new URL(bruta);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (!hostPermitido(u.hostname, env.CDN_ALLOWLIST)) return null;
  return u;
}

// ── Handler ──────────────────────────────────────────────────────────────────

const ROTA = /^\/canal\/([A-Za-z0-9_-]{16,64})\/(master\.m3u8|[vs]\/\d+\/.+)$/;

export function ehRotaDeCanal(pathname: string): boolean {
  return pathname.startsWith("/canal/");
}

export async function tratarCanal(req: Request, env: EnvCanais): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return negar();

  const url = new URL(req.url);
  const m = ROTA.exec(url.pathname);
  if (!m) return negar();

  const sessionId = m[1];
  const resto = m[2];

  const expBruto = url.searchParams.get("e");
  const sig = url.searchParams.get("k");
  if (!expBruto || !sig) return negar();

  const exp = Number(expBruto);
  if (!Number.isSafeInteger(exp)) return negar();

  // Expiração antes da criptografia: pedido vencido não merece um HMAC.
  const agora = Date.now();
  if (agora > exp * 1000) return negar();

  const ehMaster = resto === "master.m3u8";
  const escopo: EscopoDeCanal = ehMaster || resto.startsWith("v/") ? "m" : "s";
  const recurso = ehMaster ? "master" : resto.slice(2);

  if (!(await assinaturaConfere(env, { escopo, sessionId, recurso, exp }, sig, agora))) {
    return negar();
  }

  const sessao = await lerSessao(env, sessionId);
  if (!sessao) return negar();

  // Qual URL upstream este pedido representa.
  let alvoBruto: string;
  if (ehMaster) {
    alvoBruto = sessao.upstream;
  } else {
    const barra = recurso.indexOf("/");
    const indice = Number(recurso.slice(0, barra));
    const caminho = recurso.slice(barra + 1);
    // O índice vem da URL, logo é entrada. Uma base fora do intervalo não é
    // "base 0 por padrão": é recusa.
    if (!Number.isInteger(indice) || indice < 0 || indice >= sessao.bases.length) return negar();
    alvoBruto = sessao.bases[indice] + caminho;
  }

  const alvo = alvoAceitavel(env, alvoBruto);
  if (!alvo) return negar();

  let upstream: Response;
  try {
    upstream = await buscarComArm(env, sessao, alvo.toString(), req);
  } catch {
    return new Response("Falha ao buscar mídia", {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => {});
    return negar();
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    // Repassa a classe do erro, não o corpo: o cliente precisa distinguir
    // "acabou" de "quebrou" para decidir entre pedir outra concessão e desistir.
    return new Response(null, {
      status: upstream.status === 404 || upstream.status === 410 ? 410 : 502,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Resposta montada campo a campo. Repassar os headers do CDN inteiros
  // devolveria Location, Set-Cookie e afins — é assim que o domínio real vaza.
  const saida = new Headers();
  saida.set("Access-Control-Allow-Origin", env.APP_ORIGIN);
  saida.set("X-Content-Type-Options", "nosniff");

  if (escopo === "s") {
    for (const nome of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(nome);
      if (v) saida.set(nome, v);
    }
    // Segmento de live é imutável e some rápido. O `private` impede cache
    // compartilhado de servir o segmento de uma sessão para outra.
    saida.set("Cache-Control", `private, max-age=${TTL_SEGMENTO_S}`);
    return new Response(upstream.body, { status: upstream.status, headers: saida });
  }

  // Manifesto: precisa ser lido inteiro e reescrito.
  const texto = await upstream.text();
  const expSegmento = Math.floor(agora / 1000) + TTL_SEGMENTO_S;
  const expManifesto = Math.floor(agora / 1000) + TTL_MANIFESTO_S;

  const reescrito = await reescreverManifesto({
    manifesto: texto,
    urlDoManifesto: alvo.toString(),
    sessionId,
    baseDoEdge: env.CANAIS_MEDIA_BASE.replace(/\/+$/, ""),
    basesConhecidas: sessao.bases,
    expSegmento,
    expManifesto,
    assinar: (esc, rec, e) => hmac(env, { escopo: esc, sessionId, recurso: rec, exp: e }, semanaDaChave(agora)),
  });

  // Rede de segurança independente da lista de tags: se sobrou host de terceiro
  // no que ia sair, não sai. Prefere-se canal quebrado a CDN publicado.
  if (vazaUpstream(reescrito.manifesto, env.CANAIS_MEDIA_BASE.replace(/\/+$/, ""))) {
    return negar();
  }

  // Só escreve quando a reescrita descobriu base nova. Renova o TTL sempre: é
  // a janela deslizante que mantém a sessão viva enquanto se assiste.
  await gravarSessao(
    env,
    sessionId,
    reescrito.basesMudaram ? { ...sessao, bases: reescrito.bases } : sessao,
    TTL_SESSAO_S,
  );

  saida.set("Content-Type", "application/vnd.apple.mpegurl");
  // Manifesto de live muda a cada segmento. Cache nenhum.
  saida.set("Cache-Control", "no-store");
  return new Response(req.method === "HEAD" ? null : reescrito.manifesto, {
    status: 200,
    headers: saida,
  });
}
