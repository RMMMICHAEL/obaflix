/**
 * Recuperação de senha por e-mail. Reaproveita o link de uso único do primeiro acesso (`emitirTokenDeAtivacao` /
 * `consumirTokenDeAtivacao`: 256 bits, 30 min, só o SHA-256 no Redis, só o link mais recente vale).
 *
 * Quem recebe o link prova que controla o e-mail da conta; o link só troca a senha. Não vincula Google nem muda plano.
 * O pedido responde sempre igual, exista a conta ou não.
 */
import { getRedis, type RedisClient } from "./redis";
import { audit } from "./auditLog";
import { enviarEmail, type MensagemDeEmail, type ResultadoDoEnvio } from "./email/enviar";
import { emitirTokenDeAtivacao, VALIDADE_ATIVACAO_SEG } from "./primeiroAcesso";

export interface DependenciasDaRecuperacao {
  enviar: (m: MensagemDeEmail) => Promise<ResultadoDoEnvio>;
  redis: RedisClient;
  base: string | undefined;
}

const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function mensagemDeRecuperacao(email: string, base: string, token: string): MensagemDeEmail {
  const url = `${base}/redefinir-senha#t=${token}`;
  const minutos = Math.round(VALIDADE_ATIVACAO_SEG / 60);
  const texto = [
    "Obaflix — redefinir senha", "",
    `Recebemos um pedido para redefinir a senha desta conta. O link vale ${minutos} minutos e só pode ser usado uma vez:`,
    url, "",
    "Se você não pediu, ignore este e-mail: sua senha continua a mesma.",
  ].join("\n");
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
<h1 style="font-size:22px;margin:0 0 12px">Redefinir senha</h1>
<p style="font-size:15px;line-height:1.6;color:#3f3f46">Recebemos um pedido para redefinir a senha da sua conta Obaflix. O link vale ${minutos} minutos e só pode ser usado uma vez.</p>
<p style="text-align:center;margin:24px 0"><a href="${escapar(url)}" style="background:#dc2626;color:#fff;text-decoration:none;font-weight:bold;padding:14px 22px;border-radius:9px;display:inline-block">Criar nova senha</a></p>
<p style="font-size:13px;line-height:1.6;color:#71717a">Se você não pediu, ignore este e-mail: sua senha continua a mesma.</p>
</div></body></html>`;
  return { para: email, assunto: "Redefinir sua senha — Obaflix", texto, html };
}

/** Emite o link e envia. Nunca lança: falha só é registrada (o pedido responde igual de qualquer forma). */
export async function enviarRecuperacaoDeSenha(
  conta: { userId: string; email: string },
  deps: Partial<DependenciasDaRecuperacao> = {},
): Promise<ResultadoDoEnvio> {
  try {
    const base = (deps.base ?? process.env.NEXTAUTH_URL)?.trim().replace(/\/+$/, "");
    const url = base ? new URL(base) : null;
    if (!base || !url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      audit("email_failed", { userId: conta.userId, detail: "recuperar_senha configuracao" });
      return { ok: false, motivo: "configuracao" };
    }
    const token = await emitirTokenDeAtivacao(conta.userId, deps.redis ?? getRedis());
    const r = await (deps.enviar ?? enviarEmail)(mensagemDeRecuperacao(conta.email, base, token));
    audit(r.ok ? "email_sent" : "email_failed", { userId: conta.userId, detail: `recuperar_senha${r.ok ? (r.simulado ? " simulado" : "") : ` ${r.motivo}`}` });
    return r;
  } catch {
    audit("email_failed", { userId: conta.userId, detail: "recuperar_senha erro" });
    return { ok: false, motivo: "rede" };
  }
}
