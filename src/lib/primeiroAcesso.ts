/**
 * Confirmação da compra e primeiro acesso do Obaflix Cortes.
 *
 * Conta sem senha recebe um link de ativação: prova que o e-mail é dela e
 * permite criar a senha. Conta com senha só recebe orientação para entrar —
 * a senha existente nunca é trocada por este caminho.
 *
 * O token tem 256 bits, vale 30 minutos e é de uso único. No Redis fica só o
 * SHA-256 dele; o token em si existe apenas no e-mail. Só o link mais recente
 * de cada conta vale.
 */
import { createHash, randomBytes } from "node:crypto";
import { getRedis, type RedisClient } from "./redis";
import { audit } from "./auditLog";
import { enviarEmail, type MensagemDeEmail, type ResultadoDoEnvio } from "./email/enviar";
import { INSTALADORES } from "@/config/downloads";

export const VALIDADE_ATIVACAO_SEG = 30 * 60;
const FORMATO_DO_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hashDoToken = (token: string) => createHash("sha256").update(token).digest("hex");
const chaveDoToken = (hash: string) => `ativacao:token:${hash}`;
const chaveDaConta = (userId: string) => `ativacao:conta:${userId}`;
// Prefixos: o cliente Upstash desserializa valores com cara de número.
const valorDoToken = (userId: string) => `u:${userId}`;
const valorDaConta = (hash: string) => `h:${hash}`;

export async function emitirTokenDeAtivacao(userId: string, redis: RedisClient = getRedis()): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hash = hashDoToken(token);
  const anterior = await redis.get(chaveDaConta(userId));
  if (anterior?.startsWith("h:")) await redis.del(chaveDoToken(anterior.slice(2)));
  await redis.set(chaveDoToken(hash), valorDoToken(userId), { ex: VALIDADE_ATIVACAO_SEG });
  await redis.set(chaveDaConta(userId), valorDaConta(hash), { ex: VALIDADE_ATIVACAO_SEG });
  return token;
}

/** O `userId` do link, consumindo-o. `null` para link inválido, vencido ou já usado. */
export async function consumirTokenDeAtivacao(token: unknown, redis: RedisClient = getRedis()): Promise<string | null> {
  if (typeof token !== "string" || !FORMATO_DO_TOKEN.test(token)) return null;
  const hash = hashDoToken(token);
  const chave = chaveDoToken(hash);
  const valor = await redis.get(chave);
  if (!valor?.startsWith("u:")) return null;
  // Apagar condicionalmente é o consumo: com duas requisições do mesmo link, só uma apaga.
  if ((await redis.compareAndDelete(chave, valor)) !== 1) return null;
  const userId = valor.slice(2);
  await redis.compareAndDelete(chaveDaConta(userId), valorDaConta(hash));
  return userId;
}

/** Mesmas regras do cadastro: 8 a 128 caracteres, com letra e número. */
export function senhaValida(senha: unknown): senha is string {
  return typeof senha === "string" && senha.length >= 8 && senha.length <= 128 && /[a-zA-Z]/.test(senha) && /[0-9]/.test(senha);
}

export interface ContaDoComprador {
  userId: string;
  email: string;
  /** Sem senha: recebe link de ativação. Com senha: só orientação de login. */
  semSenha: boolean;
  compra?: { pedidoId: string; plano: string; valorCentavos: number; moeda: string; iniciaEm: Date; terminaEm: Date };
}

export interface DependenciasDoPrimeiroAcesso {
  enviar: (m: MensagemDeEmail) => Promise<ResultadoDoEnvio>;
  redis: RedisClient;
  base: string | undefined;
}

function mensagem(conta: ContaDoComprador, base: string, token: string | null): MensagemDeEmail {
  const escapar = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const link = token ? `${base}/ativar#t=${token}` : `${base}/login`;
  const orientacao = token ? "Ative sua conta e crie sua senha. Link individual, válido por 30 minutos e de uso único." : "Entre com o e-mail da compra e sua forma habitual de login. Sua senha existente permanece a mesma.";
  const compra = conta.compra;
  const data = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const detalhes = compra ? `Plano: ${compra.plano}\nPeríodo: ${data(compra.iniciaEm)} a ${data(compra.terminaEm)}\nValor pago: ${new Intl.NumberFormat("pt-BR", { style: "currency", currency: compra.moeda }).format(compra.valorCentavos / 100)}` : "";
  const download = INSTALADORES.windowsCortes.url;
  const urlDownload = new URL(download);
  if (urlDownload.protocol !== "https:" || urlDownload.username || urlDownload.password) throw new Error("download_invalido");
  return {
    para: conta.email,
    assunto: compra ? "Compra confirmada — Obaflix Cortes" : token ? "Ative sua conta Obaflix Cortes" : "Seu Obaflix Cortes está ativo",
    texto: `OBAFLIX CORTES\n\nSeu pagamento foi confirmado. O acesso respeita o período da compra.\n${detalhes}\n\n${orientacao}\n${link}\n\nBaixe o instalador oficial Obaflix Cortes para Windows:\n${download}\n\nSe você não reconhece esta compra, procure o suporte.`,
    html: `<div style="background:#171313;color:#f4f4f5;padding:32px;font-family:Arial,sans-serif"><h1 style="color:#ef4444">OBAFLIX CORTES</h1><h2>Compra confirmada</h2><p>Seu pagamento foi confirmado. O acesso respeita o período da compra.</p>${detalhes ? `<p>${escapar(detalhes).replace(/\n/g, "<br>")}</p>` : ""}<p>${escapar(orientacao)}</p><p><a style="color:#f87171" href="${escapar(link)}">${token ? "Ativar conta e criar senha" : "Entrar no Obaflix Cortes"}</a></p><p><a style="color:#f87171" href="${escapar(download)}">Baixar Obaflix Cortes para Windows</a></p><p>Se você não reconhece esta compra, procure o suporte.</p></div>`,
  };
}

/** Envia o e-mail do primeiro acesso. Nunca lança: falha só é registrada. */
export async function notificarPrimeiroAcesso(
  conta: ContaDoComprador,
  deps: Partial<DependenciasDoPrimeiroAcesso> = {},
): Promise<ResultadoDoEnvio> {
  try {
    const base = (deps.base ?? process.env.NEXTAUTH_URL)?.trim().replace(/\/+$/, "");
    const urlBase = base ? new URL(base) : null;
    if (!base || !urlBase || urlBase.protocol !== "https:" || urlBase.username || urlBase.password || urlBase.search || urlBase.hash || urlBase.pathname !== "/") {
      audit("email_failed", { userId: conta.userId, detail: "primeiro_acesso configuracao" });
      return { ok: false, motivo: "configuracao" };
    }
    const token = conta.semSenha ? await emitirTokenDeAtivacao(conta.userId, deps.redis ?? getRedis()) : null;
    const r = await (deps.enviar ?? enviarEmail)(mensagem(conta, base, token));
    audit(r.ok ? "email_sent" : "email_failed", {
      userId: conta.userId,
      detail: `primeiro_acesso ${token ? "ativacao" : "orientacao"}${conta.compra ? ` pedido:${conta.compra.pedidoId}` : ""}${r.ok ? (r.simulado ? " simulado" : "") : ` ${r.motivo}`}`,
    });
    return r;
  } catch {
    audit("email_failed", { userId: conta.userId, detail: `primeiro_acesso erro${conta.compra ? ` pedido:${conta.compra.pedidoId}` : ""}` });
    return { ok: false, motivo: "rede" };
  }
}
