/**
 * A projeção pública do catálogo de canais.
 *
 * Esta é a **única** camada autorizada a transformar uma linha de `Canal` em
 * algo que sai numa resposta. Toda rota de catálogo passa por aqui; nenhuma
 * monta o objeto na mão.
 *
 * ## O cliente recebe só o que pode abrir
 *
 * O filtro por entitlement acontece **na consulta**, em `nivelMinimo IN (...)`,
 * e não em memória depois. Uma conta gratuita não recebe nem os metadados dos
 * canais premium: nem nome, nem logo, nem categoria, nem o fato de existirem.
 *
 * A versão anterior devolvia o catálogo inteiro marcando `liberado: false` no
 * que a conta não podia abrir. Funcionava como cadeado na interface e falhava
 * como regra: a lista é a superfície mais fácil de ler de todas, e "o que existe
 * no produto" vazava inteiro para qualquer conta autenticada.
 *
 * Se um dia mostrar canal bloqueado for desejado — vitrine de upgrade —, isso é
 * decisão comercial explícita e ganha um parâmetro próprio (`incluirBloqueados`)
 * com projeção própria. Não pode voltar a ser o padrão por omissão.
 *
 * ## O que nunca sai
 *
 * `CanalFonte` não é consultada aqui, e o `select` é explícito em vez de
 * `include` justamente para que acrescentar uma coluna sensível a `Canal` no
 * futuro não a publique sozinha. Não saem: provider, `providerChannelId`, URL da
 * página do player, URL de mídia, Referer, User-Agent, cookie.
 *
 * `nivelMinimo` também não sai mais. Com o filtro acima, todo canal da lista é
 * abrível por quem pediu, então o campo não tem uso na interface — e o que não
 * tem uso não viaja.
 */

import { prisma } from "../prisma";
import { niveisAlcancadosPor } from "./acesso";

/**
 * As categorias do produto, na ordem em que aparecem nos chips.
 *
 * `todos` não é uma categoria guardada no banco: é a ausência de filtro. Está
 * na lista porque a UI das três plataformas mostra o chip, e a lista é o
 * contrato compartilhado entre elas.
 *
 * Categoria **não representa permissão**. Quem representa é `nivelMinimo`.
 */
export const CATEGORIAS_DE_CANAL = [
  "todos",
  "abertos",
  "noticias",
  "esportes",
  "filmes-series",
  "infantil",
  "documentarios",
  "variedades",
  "culinaria-lifestyle",
  "24h",
  "internacionais",
] as const;

export type CategoriaDeCanal = (typeof CATEGORIAS_DE_CANAL)[number];

export const ROTULO_DA_CATEGORIA: Record<CategoriaDeCanal, string> = {
  todos: "Todos",
  abertos: "Abertos",
  noticias: "Notícias",
  esportes: "Esportes",
  "filmes-series": "Filmes & Séries",
  infantil: "Infantil",
  documentarios: "Documentários",
  variedades: "Variedades",
  "culinaria-lifestyle": "Culinária & Lifestyle",
  "24h": "24h",
  internacionais: "Internacionais",
};

export function ehCategoriaDeCanal(v: string): v is CategoriaDeCanal {
  return (CATEGORIAS_DE_CANAL as readonly string[]).includes(v);
}

/**
 * O canal como o cliente o recebe. Este tipo é copiado — não importado — no
 * Kotlin da TV; mudar um campo aqui é mudar três clientes.
 *
 * Todo canal que chega aqui é abrível por quem pediu. Não há `liberado` e não há
 * `nivelMinimo`: o que a conta não alcança não entra na lista.
 */
export interface ItemDeCanal {
  id: string;
  slug: string;
  nome: string;
  categoria: string;
  logoUrl: string | null;
  /** Sempre `true` nesta fase: não existe canal sob demanda no catálogo. */
  aoVivo: boolean;
}

/**
 * O `select` é a barreira. Explícito, sem `include`, sem spread da linha.
 */
const CAMPOS_PUBLICOS = {
  id: true,
  slug: true,
  nome: true,
  categoria: true,
  logoUrl: true,
} as const;

/**
 * O filtro que todo caminho de leitura pública compartilha.
 *
 * `adulto: false` está aqui além do CHECK da migration. Redundante de
 * propósito: o CHECK protege contra import mal feito, este filtro protege
 * contra alguém remover o CHECK numa migration futura sem perceber o que ele
 * segurava.
 */
const SOMENTE_PUBLICAVEIS = { ativo: true, adulto: false } as const;

export interface OpcoesDeCatalogo {
  /** `undefined` ou `"todos"` não filtram. */
  categoria?: string;
  /** Nível de `canaisNivel` desta conta, vindo de `entitlementsDoUsuario`. */
  nivelDaConta: string;
}

export async function listarCanais(opcoes: OpcoesDeCatalogo): Promise<ItemDeCanal[]> {
  const { categoria, nivelDaConta } = opcoes;

  const niveis = niveisAlcancadosPor(nivelDaConta);
  // Lista vazia quer dizer catálogo vazio, não catálogo inteiro. É o caso de
  // `canaisNivel = "nenhum"` e o de um nível fora do domínio — e sair aqui evita
  // que um `IN ()` mal formado vire "sem filtro" no Prisma.
  if (niveis.length === 0) return [];

  const filtraCategoria = categoria && categoria !== "todos" && ehCategoriaDeCanal(categoria);

  const linhas = await prisma.canal.findMany({
    where: {
      ...SOMENTE_PUBLICAVEIS,
      nivelMinimo: { in: niveis },
      ...(filtraCategoria ? { categoria } : {}),
    },
    select: CAMPOS_PUBLICOS,
    orderBy: [{ ordem: "asc" }, { nome: "asc" }],
  });

  return linhas.map((l) => ({
    id: l.id,
    slug: l.slug,
    nome: l.nome,
    categoria: l.categoria,
    logoUrl: l.logoUrl,
    aoVivo: true,
  }));
}

/**
 * As categorias que têm ao menos um canal **que esta conta pode abrir**.
 *
 * Recebe o nível pelo mesmo motivo de `listarCanais`: um chip "Esportes" que
 * abre vazio para a conta gratuita contaria, pela ausência, exatamente o que o
 * filtro acima esconde.
 */
export async function categoriasComCanais(nivelDaConta: string): Promise<CategoriaDeCanal[]> {
  const niveis = niveisAlcancadosPor(nivelDaConta);
  if (niveis.length === 0) return [];

  const grupos = await prisma.canal.groupBy({
    by: ["categoria"],
    where: { ...SOMENTE_PUBLICAVEIS, nivelMinimo: { in: niveis } },
    _count: { _all: true },
  });
  const presentes = new Set(grupos.map((g) => g.categoria));
  if (presentes.size === 0) return [];
  return CATEGORIAS_DE_CANAL.filter((c) => c === "todos" || presentes.has(c));
}
