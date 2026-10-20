/**
 * Envio de e-mail transacional. Um ponto só, com dois modos:
 *
 *   - **simulado** (padrão): nada sai da máquina. Qualquer valor de `EMAIL_MODO`
 *     diferente de "resend" cai aqui — esquecer a variável nunca envia de verdade;
 *   - **resend**: `POST https://api.resend.com/emails`, com `RESEND_API_KEY` e
 *     `EMAIL_FROM` (domínio verificado no Resend).
 *
 * Nunca lança: falha vira `ok: false`. Quem chama decide, e e-mail que falha
 * nunca desfaz pagamento. Destinatário e conteúdo (que pode levar link de uso
 * único) não vão para log.
 */
export interface MensagemDeEmail {
  para: string;
  assunto: string;
  texto: string;
  html: string;
}

export type ResultadoDoEnvio =
  | { ok: true; simulado: boolean }
  | { ok: false; motivo: "configuracao" | "rede" | "recusado" };

type Ambiente = Record<string, string | undefined>;

export async function enviarEmail(
  m: MensagemDeEmail,
  env: Ambiente = process.env,
  buscar: typeof fetch = fetch,
): Promise<ResultadoDoEnvio> {
  if (env.EMAIL_MODO !== "resend") return { ok: true, simulado: true };
  const chave = env.RESEND_API_KEY?.trim();
  const de = env.EMAIL_FROM?.trim();
  if (!chave || !de) return { ok: false, motivo: "configuracao" };
  try {
    const r = await buscar("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: de, to: [m.para], subject: m.assunto, text: m.texto, html: m.html }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? { ok: true, simulado: false } : { ok: false, motivo: "recusado" };
  } catch {
    return { ok: false, motivo: "rede" };
  }
}
