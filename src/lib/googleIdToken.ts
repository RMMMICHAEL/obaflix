import crypto from "node:crypto";
import type { PerfilGoogle } from "@/lib/googleSignIn";

/**
 * Valida um ID token do Google (login nativo do Android via Credential Manager). Nada que o cliente informa vale por si:
 * só a assinatura RS256 de uma chave do Google, o emissor, o público (client id Web do Obaflix), a validade e o `nonce`
 * (amarrado ao desafio PKCE desta tentativa) autorizam a identidade. Qualquer falha devolve null.
 */
const EMISSORES = new Set(["https://accounts.google.com", "accounts.google.com"]);
const TOLERANCIA_RELOGIO_SEG = 120;

type Jwk = crypto.JsonWebKey & { kid?: string };

export interface OpcoesIdToken {
  audiencias: string[];
  nonce: string;
  /** `refresh` = o kid não está no cache: busca de novo antes de recusar. */
  chaves: (refresh: boolean) => Promise<Jwk[]>;
  agoraSeg?: number;
}

const decodificar = (parte: string) => JSON.parse(Buffer.from(parte, "base64url").toString("utf8")) as Record<string, unknown>;

export async function verificarIdTokenGoogle(token: string, opcoes: OpcoesIdToken): Promise<PerfilGoogle | null> {
  try {
    const partes = token.split(".");
    if (partes.length !== 3 || opcoes.audiencias.length === 0 || !opcoes.nonce) return null;
    const cabecalho = decodificar(partes[0]);
    if (cabecalho.alg !== "RS256" || typeof cabecalho.kid !== "string") return null;

    let chave = (await opcoes.chaves(false)).find((k) => k.kid === cabecalho.kid);
    if (!chave) chave = (await opcoes.chaves(true)).find((k) => k.kid === cabecalho.kid);
    if (!chave) return null;
    const publica = crypto.createPublicKey({ key: chave, format: "jwk" });
    const assinaturaOk = crypto.verify("RSA-SHA256", Buffer.from(`${partes[0]}.${partes[1]}`), publica, Buffer.from(partes[2], "base64url"));
    if (!assinaturaOk) return null;

    const p = decodificar(partes[1]);
    const agora = opcoes.agoraSeg ?? Math.floor(Date.now() / 1000);
    if (typeof p.iss !== "string" || !EMISSORES.has(p.iss)) return null;
    if (typeof p.aud !== "string" || !opcoes.audiencias.includes(p.aud)) return null;
    if (typeof p.exp !== "number" || p.exp <= agora) return null;
    if (typeof p.iat === "number" && p.iat > agora + TOLERANCIA_RELOGIO_SEG) return null;
    if (p.nonce !== opcoes.nonce) return null;
    if (typeof p.sub !== "string" || typeof p.email !== "string") return null;
    return {
      sub: p.sub,
      email: p.email,
      emailVerificado: p.email_verified === true || p.email_verified === "true",
      nome: typeof p.name === "string" ? p.name : null,
      foto: typeof p.picture === "string" ? p.picture : null,
      dominioGerenciado: typeof p.hd === "string" && p.hd.length > 0,
    };
  } catch {
    return null;
  }
}

let cache: { chaves: Jwk[]; em: number } | null = null;

/** Chaves públicas do Google, com cache de 1 h em memória (sem Redis); `refresh` ignora o cache, no máximo a cada 60 s. */
export async function chavesGoogle(refresh: boolean): Promise<Jwk[]> {
  const agora = Date.now();
  if (cache && (!refresh ? agora - cache.em < 3_600_000 : agora - cache.em < 60_000)) return cache.chaves;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs", { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!r.ok) return cache?.chaves ?? [];
  const corpo = (await r.json()) as { keys?: Jwk[] };
  cache = { chaves: Array.isArray(corpo.keys) ? corpo.keys : [], em: agora };
  return cache.chaves;
}
