/**
 * Dados do plano padrão e domínio dos campos de texto de `Plano`/`Assinatura`.
 *
 * Módulo puro: nenhuma consulta, nenhuma rede, nenhum import de Prisma. Existe
 * para que o seed (`scripts/seed-planos.ts`) e os testes leiam a MESMA fonte —
 * um seed com os valores digitados dentro do script não teria como ser
 * verificado sem banco, e é justamente esses valores que precisam de trava.
 *
 * **`PLANO_GRATUITO` não é lido em runtime.** Ele é o valor de partida da linha
 * do plano padrão e perde efeito no instante em que ela nasce. Quem resolve
 * direitos por usuário é `src/lib/entitlements.ts`, e ele lê o **banco**: o
 * plano padrão de runtime é a linha com `ehPadrao = true`, nunca esta constante.
 *
 * O que `entitlements.ts` aproveita daqui são os **tipos e domínios**
 * (`DireitosDoPlano`, `CANAIS_NIVEIS`, `RESOLUCOES`, `TV_NIVEIS`) — justamente
 * para não existir uma segunda definição do que é um direito válido.
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
 * `telasMax` — é a edição da **linha no banco**, depois, quando a decisão
 * comercial estiver tomada e a camada de autorização existir. Não é um deploy,
 * e não é aqui.
 *
 * Editar esta constante depois disso **não** muda produção, e é assim de
 * propósito: o seed cria se faltar e nunca sobrescreve
 * ([semearPlanoPadrao]). Esta constante é o valor de partida da linha, e para
 * de ter efeito no instante em que a linha nasce.
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

// ─────────────────────────────────────────────────────────────────────────────
// A matriz comercial — Basic, Plus, Premium
// ─────────────────────────────────────────────────────────────────────────────
//
// As três linhas compráveis do produto. Como `PLANO_GRATUITO`, são **bootstrap**:
// o seed cria se faltar e nunca sobrescreve, e a partir do instante em que a
// linha nasce o Postgres é a fonte de verdade. Editar estas constantes depois
// disso não muda produção.
//
// ## Nenhuma delas tem preço, e isso é modelado, não esquecido
//
// `PlanoPreco` não é criado aqui. Sem uma linha de preço ativa, a Fase 4 recusa
// a compra em `resolverPreco` (`preco_inexistente`), então os três planos
// existem, são consultáveis e **não são vendáveis** — que é exatamente o estado
// pedido enquanto os valores comerciais não chegam. Criar preço fictício para
// "destravar" o fluxo seria inventar número que alguém acabaria cobrando.
//
// ## O que destes direitos o backend REALMENTE aplica hoje
//
// Vale dizer com precisão, porque a diferença entre "gravado" e "aplicado" é o
// tipo de coisa que se descobre tarde:
//
//   - `filmes` / `series` — **aplicados**, em `POST /api/player/fontes`, via
//     `playbackAuthorization.ts`, atrás de `MONETIZACAO_ATIVA`;
//   - `canaisNivel` — **aplicado** pela camada de canais (`src/lib/canais/
//     acesso.ts`, consumida por `/api/canais` e `/api/canais/[id]/play`), que o
//     compara com `Canal.nivelMinimo`. Essa camada ainda não está em `main`;
//   - `telasMax` — **gravado, não aplicado**. O limite real continua sendo a
//     constante `MAX_CONCURRENT = 5` de `src/lib/playTokens.ts`. Os três planos
//     dizem 2, e nenhum deles limita nada até aquela constante ser substituída;
//   - `downloads`, `resolucaoMax`, `tvNivel`, `perfisMax` e
//     `anunciosObrigatorios` — **gravados, não aplicados**. Nenhuma rota os lê
//     para negar. O botão de download do `CustomPlayer` aparece por existir
//     ponte de desktop, não por direito.
//
// Registrar isso é deliberado: os valores abaixo são a decisão comercial e ficam
// prontos para quando o enforcement chegar, mas ninguém deve ler esta constante
// e concluir que uma conta Basic hoje não baixa.

/**
 * **Basic** — filmes e séries, sem canais e sem download.
 *
 * `canaisNivel: "nenhum"` é o que separa Basic dos outros dois, e o valor tem
 * significado forte: `nivelAlcanca` nega **antes** de qualquer comparação de
 * índice quando o nível concedido é `"nenhum"`. Uma conta Basic não alcança nem
 * um canal marcado `gratuito` — não é "o canal mais barato", é nenhum.
 */
