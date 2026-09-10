/**
 * Dados do plano padrão e domínio dos campos de texto de `Plano`/`Assinatura`.
 *
 * Módulo puro: nenhuma consulta, nenhuma rede, nenhum import de Prisma. Existe
 * para que o seed (`scripts/seed-planos.ts`) e os testes leiam a MESMA fonte —
 * um seed com os valores digitados dentro do script não teria como ser
 * verificado sem banco, e é justamente esses valores que precisam de trava.
 *
 * **Nada em runtime lê este arquivo nesta fase.** Nenhuma rota, nenhum
 * componente, nenhum player. A resolução de direitos por requisição é a fase
 * seguinte, e vai ler o banco — não esta constante.
 *
 * Os conjuntos abaixo são o espelho dos CHECK da migration
 * `20260910_planos_assinaturas`. Estando os dois no repositório, um teste
 * consegue provar que o seed não escreve um valor que o banco recusaria — que
 * é o tipo de erro que só apareceria no `npm run seed:planos` em produção.
 */

export const CANAIS_NIVEIS = ["nenhum", "gratuito", "plus", "premium"] as const;
export const RESOLUCOES = ["sd", "hd", "fhd", "4k"] as const;
export const TV_NIVEIS = ["nenhum", "limitado", "completo"] as const;
export const STATUS_ASSINATURA = ["ATIVA", "EXPIRADA", "CANCELADA", "SUSPENSA"] as const;
export const ORIGENS_ASSINATURA = ["pagamento", "cortesia", "migracao", "admin"] as const;

export type CanaisNivel = (typeof CANAIS_NIVEIS)[number];
export type Resolucao = (typeof RESOLUCOES)[number];
export type TvNivel = (typeof TV_NIVEIS)[number];

/** Os direitos de um plano, como o banco os guarda. */
export interface DireitosDoPlano {
  anunciosObrigatorios: boolean;
  episodiosPorAnuncio: number | null;
  janelaAnuncioHoras: number;
  filmes: boolean;
  series: boolean;
  canaisNivel: CanaisNivel;
  downloads: boolean;
  telasMax: number;
  perfisMax: number;
  resolucaoMax: Resolucao;
  tvNivel: TvNivel;
}

export interface PlanoSemeado extends DireitosDoPlano {
  id: string;
  nome: string;
  descricao: string;
  ordem: number;
  ativo: boolean;
  ehPadrao: boolean;
}

/**
 * O limite de streams simultâneos que vale hoje, em `MAX_CONCURRENT` de
 * `src/lib/playTokens.ts`.
 *
 * Duplicado aqui de propósito, e não importado: `playTokens.ts` não exporta a
 * constante, e exportá-la seria mexer num arquivo que esta fase não pode tocar.
 * A cópia tem um teste que a compara com o valor real, então divergir quebra o
 * CI em vez de virar surpresa quando a autorização for ligada.
 */
export const TELAS_SIMULTANEAS_HOJE = 5;

/**
 * O plano de quem não tem assinatura ativa.
 *
 * **Estes valores são uma fotografia do comportamento atual do Obaflix, não a
 * matriz comercial.** Hoje toda conta autenticada tem acesso integral, sem
 * anúncio, com download, em qualquer resolução, na TV inteira, limitada apenas
 * a 5 streams simultâneos. É isso que está escrito abaixo, campo a campo.
 *
 * A razão é a regra da Fase 1: a migration não pode mudar o comportamento de
 * ninguém. Restringir o gratuito — ligar anúncio, cortar download, baixar
 * `telasMax` — é a edição desta linha no banco, depois, quando a decisão
 * comercial estiver tomada e a camada de autorização existir. Não é um deploy,
 * e não é aqui.
 */
export const PLANO_GRATUITO: PlanoSemeado = {
  id: "gratuito",
  nome: "Gratuito",
  descricao: "Plano padrão de quem não tem assinatura ativa.",
  ordem: 0,
  ativo: true,
  ehPadrao: true,

  // Hoje ninguém vê anúncio. Ligar isto é decisão comercial, não migration.
  anunciosObrigatorios: false,
  // Sem anúncio, não há o que contar.
  episodiosPorAnuncio: null,
  // Irrelevante enquanto `anunciosObrigatorios` for false; fica no default do
  // banco para não parecer que 24 h significa alguma coisa hoje.
  janelaAnuncioHoras: 24,

  filmes: true,
  series: true,

  // Canais ainda não existem no produto. "nenhum" não tira nada de ninguém.
  canaisNivel: "nenhum",

  // Electron e Android já baixam hoje.
  downloads: true,

  // Precisa bater com MAX_CONCURRENT. Semear 1 faria toda conta cair de 5 para
  // 1 stream no dia em que a autorização passar a ler este campo.
  telasMax: TELAS_SIMULTANEAS_HOJE,

  // Perfis não existem no schema.
  perfisMax: 1,

  // Não há limitação de resolução hoje.
  resolucaoMax: "4k",

  // A TV é integral hoje.
  tvNivel: "completo",
};

/**
 * Monta o `upsert` do seed.
 *
 * Existe separado do script por um motivo: o erro clássico de seed é o `update`
 * cobrir menos campos que o `create`. A linha nasce certa, alguém edita uma
 * coluna à mão, o seed roda de novo e não conserta — e a diferença só aparece
 * quando o campo esquecido passa a decidir alguma coisa. Derivando os dois do
 * mesmo objeto, isso não tem como acontecer, e o teste prova que continua assim.
 */
export function dadosDoUpsert(plano: PlanoSemeado) {
  const { id, ...campos } = plano;
  return { where: { id }, create: { id, ...campos }, update: campos };
}
