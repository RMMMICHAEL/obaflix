export type ObaflixSurface = "public" | "admin";

export function getObaflixSurface(value = process.env.OBAFLIX_SURFACE): ObaflixSurface {
  return value === "admin" ? "admin" : "public";
}

/**
 * Cutover do admin público. `PUBLIC_CUTOVER_ATIVO` é o nome oficial;
 * `OBAFLIX_PUBLIC_ADMIN_CUTOVER` (fase 1) continua aceito para não mudar o
 * comportamento de um deploy que já a tenha. Ausente ou qualquer outro valor
 * → desligado: o padrão nunca ativa o cutover sozinho.
 */
export function publicCutoverEnabled(
  value = process.env.PUBLIC_CUTOVER_ATIVO ?? process.env.OBAFLIX_PUBLIC_ADMIN_CUTOVER,
): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true";
}

export function isLegacyAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/") || pathname === "/api/admin" || pathname.startsWith("/api/admin/");
}

export function isAllowedOnAdminSurface(pathname: string): boolean {
  // Cadastro público não existe no painel: só contas admin já existentes entram.
  if (pathname === "/api/auth/cadastro" || pathname.startsWith("/api/auth/cadastro/")) return false;
  return pathname === "/"
    || pathname === "/login"
    || pathname === "/admin"
    || pathname.startsWith("/admin/")
    || pathname === "/api/auth"
    || pathname.startsWith("/api/auth/")
    || pathname === "/api/admin"
    || pathname.startsWith("/api/admin/")
    || pathname === "/api/integracoes"
    || pathname.startsWith("/api/integracoes/")
    || pathname.startsWith("/_next/")
    || pathname === "/favicon.ico"
    || pathname === "/robots.txt";
}

export function canRoleSignInToSurface(role: string, surface: ObaflixSurface): boolean {
  return surface === "public" || role === "admin";
}

export type SurfaceGate = "nao_encontrado" | "painel" | "segue";

/**
 * Decisão de roteamento por superfície, sem efeitos: o middleware só executa.
 *
 * - admin: fora da lista permitida é 404; `/` leva ao painel.
 * - public: só muda algo com o cutover ligado, e então `/admin` e
 *   `/api/admin/*` passam a 404. Desligado (padrão), nada muda.
 */
export function decideSurfaceGate(pathname: string, surface: ObaflixSurface, cutover: boolean): SurfaceGate {
  if (surface === "admin") {
    if (!isAllowedOnAdminSurface(pathname)) return "nao_encontrado";
    return pathname === "/" ? "painel" : "segue";
  }
  return cutover && isLegacyAdminPath(pathname) ? "nao_encontrado" : "segue";
}
