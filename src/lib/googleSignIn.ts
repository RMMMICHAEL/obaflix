import { canRoleSignInToSurface, type ObaflixSurface } from "@/config/obaflix-surface";

/** Motivo (só um código, nunca dado pessoal) pelo qual o login Google foi recusado. */
export type MotivoRecusaGoogle = "sem_email" | "email_nao_verificado" | "sem_conta_obaflix" | "papel_nao_autorizado";

export type DecisaoGoogle = { ok: true } | { ok: false; motivo: MotivoRecusaGoogle };

/**
 * A regra de `callbacks.signIn` para o Google, sem efeitos: o Obaflix só vincula uma conta que JÁ existe, com e-mail
 * verificado pelo Google; login nunca cria nem altera conta. `localRole` é o papel da conta encontrada pelo e-mail
 * (null = não existe). A ordem das checagens é a de sempre.
 */
export function decidirLoginGoogle(entrada: {
  email: string;
  emailVerificadoPeloGoogle: boolean;
  localRole: string | null;
  superficie: ObaflixSurface;
}): DecisaoGoogle {
  if (!entrada.email) return { ok: false, motivo: "sem_email" };
  if (!entrada.emailVerificadoPeloGoogle) return { ok: false, motivo: "email_nao_verificado" };
  if (entrada.localRole === null) return { ok: false, motivo: "sem_conta_obaflix" };
  if (!canRoleSignInToSurface(entrada.localRole, entrada.superficie)) return { ok: false, motivo: "papel_nao_autorizado" };
  return { ok: true };
}

/** Registra APENAS o código do motivo (sem e-mail, id, token ou IP) para o diagnóstico de recusas. */
export function registrarRecusaGoogle(motivo: MotivoRecusaGoogle): void {
  console.warn(JSON.stringify({ event: "auth_google_recusado", motivo }));
}
