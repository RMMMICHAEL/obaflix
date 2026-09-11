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
 * O primeiro achado diz que **quem arma tem de ser quem busca**; o segundo, que
 * entregar a URL ao aparelho é entregar o canal para sempre. Daí o desenho: o
 * Worker arma e busca na **mesma invocação**, e o aparelho nunca vê o upstream.
 *
 * > **O egress precisa ser provado no Worker publicado.** "Mesma invocação" não
 * > é promessa contratual de IP de saída estável na Cloudflare — IP de egress
 * > dedicado é recurso à parte. Antes de ativar, rode
 * > `scripts/verificar-arm-no-edge.ts` contra o Worker real. Ver
 * > `docs/canais-fase-a.md`.
 *
 * ## As rotas
 *
 *   /canal/<sid>/master.m3u8   manifesto da sessão
 *   /canal/<sid>/v/<i>/<rec>   manifesto filho (variante)
 *   /canal/<sid>/s/<i>/<rec>   segmento
 *
 * `<i>` é o índice da base upstream **dentro da sessão no Redis**, nunca o
 * host; `<rec>` é caminho+query do upstream, percent-encodado num segmento só.
 * Todas exigem `?e=<exp>&k=<hmac>`.
 *
 * ## O que segura cada coisa
 *
 * | Controle | O que segura |
 * |---|---|
 * | HMAC sobre `escopo:sid:nonce:recurso:exp` | URL forjada pelo cliente |
 * | `exp` conferido antes da criptografia | replay de link antigo |
 * | Nonce vindo da sessão, nunca da URL | URL capturada sobreviver à renovação |
 * | Sessão no Redis, TTL curto + teto absoluto | concessão revogada continuar valendo |
 * | Índice de base, não host | descoberta do CDN pela URL |
 * | Allowlist no alvo de mídia **e** na página de arm | vazamento de chave virar SSRF |
 * | Resposta montada campo a campo | domínio real vazar em header |
 *
 * O que este Worker **não** faz, e não pode fazer: identificar quem está
 * pedindo. A requisição do player não carrega credencial nossa. O `sub` da
 * sessão existe para o backend conferir na renovação, não aqui.
 */

import { reescreverManifesto, vazaUpstream } from "../../../src/lib/canais/hls";
import {
  chaveDaSessao,
  desempacotarRecurso,
  materialAssinado,
  materialDaChave,
  semanaDaChave,
  TAMANHO_DA_ASSINATURA,
  type EscopoDeCanal,
} from "../../../src/lib/canais/assinatura";

