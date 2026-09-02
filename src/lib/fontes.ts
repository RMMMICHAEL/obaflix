/**
 * Montagem da lista de fontes — no servidor.
 *
 * Motivo de existir: até aqui o CustomPlayer montava cada `embedUrl` no
 * navegador. Consequência medida na auditoria de 26/08/2026: os domínios reais
 * eram strings literais do bundle (visíveis sem login) e as URLs do banco
 * viajavam nas props do componente cliente, ou seja, dentro do payload RSC —
 * legíveis com "ver código-fonte", sem abrir DevTools.
 *
 * Agora a lista nasce aqui. O cliente recebe apenas um id opaco por fonte e um
 * rótulo genérico ("Servidor 1"). Quem traduz id → URL real é o servidor, em
 * /api/player/token e /api/player/extract. O mapa vive no Redis com TTL curto,
 * amarrado ao userId.
 *
 * O que continua chegando ao dispositivo, e por quê: em Electron e Android a
 * extração roda no aparelho para usar o IP residencial do usuário — sem isso o
 * CDN recusa o IP de datacenter da Vercel e o Transfer Out volta para o proxy.
 * Nesses dois ambientes a URL real é entregue sob demanda, uma fonte por vez,
 * por /api/player/fonte-nativa, e nunca antecipadamente.
 */

import crypto from "crypto";
import { getRedis } from "./redis";

// ── Tipos ─────────────────────────────────────────────────────────────────────

/** Ambiente que pediu a lista. Decide quais fontes são oferecidas. */
export type Ambiente = "web" | "electron" | "android";

/** Como a fonte vive no servidor. Nunca sai inteira para o cliente comum. */
export interface FonteReal {
  id: string;
  ordem: number;
  embedUrl: string;
  /** Slug interno do provedor — diagnóstico administrativo apenas. */
  provider: string;
  /** Nome real do servidor, como o provedor o chama. Admin apenas. */
  servidor: string;
  idioma: "dub" | "leg" | null;
  tokenized: boolean;
  /** Extrator nativo disponível no Electron/Android (IP residencial). */
  nativo: boolean;
  /** Embed que já é player completo: carrega em iframe sem extração. */
  iframeDireto: boolean;
  /** Precisa do desafio Cloudflare visível no Android antes da extração. */
  iframeDesafio: boolean;
  /** Iframe deste provedor nunca reproduz: fallback para iframe = falha. */
  iframeInvalido: boolean;
  /** Sem extrator conhecido — só serve como iframe de última linha. */
  semExtrator: boolean;
  disponivel: boolean;
  motivoIndisponivel?: string;
  videoId?: number;
}

/** O que o usuário comum recebe. Nenhum campo identifica o provedor. */
export interface FontePublica {
  id: string;
  rotulo: string;
  idioma: "dub" | "leg" | null;
  disponivel: boolean;
  motivoIndisponivel?: string;
  nativo: boolean;
  iframeDireto: boolean;
  iframeDesafio: boolean;
  iframeInvalido: boolean;
  semExtrator: boolean;
  /**
   * O servidor entrega a mídia já resolvida, em vez de um embed para extrair.
   *
   * Existe para um caso só: provedores cuja resolução depende de credencial de
   * conta, que não pode viajar para o aparelho. O cliente nativo recebe a URL
   * final e busca a mídia direto no CDN — nenhum byte de vídeo passa por nós.
   */
  resolvidoNoServidor: boolean;
}

/** O que o administrador autenticado recebe a mais. */
export interface FonteAdmin extends FontePublica {
  provider: string;
  servidor: string;
  host: string;
  embedUrl: string;
  videoId?: number;
}

// ── Classificação por host ────────────────────────────────────────────────────
// Mesma classificação que o Kotlin, o Electron e a rota de extração já usam.
// Fica aqui para que o cliente não precise mais conhecer nenhum host.

