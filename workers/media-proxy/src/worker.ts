/**
 * Obaflix — proxy de mídia fora da Vercel.
 *
 * NÃO ESTÁ EM USO. Este arquivo é a etapa preparada, não a etapa aplicada:
 * nenhuma rota do app aponta para cá ainda. Ver README.md ao lado para o plano
 * de corte e para o que precisa mudar no backend antes.
 *
 * Existe por um motivo só: o navegador é o único ambiente que não consegue
 * enviar o `Referer` que os CDNs exigem, então hoje cada segmento de vídeo
 * assistido no site atravessa o Compute da Vercel (~1 GB por episódio 1080p,
 * cobrado duas vezes — entrada CDN→Compute e saída). Android, Android TV e
 * Electron não passam por aqui e não devem passar: quando o provedor tem
 * extrator nativo eles já buscam direto no CDN com os cabeçalhos certos.
 *
 * O que este Worker NÃO é: um proxy aberto. Ele só busca URLs que o nosso
 * backend assinou, dentro da validade, para hosts na allowlist, a pedido da
 * nossa origem. Quatro controles independentes — nenhum deles é opcional.
 */

export interface Env {
  /** Mesmo segredo do backend (NEXTAUTH_SECRET). Só como secret do Wrangler. */
  ASSINATURA_SECRET: string;
  /** Sufixos de host permitidos como alvo, separados por vírgula. */
  CDN_ALLOWLIST: string;
  /** Origem do app, única autorizada no CORS. Ex.: https://obaflix.vercel.app */
  APP_ORIGIN: string;
}

/** Resposta única para toda recusa: o cliente nunca aprende o motivo nem o alvo. */
function negar(): Response {
  return new Response("Acesso negado", {
    status: 403,
    headers: { "Cache-Control": "no-store" },
  });
}

// ── Assinatura ───────────────────────────────────────────────────────────────

/**
 * Rotação semanal, idêntica ao backend (@/lib/playTokens): a chave da semana
 * corrente e a da anterior valem, para uma sessão iniciada perto da virada não
 * morrer no meio do episódio.
 */
function semana(agoraMs: number): number {
  return Math.floor(agoraMs / (7 * 24 * 3600 * 1000));
}

async function derivarChave(secret: string, semanaN: number): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${secret}:week:${semanaN}`);
  const bruta = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", bruta, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function base64url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Comparação em tempo constante — `===` em string vaza o prefixo por timing. */
function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/**
 * O material assinado inclui a expiração e o Referer. Assinar só a URL, como o
 * backend faz hoje, deixaria os dois livres para quem monta o pedido: a
 * assinatura duraria até a chave girar, e o Referer viraria campo de entrada de
 * um proxy que fala com CDN de terceiros.
 */
function materialAssinado(p: { sub: string; exp: number; url: string; ref: string }): string {
  return `${p.sub}:${p.exp}:${p.url}:${p.ref}`;
}

async function assinaturaConfere(
  env: Env, p: { sub: string; exp: number; url: string; ref: string }, sig: string, agoraMs: number,
): Promise<boolean> {
  const dados = new TextEncoder().encode(materialAssinado(p));
  const w = semana(agoraMs);
  for (const semanaN of [w, w - 1]) {
    const chave = await derivarChave(env.ASSINATURA_SECRET, semanaN);
    const esperado = base64url(await crypto.subtle.sign("HMAC", chave, dados)).slice(0, 22);
    if (iguaisEmTempoConstante(esperado, sig)) return true;
  }
  return false;
}

// ── Allowlist de host ────────────────────────────────────────────────────────

/**
 * Defesa em profundidade: a assinatura já garante que a URL saiu do nosso
 * backend. A allowlist é o que segura o caso de vazamento de chave — sem ela,
 * uma chave comprometida transforma o Worker em SSRF contra qualquer host.
 *
 * Sufixo, e sempre com o ponto: `.exemplo.com` não pode casar `malexemplo.com`.
 */
function hostPermitido(host: string, allowlist: string): boolean {
  const alvo = host.toLowerCase();
  return allowlist
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .some((permitido) => alvo === permitido || alvo.endsWith(`.${permitido}`));
}

// ── Handler ──────────────────────────────────────────────────────────────────

const CABECALHOS_REPASSADOS = ["range", "accept", "accept-encoding"];
const CABECALHOS_DEVOLVIDOS = [
  "content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified",
];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": env.APP_ORIGIN,
          "Access-Control-Allow-Headers": "Range",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return negar();

    const params = new URL(req.url).searchParams;
    const alvoBruto = params.get("u");
    const expBruto = params.get("e");
    const sub = params.get("s");
    const ref = params.get("r") ?? "";
    const sig = params.get("sig");
    if (!alvoBruto || !expBruto || !sub || !sig) return negar();

    const exp = Number(expBruto);
    if (!Number.isSafeInteger(exp)) return negar();

    // Expiração antes da criptografia: pedido vencido não merece um HMAC.
    const agora = Date.now();
    if (agora > exp) return negar();

    if (!(await assinaturaConfere(env, { sub, exp, url: alvoBruto, ref }, sig, agora))) return negar();

    let alvo: URL;
    try {
      alvo = new URL(alvoBruto);
    } catch {
      return negar();
    }
    // Só https, e nada de credenciais embutidas na URL.
    if (alvo.protocol !== "https:" || alvo.username || alvo.password) return negar();
    if (!hostPermitido(alvo.hostname, env.CDN_ALLOWLIST)) return negar();

    const cabecalhos = new Headers();
    for (const nome of CABECALHOS_REPASSADOS) {
      const v = req.headers.get(nome);
      if (v) cabecalhos.set(nome, v);
    }
    // A razão de este Worker existir.
    if (ref) {
      cabecalhos.set("Referer", ref);
      try { cabecalhos.set("Origin", new URL(ref).origin); } catch { /* ref inválido: segue sem Origin */ }
    }

    let upstream: Response;
    try {
      upstream = await fetch(alvo.toString(), {
        method: req.method,
        headers: cabecalhos,
        // `manual`: seguir redirect automaticamente sairia da allowlist sem
        // passar por ela de novo. Redirect vira recusa; se algum CDN passar a
        // depender disso, revalidar o destino aqui antes de seguir.
        redirect: "manual",
      });
    } catch {
      return new Response("Falha ao buscar mídia", { status: 502, headers: { "Cache-Control": "no-store" } });
    }

    if (upstream.status >= 300 && upstream.status < 400) return negar();

    // Resposta montada campo a campo: repassar os headers do CDN inteiros
    // devolveria Location, Set-Cookie e afins, e é assim que o domínio real
    // vaza para o cliente.
    const saida = new Headers();
    for (const nome of CABECALHOS_DEVOLVIDOS) {
      const v = upstream.headers.get(nome);
      if (v) saida.set(nome, v);
    }
    saida.set("Access-Control-Allow-Origin", env.APP_ORIGIN);
    saida.set("Cache-Control", "private, max-age=3600");
    saida.set("X-Content-Type-Options", "nosniff");

    return new Response(upstream.body, { status: upstream.status, headers: saida });
  },
};
