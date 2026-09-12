export type NomeIcone = "home" | "search" | "film" | "tv" | "sparkles" | "shuriken" | "smile" | "radio";

export interface AndroidNavItem {
  href: string;
  label: string;
  icone: NomeIcone;
}

/**
 * Seis abas, numa linha só.
 *
 * A busca saiu da barra porque já vive na topbar (a lupa, ver
 * `mostrarBuscaNaTopbar`). Com seis alvos, numa tela de 360 dp cada um fica
 * perto de 58 dp, acima do mínimo de 48 dp. Se entrar uma sétima aba, a decisão
 * deixa de ser "onde encaixar" e passa a ser "o que sai".
 */
export const ANDROID_NAV_ITEMS: readonly AndroidNavItem[] = [
  { href: "/android", label: "Início", icone: "home" },
  { href: "/series", label: "Séries", icone: "tv" },
  { href: "/filmes", label: "Filmes", icone: "film" },
  { href: "/canais", label: "Canais", icone: "radio" },
  { href: "/animes", label: "Animes", icone: "shuriken" },
  { href: "/desenhos", label: "Kids", icone: "smile" },
];

export const ROTA_BUSCA = "/buscar";
export const ROTA_CONTA = "/conta";

export function abaAtiva(pathname: string, href: string): boolean {
  if (href === "/android") return pathname === "/android";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function ehRotaDeBusca(pathname: string): boolean {
  return pathname === ROTA_BUSCA || pathname.startsWith(`${ROTA_BUSCA}/`);
}

export function mostrarBuscaNaTopbar(pathname: string): boolean {
  return !ehRotaDeBusca(pathname);
}

export function rotaDeBusca(termo: string): string | null {
  const limpo = termo.trim();
  return limpo ? `${ROTA_BUSCA}?q=${encodeURIComponent(limpo)}` : null;
}
