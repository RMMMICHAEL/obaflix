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
  compra?: { pedidoId: string; plano: string; valorCentavos: number; valorTotalCentavos?: number; moeda: string; iniciaEm: Date; terminaEm: Date };
}

export interface DependenciasDoPrimeiroAcesso {
  enviar: (m: MensagemDeEmail) => Promise<ResultadoDoEnvio>;
  redis: RedisClient;
  base: string | undefined;
}

function mensagem(conta: ContaDoComprador, base: string, token: string | null): MensagemDeEmail {
  const escapar = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const compra = conta.compra;
  const urlAcao = token ? `${base}/ativar#t=${token}` : `${base}/login`;
  const rotuloAcao = token ? "Ativar conta e criar senha" : "Entrar no Obaflix";
  const instrucao = token
    ? "Seu acesso foi criado. Confirme o e-mail desta compra criando uma senha. O link e individual, vale 30 minutos e pode ser usado uma unica vez."
    : "Sua conta ja possui acesso. Entre usando o e-mail da compra e sua senha ou metodo habitual de login.";
  const download = INSTALADORES.windowsCortes.url;
  const urlDownload = new URL(download);
  if (urlDownload.protocol !== "https:" || urlDownload.username || urlDownload.password) throw new Error("download_invalido");
  const dinheiro = (centavos: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: compra?.moeda ?? "BRL" }).format(centavos / 100);
  const data = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const total = compra?.valorTotalCentavos ?? compra?.valorCentavos ?? 0;
  const taxa = compra && total > compra.valorCentavos ? total - compra.valorCentavos : 0;
  const linhas: Array<[string, string]> = compra ? [
    ["Produto", compra.plano],
    ["Periodo", `${data(compra.iniciaEm)} a ${data(compra.terminaEm)}`],
    ["Valor do plano", dinheiro(compra.valorCentavos)],
    ...(taxa ? [["Taxa de servico Pix", dinheiro(taxa)] as [string,string]] : []),
    ["Total pago", dinheiro(total)],
  ] : [];
  const detalhesTexto = linhas.map(([chave, valor]) => `${chave}: ${valor}`).join("\n");
  const detalhesHtml = linhas.map(([chave, valor]) =>
    `<tr><td style="padding:9px 0;color:#52525b;font-size:14px;border-bottom:1px solid #e4e4e7">${escapar(chave)}</td><td align="right" style="padding:9px 0;font-size:14px;font-weight:600;color:#18181b;border-bottom:1px solid #e4e4e7">${escapar(valor)}</td></tr>`
  ).join("");
  const avisoWindows = "O Windows pode exibir um aviso de reputacao para aplicativos novos. Baixe somente pelo endereco oficial acima, confira a origem do arquivo e nao desative protecoes de seguranca para instalar.";
  return {
    para: conta.email,
    assunto: token ? "Ative sua conta — Obaflix Cortes" : "Seu acesso esta pronto — Obaflix Cortes",
    texto: [
      "OBAFLIX CORTES", "O seu acesso esta pronto!", "",
      compra ? "Seu pagamento foi confirmado." : "Voce solicitou um novo link para acessar sua conta.",
      detalhesTexto, "", instrucao, "", `${rotuloAcao}: ${urlAcao}`, "",
      `Baixar Obaflix Cortes para Windows: ${download}`, "", avisoWindows, "",
      "Depois de instalar, abra o Obaflix e entre com o e-mail da compra e a senha criada.",
      "Suporte: obaflixsuporte@gmail.com", "Se voce nao reconhece esta solicitacao, ignore este e-mail.",
    ].filter((linha) => linha !== undefined).join("\n"),
    html: `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
      <tr><td align="center" style="background:#171313;padding:30px 24px"><div style="color:#ffffff;font-size:25px;font-weight:800;letter-spacing:.3px">OBAFLIX <span style="color:#ef4444">CORTES</span></div><div style="color:#d4d4d8;font-size:13px;margin-top:8px">Sua compra. Seu acesso. Suas criacoes.</div></td></tr>
      <tr><td style="padding:32px 28px">
      <h1 style="font-size:24px;line-height:1.3;margin:0 0 12px;color:#18181b">Seu acesso esta pronto!</h1>
      <p style="font-size:15px;line-height:1.6;color:#3f3f46">${compra ? "Seu pagamento foi confirmado e seu plano foi ativado." : "Recebemos sua solicitacao de acesso ao Obaflix Cortes."}</p>
      ${compra ? `<div style="background:#fafafa;border:1px solid #e4e4e7;border-radius:10px;padding:14px 18px;margin:22px 0"><h2 style="font-size:15px;margin:0 0 8px">Detalhes da compra</h2><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${detalhesHtml}</table></div>` : ""}
      <p style="font-size:15px;line-height:1.6;color:#3f3f46">${escapar(instrucao)}</p>
      <table role="presentation" width="100%"><tr><td align="center" style="padding:12px 0 20px"><a href="${escapar(urlAcao)}" style="background:#dc2626;color:white;text-decoration:none;font-size:16px;font-weight:bold;padding:16px 23px;display:inline-block;border-radius:9px">${escapar(rotuloAcao)}</a></td></tr></table>
      <p style="font-size:14px;color:#52525b;line-height:1.55">Vai usar o aplicativo no computador? Baixe o instalador oficial abaixo.</p>
      <table role="presentation" width="100%"><tr><td align="center" style="padding:8px 0 18px"><a href="${escapar(download)}" style="border:1px solid #dc2626;color:#b91c1c;text-decoration:none;font-size:15px;font-weight:bold;padding:13px 22px;display:inline-block;border-radius:9px">Baixar Obaflix para Windows</a></td></tr></table>
      <p style="font-size:12px;line-height:1.55;color:#71717a;overflow-wrap:anywhere">Link oficial: <a href="${escapar(download)}" style="color:#b91c1c">${escapar(download)}</a></p>
      <div style="margin-top:20px;padding:14px;background:#fafafa;border-radius:8px;font-size:13px;line-height:1.55;color:#52525b"><strong>Instalacao no Windows:</strong> ${escapar(avisoWindows)}</div>
      <p style="font-size:13px;line-height:1.6;color:#52525b;margin-top:20px">Depois de instalar, abra o Obaflix e entre com o mesmo e-mail da compra e sua senha.</p>
      <p style="font-size:13px;color:#52525b">Precisa de ajuda? <a href="mailto:obaflixsuporte@gmail.com" style="color:#b91c1c">obaflixsuporte@gmail.com</a></p>
      </td></tr><tr><td align="center" style="background:#fafafa;padding:20px;color:#71717a;font-size:12px;line-height:1.6">E-mail automatico do Obaflix Cortes. Se nao reconhece esta solicitacao, pode ignora-la.</td></tr>
      </table></td></tr></table></body></html>`,
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
