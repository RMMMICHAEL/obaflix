/**
 * Navegacao do app Android.
 *
 * Vive fora do componente por dois motivos. O primeiro e que a regra de "qual
 * aba esta ativa" e a de "onde a busca aparece" sao logica, nao desenho, e
 * eram justamente elas que estavam erradas. O segundo e que o app e um
 * WebView: nao ha tela nativa para conferir isso, entao o unico lugar onde
 * essas decisoes podem ser verificadas e aqui.
 */

/** Nome do icone; o shell resolve para o componente do lucide-react. */
export type NomeIcone = "home" | "film" | "tv" | "sparkles" | "smile";

export interface AndroidNavItem {
  href: string;
  label: string;
  icone: NomeIcone;
}

/**
 * As cinco secoes do catalogo, na barra inferior.
 *
 * Animes e Kids existiam como rota, funcionavam e eram linkadas pelas
 * prateleiras da propria home — so nao tinham porta de entrada. Chegar neles
 * exigia entrar em Series e procurar Familia/Animacao.
 *
 * Para abrir as duas vagas sem espremer sete itens numa barra de telefone,
 * "Conta" subiu para a topbar (que tinha espaco sobrando ao lado da marca) e
 * "Buscar" deixou de ser aba: a lupa da topbar ja era a unica busca que
 * funcionava, e a aba levava a uma tela que nao tinha campo nenhum. Ver
 * `mostrarBuscaNaTopbar`.
 */
export const ANDROID_NAV_ITEMS: readonly AndroidNavItem[] = [
  { href: "/android", label: "Início", icone: "home" },
  { href: "/filmes", label: "Filmes", icone: "film" },
  { href: "/series", label: "Séries", icone: "tv" },
  { href: "/animes", label: "Animes", icone: "sparkles" },
  { href: "/desenhos", label: "Kids", icone: "smile" },
];

/** Rota da tela de busca. Um lugar so, para topbar e pagina concordarem. */
export const ROTA_BUSCA = "/buscar";

/** Rota da conta, agora acessivel pela topbar. */
export const ROTA_CONTA = "/conta";

/**
 * A aba ativa.
 *
 * `/android` compara exato porque e prefixo de nada mais que interesse; as
 * demais aceitam subrotas (`/serie/123` nao acende "Séries" — esse e o detalhe
 * de um titulo, nao a secao — mas `/series?genero=…` sim, porque a querystring
 * nao muda o pathname).
 */
export function abaAtiva(pathname: string, href: string): boolean {
  if (href === "/android") return pathname === "/android";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * A lupa da topbar aparece em toda tela MENOS na propria busca.
 *
 * Era daqui que vinha a impressao de duas buscas: a lupa abria um formulario
 * que funcionava, e a aba "Buscar" levava a uma tela sem campo algum. Agora ha
 * uma acao de busca so, e ela nunca se duplica — quando o usuario ja esta em
 * /buscar, quem tem o campo e a pagina.
 */
export function mostrarBuscaNaTopbar(pathname: string): boolean {
  return !ehRotaDeBusca(pathname);
}

export function ehRotaDeBusca(pathname: string): boolean {
  return pathname === ROTA_BUSCA || pathname.startsWith(`${ROTA_BUSCA}/`);
}

/**
 * Para onde uma busca leva, ou `null` quando nao ha o que buscar.
 *
 * Devolver `null` em vez de navegar para `/buscar` sem `q` e o que impede de
 * recriar a tela vazia que a aba antiga produzia.
 */
export function rotaDeBusca(termo: string): string | null {
  const limpo = termo.trim();
  if (!limpo) return null;
  return `${ROTA_BUSCA}?q=${encodeURIComponent(limpo)}`;
}
