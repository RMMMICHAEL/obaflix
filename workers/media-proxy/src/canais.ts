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
 * > **O egress ser o mesmo é premissa, não garantia.** "Mesma invocação" não é
 * > promessa contratual de IP de saída estável na Cloudflare — egress dedicado
 * > é recurso à parte. Antes de ativar, rode `npm run canais:verificar-edge`
 * > contra o Worker publicado; se der intermitente, a ativação para e a
 * > alternativa escolhida precisa ser testada com o mesmo script. Ver
 * > `docs/canais-fase-a.md`.
 *
 * ## As rotas
 *
 *   /canal/<sid>/master.m3u8    manifesto da sessão
 *   /canal/<sid>/v/<idBase>/<rec>   manifesto filho (variante)
 *   /canal/<sid>/s/<idBase>/<rec>   segmento
 *
 * `<idBase>` é opaco e determinístico — `HMAC(chave, base)` truncado —, e
 * `<rec>` é caminho+query do upstream percent-encodado num segmento só. Todas
 * exigem `?e=<exp>&k=<hmac>`.
 *
 * ## O que segura cada coisa
 *
 * | Controle | O que segura |
 * |---|---|
 * | HMAC sobre `escopo:sid:nonce:recurso:exp` | URL forjada pelo cliente |
 * | `exp` conferido antes da criptografia | replay de link antigo |
 * | Nonce vindo da sessão, nunca da URL | URL capturada sobreviver à renovação |
 * | Geração anterior só dentro da grace | handoff sem matar o player, e sem janela longa |
 * | Sessão no Redis, TTL curto + teto absoluto | concessão revogada continuar valendo |
 * | Id opaco de base, não host | descoberta do CDN pela URL |
 * | Allowlist no alvo de mídia **e** na página de arm | vazamento de chave virar SSRF |
 * | Resposta montada campo a campo | domínio real vazar em header |
 *
 * O que este Worker **não** faz, e não pode fazer: identificar quem está
 * pedindo. A requisição do player não carrega credencial nossa. O `sub` da
 * sessão existe para o backend conferir na renovação, não aqui.
 */

