/**
 * A projeção pública do catálogo de canais.
 *
 * Esta é a **única** camada autorizada a transformar uma linha de `Canal` em
 * algo que sai numa resposta. Toda rota de catálogo passa por aqui; nenhuma
 * monta o objeto na mão.
 *
 * ## O que nunca sai
 *
 * `CanalFonte` não é consultada aqui, e o `select` abaixo é explícito em vez de
 * `include` justamente para que acrescentar uma coluna sensível a `Canal` no
 * futuro não a publique sozinha. Não saem: provider, `providerChannelId`, URL
 * da página do player, URL de mídia, Referer, User-Agent, cookie.
 *
 * `nivelMinimo` **sai**, e é uma decisão, não um descuido: o cliente precisa
 * distinguir "canal que você pode abrir" de "canal que exige upgrade" para
 * desenhar o cadeado e a chamada de assinatura. Saber que um canal é `premium`
 * não aproxima ninguém de reproduzi-lo — quem decide é `POST /api/canais/[id]/play`,
 * no servidor, e o campo já é público na página de planos.
 */

import { prisma } from "../prisma";
import type { CanaisNivel } from "../planos";
import { nivelAlcanca } from "./acesso";

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
 * Kotlin da TV e no Kotlin do app; mudar um campo aqui é mudar três clientes.
 */
export interface ItemDeCanal {
  id: string;
  slug: string;
  nome: string;
  categoria: string;
  logoUrl: string | null;
  /** Sempre `true` nesta fase: não existe canal sob demanda no catálogo. */
  aoVivo: boolean;
  /** Nível exigido, para o cliente desenhar cadeado e chamada de upgrade. */
  nivelMinimo: string;
  /**
   * Se **esta conta** alcança o canal. Calculado no servidor a partir dos
   * entitlements — o cliente não refaz a comparação, só desenha o resultado.
   *
   * Não é autorização: é dica de interface. A autorização acontece de novo, do
   * zero, no playback grant. Um cliente adulterado que force `liberado: true`
   * ganha um card sem cadeado e um 403 ao apertar OK.
   */
  liberado: boolean;
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
  nivelMinimo: true,
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
  nivelDaConta: CanaisNivel;
}

export async function listarCanais(opcoes: OpcoesDeCatalogo): Promise<ItemDeCanal[]> {
  const { categoria, nivelDaConta } = opcoes;
  const filtraCategoria = categoria && categoria !== "todos" && ehCategoriaDeCanal(categoria);

  const linhas = await prisma.canal.findMany({
    where: {
      ...SOMENTE_PUBLICAVEIS,
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
    nivelMinimo: l.nivelMinimo,
    liberado: nivelAlcanca(nivelDaConta, l.nivelMinimo),
  }));
}

/**
 * As categorias que têm ao menos um canal publicável, na ordem do produto.
 *
 * Existe para a UI não desenhar um chip que abre numa lista vazia. `todos`
 * entra sempre que houver qualquer canal.
 */
export async function categoriasComCanais(): Promise<CategoriaDeCanal[]> {
  const grupos = await prisma.canal.groupBy({
    by: ["categoria"],
    where: SOMENTE_PUBLICAVEIS,
    _count: { _all: true },
  });
  const presentes = new Set(grupos.map((g) => g.categoria));
  if (presentes.size === 0) return [];
  return CATEGORIAS_DE_CANAL.filter((c) => c === "todos" || presentes.has(c));
}