export interface EnvCanais {
  /**
   * `CANAIS_MEDIA_SIGNING_SECRET` do backend. **Não** é o `NEXTAUTH_SECRET`:
   * este Worker roda em infra de terceiro, e um vazamento aqui não pode
   * alcançar a assinatura de sessão de autenticação do produto.
   */
  ASSINATURA_SECRET: string;
  /** Sufixos de host permitidos como alvo de mídia, separados por vírgula. */
  CDN_ALLOWLIST: string;
  /**
   * Sufixos de host permitidos para a **página que arma o grant**.
   *
   * Lista própria, e não a de CDN: são papéis diferentes, com hosts diferentes,
   * e juntá-las daria a um host de CDN comprometido o direito de ser buscado
   * como página de arm — e vice-versa. Vazia recusa o arm, nunca o libera.
   */
  CANAIS_PLAYER_ALLOWLIST: string;
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

interface Recurso {
  escopo: EscopoDeCanal;
  sessionId: string;
  nonce: string;
  recurso: string;
  exp: number;
}

async function hmac(env: EnvCanais, p: Recurso, semana: number): Promise<string> {
  const chave = await derivarChave(env.ASSINATURA_SECRET, semana);
  const dados = new TextEncoder().encode(materialAssinado(p));
  return base64url(await crypto.subtle.sign("HMAC", chave, dados)).slice(0, TAMANHO_DA_ASSINATURA);
}

async function assinaturaConfere(
  env: EnvCanais,
  p: Recurso,
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

/**
 * Sufixo, e sempre com o ponto: `.exemplo.com` não casa `malexemplo.com`.
 * Lista vazia nega tudo — allowlist vazia que libera é um SSRF.
 */
function hostPermitido(host: string, allowlist: string): boolean {
  const alvo = host.toLowerCase();
  const lista = (allowlist || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (lista.length === 0) return false;
  return lista.some((p) => alvo === p || alvo.endsWith(`.${p}`));
}

/** Três portas antes de qualquer fetch: https, sem credenciais, allowlist. */
function alvoAceitavel(bruta: string, allowlist: string): URL | null {
  let u: URL;
  try {
    u = new URL(bruta);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (!hostPermitido(u.hostname, allowlist)) return null;
  return u;
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
  expiraDefinitivamenteEm: number;
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
    if (typeof s.nonce !== "string" || !s.nonce) return null;
    const agora = Date.now();
    if (typeof s.expiraEm !== "number" || s.expiraEm < agora) return null;
    // Teto absoluto: a janela deslizante sozinha é imortal.
    if (typeof s.expiraDefinitivamenteEm !== "number" || s.expiraDefinitivamenteEm < agora) {
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/**
 * Regrava a sessão e renova o TTL. Janela deslizante: enquanto o player busca
 * manifesto a sessão vive; parou de buscar, ela morre sozinha em `ttlS`.
 *
 * Nunca move `expiraDefinitivamenteEm` — é o que obriga a reautorização pelo
 * backend de tempos em tempos.
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

/** Espelho de `src/lib/canais/sessao.ts`. Mudou lá, muda aqui. */
const TTL_SESSAO_S = 7 * 60;
const TTL_GRANT_S = 5 * 60;
const TTL_SEGMENTO_S = 90;

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
 * A página passa pela sua própria allowlist. A URL vem da sessão, que vem do
 * nosso backend, mas "veio do banco" não é o mesmo que "é um alvo permitido": a
 * allowlist é o que segura o caso de a chave de assinatura vazar e alguém
 * conseguir plantar uma sessão.
 *
 * O corpo é descartado: quem extrai a URL de mídia é o backend, na resolução. O
 * que interessa aqui é só o efeito colateral.
 */
async function armar(env: EnvCanais, s: SessaoDeCanal): Promise<void> {
  const alvo = alvoAceitavel(s.paginaDoPlayer, env.CANAIS_PLAYER_ALLOWLIST);
  if (!alvo) return;
  try {
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

// ── Handler ──────────────────────────────────────────────────────────────────

const ROTA = /^\/canal\/([A-Za-z0-9_-]{16,64})\/(master\.m3u8|[vs]\/\d+\/[^/]+)$/;

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

  // Expiração antes de tudo: pedido vencido não merece nem um GET no Redis nem
  // um HMAC.
  const agora = Date.now();
  if (agora > exp * 1000) return negar();

  const ehMaster = resto === "master.m3u8";
  const escopo: EscopoDeCanal = ehMaster || resto.startsWith("v/") ? "m" : "s";
  const recurso = ehMaster ? "master" : resto.slice(2);

  // A sessão vem **antes** da assinatura, porque o nonce que fecha o HMAC mora
  // nela. É o que faz uma renovação (nonce novo) invalidar na hora toda URL
  // emitida antes, mesmo dentro da validade. O custo é um GET no Redis para
  // pedido inválido — aceitável: `sessionId` são 24 bytes aleatórios, adivinhar
  // não é um caminho, e a expiração já barrou o replay óbvio acima.
  const sessao = await lerSessao(env, sessionId);
  if (!sessao) return negar();

  const confere = await assinaturaConfere(
    env,
    { escopo, sessionId, nonce: sessao.nonce, recurso, exp },
    sig,
    agora,
  );
  if (!confere) return negar();

  // Qual URL upstream este pedido representa.
  let alvoBruto: string;
  if (ehMaster) {
    alvoBruto = sessao.upstream;
  } else {
    const partes = desempacotarRecurso(recurso);
    // O recurso vem da URL, logo é entrada. Índice fora do intervalo não é
    // "base 0 por padrão": é recusa. E um caminho que tente subir de diretório
    // já foi recusado no desempacotamento.
    if (!partes || partes.indiceDaBase >= sessao.bases.length) return negar();
    alvoBruto = sessao.bases[partes.indiceDaBase] + partes.caminhoComQuery;
  }

  const alvo = alvoAceitavel(alvoBruto, env.CDN_ALLOWLIST);
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
  const baseDoEdge = env.CANAIS_MEDIA_BASE.replace(/\/+$/, "");
  const expSegmento = Math.floor(agora / 1000) + TTL_SEGMENTO_S;
  // O manifesto filho não pode valer mais do que o grant que trouxe o pai: sem
  // este teto, uma variante cunharia um link novo a cada busca e a concessão se
  // renovaria sozinha para sempre, sem passar pelo backend.
  const expManifesto = Math.min(exp, Math.floor(agora / 1000) + TTL_GRANT_S);

  const reescrito = await reescreverManifesto({
    manifesto: texto,
    urlDoManifesto: alvo.toString(),
    sessionId,
    baseDoEdge,
    basesConhecidas: sessao.bases,
    expSegmento,
    expManifesto,
    assinar: (esc, rec, e) =>
      hmac(
        env,
        { escopo: esc, sessionId, nonce: sessao.nonce, recurso: rec, exp: e },
        semanaDaChave(agora),
      ),
  });

  // Rede de segurança independente da lista de tags: se sobrou host de terceiro
  // no que ia sair, não sai. Prefere-se canal quebrado a CDN publicado.
  if (vazaUpstream(reescrito.manifesto, baseDoEdge)) return negar();

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