export const PLANO_BASIC: PlanoSemeado = {
  id: "basic",
  nome: "Basic",
  descricao: "Filmes e séries, sem anúncios. Sem canais ao vivo e sem downloads.",
  ordem: 1,
  ativo: true,
  // Só `gratuito` é padrão. Quem não tem assinatura ativa continua resolvendo
  // para ele, e não para Basic — o índice único parcial do banco garante no
  // máximo um plano padrão, então marcar `true` aqui quebraria o seed.
  ehPadrao: false,

  anunciosObrigatorios: false,
  episodiosPorAnuncio: null,
  janelaAnuncioHoras: 24,

  filmes: true,
  series: true,

  canaisNivel: "nenhum",
  downloads: false,

  telasMax: 2,
  perfisMax: 1,

  resolucaoMax: "hd",
  tvNivel: "completo",
};

/**
 * **Plus** — acrescenta downloads e os canais até o nível Plus.
 *
 * `canaisNivel: "plus"` alcança canais marcados `gratuito` e `plus`, e **não**
 * alcança `premium`. A comparação é por nível, nunca por nome ou categoria do
 * canal: quem decide é `Canal.nivelMinimo`, definido pela curadoria.
 */
export const PLANO_PLUS: PlanoSemeado = {
  id: "plus",
  nome: "Plus",
  descricao: "Filmes, séries e canais até o nível Plus, com downloads.",
  ordem: 2,
  ativo: true,
  ehPadrao: false,

  anunciosObrigatorios: false,
  episodiosPorAnuncio: null,
  janelaAnuncioHoras: 24,

  filmes: true,
  series: true,

  canaisNivel: "plus",
  downloads: true,

  telasMax: 2,
  perfisMax: 1,

  resolucaoMax: "hd",
  tvNivel: "completo",
};

/**
 * **Premium** — catálogo completo de canais e a melhor qualidade disponível.
 *
 * "Catálogo completo" é `canaisNivel: "premium"`, o topo da escala: alcança
 * `gratuito`, `plus` e `premium`. **Não é um número de canais.** Quantos canais
 * existem é consequência da curadoria e do import, e fixar "2.000" numa
 * constante criaria uma promessa que o banco não sustenta.
 *
 * `resolucaoMax: "4k"` é o teto do domínio — "melhor qualidade disponível
 * conforme a fonte". Ele não força 4K onde a fonte não tem; apenas deixa de ser
 * o limitante.
 *
 * **"Servidor VIP" não está modelado, e não deve ser fingido.** Não existe hoje
 * nenhuma separação de fontes por plano no backend: `src/lib/fontes.ts` monta a
 * mesma lista para todo mundo, e o único "VIP" no código é rótulo de interface
 * (`MediaHero`) ou conceito do provedor externo em `cinevs.ts` — nenhum dos dois
 * é autorização nossa. Enquanto `Plano` não tiver uma coluna de nível de fonte e
 * `fontes.ts` não filtrar por ela, Premium recebe a mesma lista que Basic.
 * Requisito futuro, registrado em `docs/monetizacao-arquitetura.md`.
 *
 * Suporte prioritário também não é direito técnico: é processo de atendimento, e
 * não vira coluna.
 */
export const PLANO_PREMIUM: PlanoSemeado = {
  id: "premium",
  nome: "Premium",
  descricao: "Filmes, séries e o catálogo completo de canais, com downloads.",
  ordem: 3,
  ativo: true,
  ehPadrao: false,

  anunciosObrigatorios: false,
  episodiosPorAnuncio: null,
  janelaAnuncioHoras: 24,

  filmes: true,
  series: true,

  canaisNivel: "premium",
  downloads: true,

  telasMax: 2,
  perfisMax: 1,

  resolucaoMax: "4k",
  tvNivel: "completo",
};

/**
 * Os planos compráveis, na ordem da vitrine.
 *
 * `PLANO_GRATUITO` fica de fora de propósito: ele não é comprável e tem caminho
 * de seed próprio, com a garantia de plano padrão único.
 */
export const PLANOS_COMERCIAIS: readonly PlanoSemeado[] = [
  PLANO_BASIC,
  PLANO_PLUS,
  PLANO_PREMIUM,
];

/**
 * O mínimo do banco que o seed precisa. Existe para o seed ser exercitado de
 * verdade nos testes — sem Postgres e sem simular o Prisma inteiro.
 */
export interface RepositorioDePlanos {
  buscar(id: string): Promise<Record<string, unknown> | null>;
  criar(plano: PlanoSemeado): Promise<void>;
}