function hostIs(host: string, ...allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

export function detectarProvider(url: string): { provider: string; temExtrator: boolean } {
  let host: string;
  let pathname: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {
    return { provider: "desconhecido", temExtrator: false };
  }

  if (hostIs(host, "webcinevs2.com")) return { provider: "webcine", temExtrator: true };
  if (hostIs(host, "playerflix.ink")) return { provider: "playerflix", temExtrator: true };
  if (hostIs(host, "v1.watchplay.shop", "watchplay.shop")) return { provider: "watchplayer", temExtrator: true };
  if (hostIs(host, "embedplayer1.xyz", "embedplayer2.xyz",
    "xn--kcksk7a2bl5le7b6doc1h3f.com", "xn--tckasiu6cvova0eb5fua2449g98vg.best")) {
    return { provider: "embedplayer", temExtrator: true };
  }
  if (hostIs(host, "superflixapi.pro", "superflixapi.sbs", "superflixapi.beer")) return { provider: "superflix", temExtrator: true };
  if (hostIs(host, "playhide.shop", "hidehide.shop", "vidhidehub.com")) return { provider: "hide", temExtrator: true };
  if (hostIs(host, "luluvdo.com", "lulu.gg", "luluvid.com", "lulustream.com")) return { provider: "lulu", temExtrator: true };
  if (hostIs(host, "streamwish.com", "playerwish.com", "hlswish.com", "wishonly.site",
    "cdnwish.com", "asnwish.com", "swishsrv.com")) {
    return { provider: "wish", temExtrator: true };
  }
  if (hostIs(host, "boltcdn.xyz", "upbolt.to")) return { provider: "bolt", temExtrator: true };
  if (hostIs(host, "bigshare.link")) return { provider: "big", temExtrator: true };
  if (hostIs(host, "llanfairpwllgwyngy.com") || pathname.includes("/rola/")) {
    return { provider: "rola", temExtrator: true };
  }
  if (hostIs(host, "redecanais.capital")) return { provider: "redecanais", temExtrator: true };
  if (pathname.includes("voltz.php")) return { provider: "voltz", temExtrator: true };
  return { provider: "desconhecido", temExtrator: false };
}

/** URLs com token CDN temporário (rola3/rola4/embedplayer) — só com IP residencial. */
export function ehTokenizada(url: string): boolean {
  return /\/(rola3|rola4)\//.test(url)
    || /embedplayer/.test(url)
    || /xn--kcksk7a2bl5le7b6doc1h3f|xn--tckasiu6cvova0eb5fua2449g98vg/.test(url);
}

/**
 * Provedores com extrator nativo no Electron/Android. Porte exato de
 * `supportsNativeDesktopExtraction`, que vivia no CustomPlayer — o cliente
 * precisava conhecer os hosts só para responder esta pergunta.
 */
export function suportaExtracaoNativa(url: string): boolean {
  if (ehTokenizada(url)) return true;
  let host: string;
  let pathname: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {
    return false;
  }
  if (ehPlayerflixAjax(url)) return true;
  if (pathname.includes("voltz.php")) return true;
  if (host.includes("lulu")) return true;
  if (host.includes("hide")) return true;
  if (host.includes("wish")) return true;
  if (host.includes("llanfair") || pathname.includes("/rola/")) return true;
  if (host.includes("bolt")) return true;
  if (host.includes("bigshare") || host.includes("big")) return true;
  if (host.includes("watchplay")) return true;
  if (/(^|\.)superflixapi\.(pro|sbs|beer)$/i.test(host)) return true;
  if (host === "redecanais.capital" || host.endsWith(".redecanais.capital")) return true;
  return false;
}

export function ehSuperflix(url: string): boolean {
  try {
    return /(^|\.)superflixapi\.(pro|sbs|beer)$/i.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function ehPlayerflixAjax(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "playerflix.ink" && parsed.pathname === "/inc/Ajax.php";
  } catch {
    return false;
  }
}

/** Provedores cujo iframe nunca reproduz: cair no iframe significa falha real. */
function ehIframeInvalido(url: string): boolean {
  return url.includes("playerflix.ink") || url.includes("webcinevs2.com");
}

export function hostDe(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "-";
  }
}

// ── Estado no Redis ───────────────────────────────────────────────────────────

/**
 * TTL da sessão de fontes.
 *
 * O mapa NÃO é de uso único: o mesmo `fonteId` é resolvido várias vezes numa
 * reprodução — troca manual de servidor, retry, failover, renovação de token
 * expirado e retomada de posição passam todos por aqui. Nada consome nem apaga
 * a entrada.
 *
 * E o TTL é deslizante: toda leitura bem-sucedida renova a expiração, então a
 * sessão não pode morrer enquanto o usuário estiver na tela de reprodução. O
 * TTL só corre quando ninguém mais toca nela.
 */
const SESSAO_TTL_SEC = 4 * 60 * 60;

// ── Diagnóstico do ciclo de vida ──────────────────────────────────────────────
// Só em desenvolvimento, com PLAYER_DIAG=1, ou quando quem pediu é admin.
// Nunca imprime embedUrl, token ou sessão inteira.

function diagAtivo(admin = false): boolean {
  return admin || process.env.NODE_ENV !== "production" || process.env.PLAYER_DIAG === "1";
}

/** Prefixo curto: identifica a sessão nos logs sem servir para resolvê-la. */
function marca(valor: string): string {
  return `${valor.slice(0, 6)}…`;
}

export function diagFonte(
  evento: string,
  campos: Record<string, string | number | boolean | null | undefined>,
  admin = false,
): void {
  if (!diagAtivo(admin)) return;
  const partes = Object.entries(campos)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[fontes/${evento}] ${partes}`);
}

/** Por que uma sessão não resolveu. Vira o `codigo` da resposta HTTP. */
export type MotivoSessao =
  | "formato_invalido"
  | "ausente"
  | "dono_diferente"
  | "corrompida";

const chaveSessao = (sessao: string) => `play:fontes:${sessao}`;

interface SessaoArmazenada {
  uid: string;
  /**
   * Ambiente declarado na criação. Uma sessão "web" nunca resolve URL real:
   * o navegador não extrai nada localmente, então não há caso legítimo em que
   * ele precise da URL. Só Electron e Android passam por /fonte-nativa.
   */
  ambiente: Ambiente;
  fontes: FonteReal[];
  /** Epoch de criação — só para o diagnóstico dizer a idade da sessão. */
  criadaEm?: number;
}

function novoId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

/**
 * Id opaco e sem relação com o destino. Nunca derivar de hash do host: o
 * conjunto de provedores é pequeno e conhecido, então um hash seria revertido
 * por força bruta em segundos.
 */
export async function criarSessaoFontes(
  userId: string,
  ambiente: Ambiente,
  fontes: FonteReal[],
): Promise<string> {
  const sessao = crypto.randomBytes(16).toString("base64url");
  const payload: SessaoArmazenada = { uid: userId, ambiente, fontes, criadaEm: Date.now() };
  await getRedis().set(chaveSessao(sessao), JSON.stringify(payload), { ex: SESSAO_TTL_SEC });
  diagFonte("criada", {
    sessao: marca(sessao), uid: marca(userId), ambiente,
    fontes: fontes.length, ttl: SESSAO_TTL_SEC,
    ids: fontes.map((f) => `${f.ordem}:${marca(f.id)}`).join(","),
  });
  return sessao;
}

type LeituraSessao =
  | { ok: true; dados: SessaoArmazenada; ttl: number }
  | { ok: false; motivo: MotivoSessao; ttl: number };

/**
 * Lê a sessão e renova o TTL. Devolve o motivo quando falha — é ele que a rota
 * usa para dizer POR QUE respondeu 410, em vez de um "expirada" genérico que
 * escondeu a causa real desta regressão.
 */
async function lerSessaoDetalhado(sessao: string, userId: string): Promise<LeituraSessao> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(sessao)) {
    return { ok: false, motivo: "formato_invalido", ttl: -2 };
  }
  const redis = getRedis();
  const chave = chaveSessao(sessao);
  const bruto = await redis.get(chave);
  if (bruto === null || bruto === undefined) {
    return { ok: false, motivo: "ausente", ttl: -2 };
  }

  let dados: SessaoArmazenada;
  try {
    // O adaptador do Redis normaliza para string; o `typeof` continua aqui como
    // rede de segurança para qualquer cliente que volte a desserializar sozinho.
    dados = (typeof bruto === "string" ? JSON.parse(bruto) : bruto) as SessaoArmazenada;
  } catch {
    return { ok: false, motivo: "corrompida", ttl: -2 };
  }
  if (!dados || !Array.isArray(dados.fontes)) {
    return { ok: false, motivo: "corrompida", ttl: -2 };
  }

  // A sessão pertence a quem a criou. Sem esta checagem, um id vazado viraria
  // um resolvedor de URL para qualquer conta autenticada.
  if (dados.uid !== userId) return { ok: false, motivo: "dono_diferente", ttl: -2 };

  // TTL deslizante: enquanto houver reprodução, a sessão não expira.
  const ttl = await redis.ttl(chave);
  await redis.expire(chave, SESSAO_TTL_SEC);
  return { ok: true, dados, ttl };
}

async function lerSessao(sessao: string, userId: string): Promise<SessaoArmazenada | null> {
  const r = await lerSessaoDetalhado(sessao, userId);
  return r.ok ? r.dados : null;
}

/** Para as rotas relatarem o motivo exato ao cliente e ao log. */
export async function diagnosticarSessao(
  sessao: string,
  userId: string,
): Promise<{ ok: boolean; motivo?: MotivoSessao; ttl: number; fontes: number }> {
  const r = await lerSessaoDetalhado(sessao, userId);
  return r.ok
    ? { ok: true, ttl: r.ttl, fontes: r.dados.fontes.length }
    : { ok: false, motivo: r.motivo, ttl: r.ttl, fontes: 0 };
}

/**
 * Resolve um `fonteId`. Repetível por desenho: nada é consumido nem apagado, e
 * cada resolução renova o TTL da sessão.
 */
export async function resolverFonte(
  sessao: string,
  userId: string,
  fonteId: string,
  admin = false,
): Promise<{ fonte: FonteReal | null; motivo?: MotivoSessao; ttl: number }> {
  const r = await lerSessaoDetalhado(sessao, userId);
  if (!r.ok) {
    diagFonte("resolve_falhou", {
      sessao: marca(sessao), uid: marca(userId), fonteId: marca(fonteId),
      motivo: r.motivo,
    }, admin);
    return { fonte: null, motivo: r.motivo, ttl: r.ttl };
  }
  const fonte = r.dados.fontes.find((f) => f.id === fonteId) ?? null;
  diagFonte("resolve", {
    sessao: marca(sessao), uid: marca(userId), fonteId: marca(fonteId),
    achou: !!fonte, ordem: fonte?.ordem, provider: fonte?.provider,
    ttlAntes: r.ttl, ttlRenovado: SESSAO_TTL_SEC, naSessao: r.dados.fontes.length,
  }, admin);
  return { fonte, ttl: r.ttl };
}

export async function lerFontes(sessao: string, userId: string): Promise<FonteReal[] | null> {
  const dados = await lerSessao(sessao, userId);
  return dados ? dados.fontes : null;
}

/** Ambiente com que a sessão foi aberta. Usado para negar /fonte-nativa na web. */
export async function ambienteDaSessao(sessao: string, userId: string): Promise<Ambiente | null> {
  const dados = await lerSessao(sessao, userId);
  return dados ? dados.ambiente : null;
}

/**
 * Acrescenta fontes descobertas depois da criação — os servidores do webcine
 * chegam na resposta da extração, e as alternativas do Playerflix chegam de uma
 * segunda chamada. Mantém a numeração estável: quem já tinha "Servidor 3"
 * continua sendo "Servidor 3" depois do crescimento da lista.
 */
export async function acrescentarFontes(
  sessao: string,
  userId: string,
  novas: Omit<FonteReal, "id" | "ordem">[],
): Promise<FonteReal[] | null> {
  const dados = await lerSessao(sessao, userId);
  if (!dados) return null;

  const existentes = new Set(dados.fontes.map((f) => f.embedUrl));
  let proximaOrdem = dados.fontes.reduce((max, f) => Math.max(max, f.ordem), 0);

  for (const nova of novas) {
    if (existentes.has(nova.embedUrl)) continue;
    existentes.add(nova.embedUrl);
    proximaOrdem += 1;
    dados.fontes.push({ ...nova, id: novoId(), ordem: proximaOrdem });
  }

  await getRedis().set(chaveSessao(sessao), JSON.stringify(dados), { ex: SESSAO_TTL_SEC });
  diagFonte("cresceu", {
    sessao: marca(sessao), uid: marca(userId),
    total: dados.fontes.length, novas: novas.length,
  });
  return dados.fontes;
}

// ── Projeções para o cliente ──────────────────────────────────────────────────

/**
 * Projeção pública. É a fronteira que a auditoria pediu: tudo que identifica o
 * provedor fica de fora por omissão de campo, não por ocultação na interface.
 */
/**
 * Provedores que o aparelho não consegue resolver sozinho, e nós sim.
 *
 * O webcine não é um embed que se raspa: é uma API autenticada por
 * refresh_token de conta (ver `src/lib/cinevs.ts`). Portar isso para o
 * aplicativo exigiria embutir a credencial no APK, que qualquer pessoa
 * descompacta — então a resolução fica aqui e só a URL final desce.
 *
 * O que isso significa, dito sem eufemismo: para **esta** fonte existe
 * dependência do backend na hora de resolver. O que continua não existindo é
 * proxy — a mídia sai do CDN direto para o aparelho, e nenhum byte de vídeo
 * passa pela Vercel. O custo por seleção são chamadas JSON pequenas, com o
 * token em cache no processo.
 */
export function resolvidoNoServidor(f: Pick<FonteReal, "provider">): boolean {
  return f.provider === "webcine";
}

export function projetarPublica(f: FonteReal): FontePublica {
  return {
    id: f.id,
    rotulo: `Servidor ${f.ordem}`,
    idioma: f.idioma,
    disponivel: f.disponivel,
    ...(f.motivoIndisponivel ? { motivoIndisponivel: f.motivoIndisponivel } : {}),
    nativo: f.nativo,
    resolvidoNoServidor: resolvidoNoServidor(f),
    iframeDireto: f.iframeDireto,
    iframeDesafio: f.iframeDesafio,
    iframeInvalido: f.iframeInvalido,
    semExtrator: f.semExtrator,
  };
}

/** Projeção administrativa. Só é montada depois de o role ser verificado. */
export function projetarAdmin(f: FonteReal): FonteAdmin {
  return {
    ...projetarPublica(f),
    provider: f.provider,
    servidor: f.servidor,
    host: hostDe(f.embedUrl),
    embedUrl: f.embedUrl,
    ...(f.videoId !== undefined ? { videoId: f.videoId } : {}),
  };
}

// ── Montagem da lista ─────────────────────────────────────────────────────────

interface EntradaBruta {
  url: string;
  idioma: "dub" | "leg";
}

/** Separa a URL do Voltz das demais — ela é posicionada independentemente. */
function separarVoltz(entradas: EntradaBruta[]): { voltz: EntradaBruta | null; resto: EntradaBruta[] } {
  const idx = entradas.findIndex((e) => e.url.includes("voltz.php"));
  if (idx === -1) return { voltz: null, resto: entradas };
  return { voltz: entradas[idx], resto: entradas.filter((_, i) => i !== idx) };
}

function expandir(urls: string | null, idioma: "dub" | "leg"): EntradaBruta[] {
  if (!urls) return [];
  return urls.split(",").map((u) => u.trim()).filter(Boolean).map((url) => ({ url, idioma }));
}

/** Base comum: preenche os campos derivados da própria URL. */
function base(url: string, servidor: string, idioma: "dub" | "leg" | null): Omit<FonteReal, "id" | "ordem"> {
  const { provider, temExtrator } = detectarProvider(url);
  return {
    embedUrl: url,
    provider,
    servidor,
    idioma,
    tokenized: ehTokenizada(url),
    nativo: suportaExtracaoNativa(url),
    iframeDireto: url.startsWith("https://vidsrc-embed.ru/embed/"),
    iframeDesafio: ehSuperflix(url),
    iframeInvalido: ehIframeInvalido(url),
    semExtrator: !temExtrator,
    disponivel: true,
  };
}

export interface EntradaMontagem {
  tmdbId: string | null;
  titulo: string | null;
  conteudoTipo: "filme" | "serie";
  temporada?: number | null;
  numeroEp?: number | null;
  urlDub: string | null;
  urlLeg: string | null;
  ambiente: Ambiente;
  /**
   * O cliente consegue conduzir um desafio "não sou robô"?
   *
   * Só o aplicativo sabe: depende de a WebView dele suportar remover o header
   * `X-Requested-With`, o que exige WebView 118+. Sem isso o provedor responde
   * acesso negado, e oferecer a fonte só entregaria uma tela de erro.
   */
  desafioInterativo?: boolean;
}

/**
 * Porte da construção que vivia em CustomPlayer.tsx. A ordem é a mesma de
 * antes — ela foi calibrada por custo de Transfer Out, não por preferência: o
 * webcine vem primeiro porque o CDN dele não valida Referer nem Origin, então a
 * mídia vai direto ao aparelho nos três ambientes e não gera Transfer Out.
 */
export function montarFontes(e: EntradaMontagem): Omit<FonteReal, "id" | "ordem">[] {
  const ehDesktop = e.ambiente !== "web";
  const ehAndroid = e.ambiente === "android";
  const fontes: Omit<FonteReal, "id" | "ordem">[] = [];

  const tmdb = e.tmdbId && /^[1-9][0-9]*$/.test(String(e.tmdbId).trim())
    ? String(e.tmdbId).trim()
    : null;

  const todas = [...expandir(e.urlDub, "dub"), ...expandir(e.urlLeg, "leg")];
  const { voltz, resto } = separarVoltz(todas);
  // rola3/rola4 só funcionam com IP residencial: no site nem são oferecidas.
  const catalogadas = resto.filter((entrada) => ehDesktop || !ehTokenizada(entrada.url));

  const acharPorHost = (...trechos: string[]) =>
    catalogadas.find((entrada) => {
      const host = hostDe(entrada.url).toLowerCase();
      return trechos.some((t) => host.includes(t) || entrada.url.toLowerCase().includes(t));
    });

  const hide = acharPorHost("hide");
  const wish = acharPorHost("wish");
  const redeCanais = catalogadas.find((entrada) =>
    hostDe(entrada.url).toLowerCase().includes("redecanais.capital"));

  // Servidor 1 — Webcine. Entrada primária; o extrator escolhe a primeira fonte
  // disponível. Os servidores por videoId são acrescentados pela rota de
  // extração, que já busca /videos e portanto não custa chamada extra.
  if (tmdb) {
    const q = e.titulo ? `&q=${encodeURIComponent(e.titulo)}` : "";
    const webcineUrl = e.conteudoTipo === "serie" && e.temporada && e.numeroEp
      ? `https://webcinevs2.com/?id=${tmdb}&type=tv&season=${e.temporada}&episode=${e.numeroEp}${q}`
      : e.conteudoTipo === "filme"
        ? `https://webcinevs2.com/?id=${tmdb}&type=movie${q}`
        : null;
    if (webcineUrl) fontes.push(base(webcineUrl, "Webcine", null));
  }

  // Playerflix. A entrada Ajax deixa o extrator escolher o servidor interno; as
  // alternativas explícitas chegam na segunda chamada.
  if (tmdb) {
    const ajaxUrl = e.conteudoTipo === "serie" && e.temporada && e.numeroEp
      ? `https://playerflix.ink/inc/Ajax.php?id=${tmdb}&type=tv&season=${e.temporada}&episode=${e.numeroEp}`
      : e.conteudoTipo === "filme"
        ? `https://playerflix.ink/inc/Ajax.php?id=${tmdb}&type=movie`
        : null;
    if (ajaxUrl) fontes.push(base(ajaxUrl, "Playerflix · Automático", null));
  }

  // SuperFlix — Electron sempre; Android só quando o cliente avisa que consegue
  // conduzir o desafio.
  //
  // A restrição original ("Electron apenas") continua valendo pelo mesmo motivo
  // de sempre: a WebView do Android envia `X-Requested-With: com.obaflix` e o
  // provedor responde acesso negado. O que mudou é que existe como remover esse
  // header — `WebSettingsCompat.setRequestedWithHeaderOriginAllowList` —, e o
  // aplicativo é o único que sabe se a WebView dele suporta (precisa da 118+).
  // Por isso a decisão vem do cliente, e não de adivinhação aqui.
  const superflixPermitido = !ehAndroid || e.desafioInterativo === true;
  if (superflixPermitido && ehDesktop && tmdb
    && (e.conteudoTipo === "filme" || (e.conteudoTipo === "serie" && e.temporada && e.numeroEp))) {
    const url = e.conteudoTipo === "filme"
      ? `https://superflixapi.beer/filme/${encodeURIComponent(tmdb)}`
      : `https://superflixapi.beer/serie/${encodeURIComponent(tmdb)}/${e.temporada}/${e.numeroEp}`;
    fontes.push(base(url, "SuperFlix", null));
  }

  // Voltz — somente Electron/Android: no site o MP4 direto falha por CORS ou
  // exigência de Referer.
  if (ehDesktop && voltz) fontes.push(base(voltz.url, "Voltz", voltz.idioma));

  if (hide) fontes.push(base(hide.url, "Hide", hide.idioma));

  // WatchPlay — somente Electron/Android.
  if (ehDesktop && tmdb) {
    if (e.conteudoTipo === "filme") {
      fontes.push(base(`https://v1.watchplay.shop/movie/${encodeURIComponent(tmdb)}`, "WatchPlay", null));
    } else if (e.conteudoTipo === "serie" && e.temporada && e.numeroEp) {
      fontes.push(base(
        `https://v1.watchplay.shop/tvshow/${encodeURIComponent(tmdb)}/${e.temporada}/${e.numeroEp}`,
        "WatchPlay", null));
    }
  }

  if (wish) fontes.push(base(wish.url, "Wish", wish.idioma));

  // RedeCanais — somente Android, e só quando a URL está cadastrada: o app não
  // escolhe resultado por título para não reproduzir o episódio errado.
  if (ehAndroid && redeCanais) fontes.push(base(redeCanais.url, "RedeCanais", redeCanais.idioma));

  return fontes;
}

/** Atribui id opaco e numeração estável a uma lista recém-montada. */
export function numerar(fontes: Omit<FonteReal, "id" | "ordem">[]): FonteReal[] {
  return fontes.map((f, i) => ({ ...f, id: novoId(), ordem: i + 1 }));
}
