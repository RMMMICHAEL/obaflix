export type NomeIcone = "home" | "search" | "film" | "tv" | "sparkles" | "smile" | "radio";

export interface AndroidNavItem {
  href: string;
  label: string;
  icone: NomeIcone;
}

/**
 * A sexta aba de busca é uma decisão nova, separada da recuperação histórica.
 *
 * Canais entra como sétima, sem tirar nenhuma das existentes. A barra fica
 * densa nessa contagem — numa tela de 360 dp cada alvo cai para perto de 51 dp,
 * ainda acima do mínimo de 48 dp, mas sem folga. Se entrar uma oitava aba, a
 * decisão deixa de ser "onde encaixar" e passa a ser "o que sai".
 */
export const ANDROID_NAV_ITEMS: readonly AndroidNavItem[] = [
  { href: "/android", label: "Início", icone: "home" },
  { href: "/buscar", label: "Buscar", icone: "search" },
  { href: "/series", label: "Séries", icone: "tv" },
  { href: "/filmes", label: "Filmes", icone: "film" },
  { href: "/canais", label: "Canais", icone: "radio" },
  { href: "/animes", label: "Animes", icone: "sparkles" },
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