export type ResultadoDoSeed =
  | { acao: "criado"; plano: PlanoSemeado }
  | { acao: "mantido"; existente: Record<string, unknown> };

/**
 * Semeia o plano padrão — **cria se faltar, e nunca sobrescreve**.
 *
 * A assimetria é deliberada e é a regra que dá nome às coisas aqui:
 *
 *   `PLANO_GRATUITO` é **bootstrap**, não configuração permanente.
 *   Depois que a linha existe, o **Postgres é a fonte de verdade**.
 *
 * A versão anterior fazia `upsert` com `update` de todos os campos, e isso era
 * uma armadilha esperando a monetização entrar no ar. Um banco de produção com
 * `anunciosObrigatorios = true`, `downloads = false`, `telasMax = 1` voltaria,
 * ao primeiro `seed:planos:apply` de alguém, para a fotografia de hoje — sem
 * anúncio, com download, cinco telas. Um comando chamado "seed" teria desligado
 * a monetização e reaberto direitos, e nada no nome dele avisaria.
 *
 * O custo dessa escolha é conhecido: o seed deixa de consertar uma coluna
 * editada à mão. É o custo certo. Alteração comercial tem fluxo próprio, com
 * intenção explícita — não é efeito colateral de um bootstrap.
 *
 * Não existe `--force`, e não deve existir nesta fase: uma flag que devolve o
 * comportamento perigoso reintroduz o risco com um passo a mais, e um passo a
 * mais não é uma barreira.
 */
export async function semearPlanoPadrao(
  repo: RepositorioDePlanos,
  plano: PlanoSemeado = PLANO_GRATUITO,
): Promise<ResultadoDoSeed> {
  return semearPlano(repo, plano);
}

/**
 * O mesmo contrato, com o nome certo para um plano qualquer.
 *
 * `semearPlanoPadrao` já era genérico — recebia o plano por parâmetro — e
 * continuou existindo porque script e testes a chamam. Mas semear Premium
 * através de uma função chamada "semearPlanoPadrao" leria como se Premium
 * virasse o plano de quem não assina, que é justamente o contrário do que
 * acontece. As duas são a mesma coisa; muda só o nome que quem lê encontra.
 *
 * **Cria se faltar, nunca sobrescreve** — vale igual para os comerciais. Um
 * `seed:planos:apply` rodado depois de a matriz estar ajustada em produção não
 * pode devolver Basic para os valores deste arquivo.
 */
export async function semearPlano(
  repo: RepositorioDePlanos,
  plano: PlanoSemeado,
): Promise<ResultadoDoSeed> {
  const existente = await repo.buscar(plano.id);
  if (existente) return { acao: "mantido", existente };

  await repo.criar(plano);
  return { acao: "criado", plano };
}

/** O resultado de semear um plano, junto do plano que o originou. */
export interface ResultadoPorPlano {
  plano: PlanoSemeado;
  resultado: ResultadoDoSeed;
}

/**
 * Semeia a matriz comercial inteira, em ordem, com a mesma disciplina.
 *
 * Sequencial e não `Promise.all`: a saída do script é lida por gente, e
 * intercalar três relatórios em ordem imprevisível não ajuda ninguém. Três
 * linhas não justificam paralelismo.
 */
export async function semearPlanosComerciais(
  repo: RepositorioDePlanos,
  planos: readonly PlanoSemeado[] = PLANOS_COMERCIAIS,
): Promise<ResultadoPorPlano[]> {
  const saida: ResultadoPorPlano[] = [];
  for (const plano of planos) {
    saida.push({ plano, resultado: await semearPlano(repo, plano) });
  }
  return saida;
}

/**
 * Os direitos da linha existente que diferem da fotografia.
 *
 * Só para relatar. O seed nunca age sobre isto — e é justamente por não agir
 * que mostrar a diferença tem valor: quem roda vê o que o banco decidiu desde o
 * bootstrap, sem que o comando toque em nada.
 */
export function diferencas(
  existente: Record<string, unknown>,
  plano: PlanoSemeado = PLANO_GRATUITO,
): { campo: string; noBanco: unknown; naFotografia: unknown }[] {
  const saida: { campo: string; noBanco: unknown; naFotografia: unknown }[] = [];
  for (const [campo, naFotografia] of Object.entries(plano)) {
    if (campo === "id") continue;
    const noBanco = existente[campo];
    if (noBanco !== undefined && String(noBanco) !== String(naFotografia)) {
      saida.push({ campo, noBanco, naFotografia });
    }
  }
  return saida;
}