import { reescreverManifesto, vazaUpstream } from "../../../src/lib/canais/hls";
import {
  chaveDaBase,
  chaveDaSessao,
  desempacotarRecurso,
  materialAssinado,
  materialDaChave,
  materialDoIdDaBase,
  semanaDaChave,
  TAMANHO_DA_ASSINATURA,
  TAMANHO_DO_ID_DE_BASE,
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

/**
 * Falha temporária. Usada quando **nós** não conseguimos cumprir o pedido —
 * Redis fora, por exemplo —, e não quando o pedido é inválido.
 *
 * A distinção importa para o cliente: 403 é "desista e peça outra concessão";
 * 503 é "tente de novo". Colapsar os dois faria uma queda de Redis parecer
 * revogação em massa.
 */
function indisponivel(): Response {
  return new Response("Indisponível", {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "2" },
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

async function hmacCru(env: EnvCanais, material: string, semana: number): Promise<string> {
  const chave = await derivarChave(env.ASSINATURA_SECRET, semana);
  const dados = new TextEncoder().encode(material);
  return base64url(await crypto.subtle.sign("HMAC", chave, dados));
}

async function hmac(env: EnvCanais, p: Recurso, semana: number): Promise<string> {
  return (await hmacCru(env, materialAssinado(p), semana)).slice(0, TAMANHO_DA_ASSINATURA);
}

async function idDaBase(env: EnvCanais, base: string, agoraMs: number): Promise<string> {
  const material = materialDoIdDaBase(base);
  return (await hmacCru(env, material, semanaDaChave(agoraMs))).slice(0, TAMANHO_DO_ID_DE_BASE);
}

/**
 * Confere a assinatura contra as gerações aceitáveis da sessão.
 *
 * A corrente sempre; a anterior **só** enquanto `graceAte` não passou. É a
 * janela de handoff: sem ela, girar o nonce numa renovação mataria as URLs que
 * o player está usando naquele exato instante.
 */
async function assinaturaConfere(
  env: EnvCanais,
  p: Omit<Recurso, "nonce">,
  sessao: SessaoDeCanal,
  sig: string,
  agoraMs: number,
): Promise<boolean> {
  const nonces = [sessao.nonce];
  if (sessao.noncePrevio && agoraMs < sessao.graceAte) nonces.push(sessao.noncePrevio);

  const w = semanaDaChave(agoraMs);
  for (const nonce of nonces) {
    for (const semana of [w, w - 1]) {
      if (iguaisEmTempoConstante(await hmac(env, { ...p, nonce }, semana), sig)) return true;
    }
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

// ── Sessão e bases (Redis via REST do Upstash) ───────────────────────────────

interface SessaoDeCanal {
  canalId: string;
  sub: string;
  upstream: string;
  paginaDoPlayer: string;
  referer: string | null;
  userAgent: string | null;
  nonce: string;
  noncePrevio: string | null;
  graceAte: number;
  criadaEm: number;
  expiraEm: number;
  expiraDefinitivamenteEm: number;
}

/**
 * Redis, e não KV: o estado aqui decide autorização, e KV é eventualmente
 * consistente. Uma revogação levaria até um minuto para valer em todos os
 * pontos — e é nesse minuto que um replay funciona.
 *
 * Lança em qualquer falha. Quem chama decide se isso é 403 (não achou) ou 503
 * (não deu para saber) — e a diferença entre os dois é o assunto de
 * `persistirBases`.
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
    if (typeof s.upstream !== "string" || typeof s.nonce !== "string" || !s.nonce) return null;
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
 * Renova o TTL da sessão. **Best-effort, e pode ser.**
 *
 * Nada aqui muda conteúdo: só empurra a janela deslizante. Se falhar, a sessão
 * continua com o TTL anterior e a reprodução segue — nenhum manifesto já
 * servido passa a apontar para algo inexistente.
 *
 * É o oposto de `persistirBases`, e a diferença é exatamente essa: lá a escrita
 * é pré-requisito do que vai ser servido; aqui não é.
 */
async function renovarTtlDaSessao(env: EnvCanais, sessionId: string, s: SessaoDeCanal, ttlS: number) {
  try {
    await comandoRedis(env, [
      "SET",
      chaveDaSessao(sessionId),
      JSON.stringify({ ...s, expiraEm: Date.now() + ttlS * 1000 }),
      "EX",
      ttlS,
    ]);
  } catch {
    /* ver o comentário acima: falhar aqui não compromete nada já servido */
  }
}

/**
 * Cache de bases por isolate.
 *
 * O mapa id→base é imutável (o id deriva do valor), então cachear não pode
 * devolver resposta errada. Serve a dois propósitos: evitar um GET no Redis por
 * segmento — são centenas por reprodução — e evitar reescrever a mesma linha a
 * cada manifesto.
 *
 * É cache, não autoridade: a sessão continua sendo lida do Redis em toda
 * requisição, e é ela que decide autorização.
 */
const MAX_CACHE_DE_BASES = 500;
const cacheDeBases = new Map<string, string>();
/** id → instante até o qual já sabemos que a linha está no Redis. */
const basesPersistidasAte = new Map<string, number>();

function lembrarBase(id: string, base: string, persistidaAteMs: number): void {
  if (cacheDeBases.size >= MAX_CACHE_DE_BASES) {
    // Descarte simples do mais antigo: `Map` mantém ordem de inserção, e o
    // custo de errar é uma ida ao Redis.
    const primeiro = cacheDeBases.keys().next();
    if (!primeiro.done) {
      cacheDeBases.delete(primeiro.value);
      basesPersistidasAte.delete(primeiro.value);
    }
  }
  cacheDeBases.set(id, base);
  basesPersistidasAte.set(id, persistidaAteMs);
}

async function resolverBase(env: EnvCanais, id: string): Promise<string | null> {
  const emCache = cacheDeBases.get(id);
  if (emCache) return emCache;
  let bruto: unknown;
  try {
    bruto = await comandoRedis(env, ["GET", chaveDaBase(id)]);
  } catch {
    return null;
  }
  if (typeof bruto !== "string" || !bruto) return null;
  lembrarBase(id, bruto, Date.now() + TTL_BASE_S * 1000);
  return bruto;
}

/**
 * Persiste as bases de um manifesto. **Obrigatório: lança se não conseguir.**
 *
 * O manifesto reescrito já contém o id de cada base. Servi-lo sem a linha
 * correspondente no Redis entregaria ao player um documento cujos segmentos
 * todos respondem 403 — uma falha que parece revogação e não é.
 *
 * Por isso este caminho **não** engole erro, ao contrário de
 * `renovarTtlDaSessao`. Quem chama transforma a exceção em 503, e o player
 * tenta de novo.
 *
 * Concorrência não é problema aqui: o id deriva do valor, então duas
 * descobertas simultâneas da mesma base gravam o mesmo par, e de bases
 * diferentes gravam chaves diferentes. Não existe o `SET` de um documento
 * comum que a versão anterior tinha, e com ele foi embora o last-write-wins.
 */
async function persistirBases(
  env: EnvCanais,
  bases: { id: string; base: string }[],
  agoraMs: number,
): Promise<void> {
  const pendentes = bases.filter((b) => (basesPersistidasAte.get(b.id) ?? 0) <= agoraMs);
  if (pendentes.length === 0) return;

  await Promise.all(
    pendentes.map((b) => comandoRedis(env, ["SET", chaveDaBase(b.id), b.base, "EX", TTL_BASE_S])),
  );
  // Só marca depois de todas terem gravado. Marcar antes faria uma falha
  // parcial virar "já está lá" para a próxima requisição deste isolate.
  for (const b of pendentes) lembrarBase(b.id, b.base, agoraMs + TTL_BASE_S * 1000);
}

/** Espelho de `src/lib/canais/sessao.ts`. Mudou lá, muda aqui. */
const TTL_SESSAO_S = 7 * 60;
const TTL_GRANT_S = 5 * 60;
const TTL_SEGMENTO_S = 90;
const TTL_BASE_S = 6 * 3600;

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

const ROTA = /^\/canal\/([A-Za-z0-9_-]{16,64})\/(master\.m3u8|[vs]\/[A-Za-z0-9_-]{8,32}\/[^/]+)$/;

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

  // A sessão vem **antes** da assinatura, porque os nonces que fecham o HMAC
  // moram nela. É o que faz uma renovação invalidar as URLs antigas passada a
  // grace, e uma revogação invalidar tudo na hora. O custo é um GET no Redis
  // para pedido inválido — aceitável: `sessionId` são 24 bytes aleatórios.
  const sessao = await lerSessao(env, sessionId);
  if (!sessao) return negar();

  if (!(await assinaturaConfere(env, { escopo, sessionId, recurso, exp }, sessao, sig, agora))) {
    return negar();
  }

  // Qual URL upstream este pedido representa.
  let alvoBruto: string;
  if (ehMaster) {
    alvoBruto = sessao.upstream;
  } else {
    const partes = desempacotarRecurso(recurso);
    if (!partes) return negar();
    const base = await resolverBase(env, partes.idDaBase);
    // Base desconhecida é recusa, nunca um padrão. Com id determinístico, o
    // pior caso deixou de ser "aponta para a base errada" e passou a ser "não
    // encontrada" — o player rebusca o manifesto e a base é redescoberta.
    if (!base) return negar();
    alvoBruto = base + partes.caminhoComQuery;
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

  // As URLs novas são sempre assinadas com a geração **corrente**, mesmo quando
  // o pedido chegou com a anterior dentro da grace. É isso que faz o handoff
  // ser quase invisível: durante a janela, a URL antiga de manifesto continua
  // respondendo, e devolve segmentos já da geração nova.
  const reescrito = await reescreverManifesto({
    manifesto: texto,
    urlDoManifesto: alvo.toString(),
    sessionId,
    baseDoEdge,
    expSegmento,
    expManifesto,
    assinar: (esc, rec, e) =>
      hmac(
        env,
        { escopo: esc, sessionId, nonce: sessao.nonce, recurso: rec, exp: e },
        semanaDaChave(agora),
      ),
    idDaBase: (base) => idDaBase(env, base, agora),
  });

  // Rede de segurança independente da lista de tags: se sobrou host de terceiro
  // no que ia sair, não sai. Prefere-se canal quebrado a CDN publicado.
  if (vazaUpstream(reescrito.manifesto, baseDoEdge)) return negar();

  // **Antes** de servir. O manifesto já carrega os ids das bases; entregá-lo
  // sem elas no Redis daria ao player um documento cujos segmentos respondem
  // todos 403. Falhar aqui é 503, e o player tenta de novo.
  try {
    await persistirBases(env, reescrito.basesUsadas, agora);
  } catch {
    return indisponivel();
  }

  // Só agora, e best-effort: nada já servido depende disto.
  await renovarTtlDaSessao(env, sessionId, sessao, TTL_SESSAO_S);

  saida.set("Content-Type", "application/vnd.apple.mpegurl");
  // Manifesto de live muda a cada segmento. Cache nenhum.
  saida.set("Cache-Control", "no-store");
  return new Response(req.method === "HEAD" ? null : reescrito.manifesto, {
    status: 200,
    headers: saida,
  });
}

/** Só para teste: zera os caches de isolate entre cenários. */
export function __limparCachesDeBase(): void {
  cacheDeBases.clear();
  basesPersistidasAte.clear();
}
