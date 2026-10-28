/**
 * Primeiro acesso de quem comprou Cortes sem login.
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

export const VALIDADE_ATIVACAO_SEG = 30 * 60;
const LINK_DOWNLOAD_WINDOWS = "https://github.com/RMMMICHAEL/obaflix/releases/download/v1.0.16/Obaflix-Setup-1.0.16.exe";
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
}

export interface DependenciasDoPrimeiroAcesso {
  enviar: (m: MensagemDeEmail) => Promise<ResultadoDoEnvio>;
  redis: RedisClient;
  base: string | undefined;
}

function mensagem(conta: ContaDoComprador, base: string, token: string | null): MensagemDeEmail {
  if (token) {
    const link = `${base}/ativar#t=${token}`;
    return {
      para: conta.email,
      assunto: "Ative sua conta Obaflix Cortes",
      texto: `Seu pagamento foi confirmado.\n\nPara ativar sua conta e criar sua senha, acesse (válido por 30 minutos, uso único):\n${link}\n\nBaixe o instalador do Obaflix Cortes para Windows:\n${LINK_DOWNLOAD_WINDOWS}\n\nSe você não fez esta compra, ignore este e-mail.`,
      html: `<p>Seu pagamento foi confirmado.</p><p><a href="${link}">Ativar conta e criar senha</a></p><p>O link vale por 30 minutos e só pode ser usado uma vez.</p><p><a href="${LINK_DOWNLOAD_WINDOWS}">Baixar Obaflix Cortes para Windows</a></p><p>Se você não fez esta compra, ignore este e-mail.</p>`,
    };
  }
  const login = `${base}/login`;
  return {
    para: conta.email,
    assunto: "Seu Obaflix Cortes está ativo",
    texto: `Seu pagamento foi confirmado e o Obaflix Cortes já está na sua conta.\n\nEntre normalmente com seu e-mail e sua senha atual:\n${login}\n\nBaixe o instalador do Obaflix Cortes para Windows:\n${LINK_DOWNLOAD_WINDOWS}`,
    html: `<p>Seu pagamento foi confirmado e o Obaflix Cortes já está na sua conta.</p><p><a href="${login}">Entre normalmente</a> com seu e-mail e sua senha atual.</p><p><a href="${LINK_DOWNLOAD_WINDOWS}">Baixar Obaflix Cortes para Windows</a></p>`,
  };
}

/** Envia o e-mail do primeiro acesso. Nunca lança: falha só é registrada. */
export async function notificarPrimeiroAcesso(
  conta: ContaDoComprador,
  deps: Partial<DependenciasDoPrimeiroAcesso> = {},
): Promise<ResultadoDoEnvio> {
  try {
    const base = (deps.base ?? process.env.NEXTAUTH_URL)?.trim().replace(/\/+$/, "");
    if (!base) {
      audit("email_failed", { userId: conta.userId, detail: "primeiro_acesso configuracao" });
      return { ok: false, motivo: "configuracao" };
    }
    const token = conta.semSenha ? await emitirTokenDeAtivacao(conta.userId, deps.redis ?? getRedis()) : null;
    const r = await (deps.enviar ?? enviarEmail)(mensagem(conta, base, token));
    audit(r.ok ? "email_sent" : "email_failed", {
      userId: conta.userId,
      detail: `primeiro_acesso ${token ? "ativacao" : "orientacao"}${r.ok ? (r.simulado ? " simulado" : "") : ` ${r.motivo}`}`,
    });
    return r;
  } catch {
    audit("email_failed", { userId: conta.userId, detail: "primeiro_acesso erro" });
    return { ok: false, motivo: "rede" };
  }
}
