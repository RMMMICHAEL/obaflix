import { canRoleSignInToSurface, type ObaflixSurface } from "@/config/obaflix-surface";

/** Motivo (só um código, nunca dado pessoal) pelo qual o login Google foi recusado. */
export type MotivoRecusaGoogle =
  | "sem_email"
  | "email_nao_verificado"
  | "sem_identidade_google"
  | "titularidade_nao_confiavel"
  | "conflito_de_conta"
  | "papel_nao_autorizado";

export interface PerfilGoogle {
  /** `sub` do Google: identidade estável, nunca muda nem é reaproveitada. */
  sub: string;
  email: string;
  emailVerificado: boolean;
  nome?: string | null;
  foto?: string | null;
  /** `hd` presente = conta Google Workspace: o e-mail é controlado pelo administrador do domínio, não pelo Google. */
  dominioGerenciado: boolean;
}

export interface UsuarioGoogle {
  id: string;
  email: string;
  nome: string | null;
  avatar: string | null;
  role: string;
  googleSub: string | null;
}

/** A porta do banco (Prisma em produção, em memória nos testes). `User.email` e `User.googleSub` são únicos no banco. */
export interface RepoUsuarios {
  porGoogleSub(sub: string): Promise<UsuarioGoogle | null>;
  porEmail(email: string): Promise<UsuarioGoogle | null>;
  /** Pode lançar `{ code: "P2002" }` se outro pedido criou o mesmo e-mail ou `sub` no meio tempo. */
  criar(dados: { email: string; nome: string | null; avatar: string | null; googleSub: string }): Promise<UsuarioGoogle>;
  /** Grava o `sub` só se a conta ainda não tiver um (atômico). */
  vincularSub(id: string, sub: string): Promise<boolean>;
}

export type ResultadoGoogle =
  | { ok: true; usuario: UsuarioGoogle; acao: "entrou" | "criada" | "vinculada" }
  | { ok: false; motivo: MotivoRecusaGoogle };

const negar = (motivo: MotivoRecusaGoogle): ResultadoGoogle => ({ ok: false, motivo });
const unico = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

export function normalizarEmail(valor: unknown): string {
  return typeof valor === "string" ? valor.normalize("NFKC").toLowerCase().trim() : "";
}

function textoCurto(valor: unknown, max: number): string | null {
  return typeof valor === "string" && valor.trim() ? valor.trim().slice(0, max) : null;
}

function fotoHttps(valor: unknown): string | null {
  return typeof valor === "string" && valor.startsWith("https://") && valor.length <= 500 ? valor : null;
}

/**
 * Login e cadastro em um botão. A identidade é o `sub` do Google; o e-mail só serve para ENCONTRAR uma conta antiga.
 *
 *  - já vinculada a este `sub` → entra (mesmo se o e-mail mudou);
 *  - e-mail de conta existente → vincula o `sub` (uma vez, atômico) mantendo `userId`, assinatura, favoritos e histórico;
 *    nunca vincula quando o e-mail é de domínio gerenciado (Workspace) nem quando a conta já pertence a outro `sub`;
 *  - nenhuma conta → cria com plano Gratuito (o padrão de quem não tem assinatura), sem senha, papel `user`.
 *
 * Exige e-mail verificado pelo Google. Corridas (dois pedidos juntos) caem na unicidade do banco e releem o resultado.
 */
export async function resolverContaGoogle(
  repo: RepoUsuarios,
  perfil: PerfilGoogle,
  superficie: ObaflixSurface,
  tentativa = 0,
): Promise<ResultadoGoogle> {
  const email = normalizarEmail(perfil.email);
  if (!email) return negar("sem_email");
  if (!perfil.emailVerificado) return negar("email_nao_verificado");
  if (typeof perfil.sub !== "string" || perfil.sub.length < 8 || perfil.sub.length > 64) return negar("sem_identidade_google");

  const porSub = await repo.porGoogleSub(perfil.sub);
  if (porSub) {
    return canRoleSignInToSurface(porSub.role, superficie)
      ? { ok: true, usuario: porSub, acao: "entrou" }
      : negar("papel_nao_autorizado");
  }

  const existente = await repo.porEmail(email);
  if (existente) {
    if (existente.googleSub && existente.googleSub !== perfil.sub) return negar("conflito_de_conta");
    if (perfil.dominioGerenciado) return negar("titularidade_nao_confiavel");
    if (!canRoleSignInToSurface(existente.role, superficie)) return negar("papel_nao_autorizado");
    if (await repo.vincularSub(existente.id, perfil.sub)) {
      return { ok: true, usuario: { ...existente, googleSub: perfil.sub }, acao: "vinculada" };
    }
    // Outro pedido vinculou primeiro: só segue se foi ESTE mesmo sub.
    const depois = await repo.porGoogleSub(perfil.sub);
    return depois && depois.id === existente.id ? { ok: true, usuario: depois, acao: "entrou" } : negar("conflito_de_conta");
  }

  // Conta nova: papel `user`. Na superfície admin ninguém novo entra.
  if (!canRoleSignInToSurface("user", superficie)) return negar("papel_nao_autorizado");
  try {
    const criada = await repo.criar({
      email,
      nome: textoCurto(perfil.nome, 80),
      avatar: fotoHttps(perfil.foto),
      googleSub: perfil.sub,
    });
    return { ok: true, usuario: criada, acao: "criada" };
  } catch (e) {
    if (!unico(e) || tentativa >= 1) throw e;
    return resolverContaGoogle(repo, perfil, superficie, tentativa + 1); // perdeu a corrida: relê e segue
  }
}

/** Registra APENAS o código do motivo (sem e-mail, id, token ou IP). */
export function registrarRecusaGoogle(motivo: MotivoRecusaGoogle): void {
  console.warn(JSON.stringify({ event: "auth_google_recusado", motivo }));
}

/** Registra APENAS o que aconteceu com uma conta aceita (entrou/criada/vinculada). */
export function registrarAceiteGoogle(acao: "entrou" | "criada" | "vinculada"): void {
  console.warn(JSON.stringify({ event: "auth_google_aceito", acao }));
}
