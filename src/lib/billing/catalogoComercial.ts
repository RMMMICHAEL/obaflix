/**
 * Preparação do catálogo comercial no banco: preços por duração, preços dos
 * adicionais e ajustes de plano. Módulo puro — quem grava é
 * `scripts/precos-planos.ts`, em dry-run por padrão.
 *
 * ## Bootstrap, não segunda tabela
 *
 * Em runtime, preço vem só de `PlanoPreco`/`PlanoAdicionalPreco` e benefício só
 * de `Plano` (`vitrine.ts`). Os valores abaixo existem para **criar** as linhas
 * que faltam; depois de gravadas, o banco é a fonte de verdade e nenhuma rota lê
 * este arquivo.
 *
 * ## Depende da migration 20260913_duracoes_adicionais_vip
 *
 * Meses, adicionais e `Plano.servidorVip` só existem depois dela. O script não
 * roda contra um banco sem essas colunas — e não deve rodar contra o banco
 * compartilhado de Preview/Production sem autorização.
 */

export const MOEDA = "BRL";

export type DuracaoDoPreco = { tipo: "dias"; dias: number } | { tipo: "meses"; meses: number };

export interface PrecoDoCatalogo {
  planoId: string;
  duracao: DuracaoDoPreco;
  rotulo: string;
  precoCentavos: number;
  ordem: number;
}

/** Total do período, sem adicionais e sem desconto. */
export const PRECOS_DE_PLANO: readonly PrecoDoCatalogo[] = [
  { planoId: "basic", duracao: { tipo: "dias", dias: 30 }, rotulo: "30 dias", precoCentavos: 1000, ordem: 0 },
  { planoId: "basic", duracao: { tipo: "meses", meses: 5 }, rotulo: "5 meses", precoCentavos: 4490, ordem: 1 },
  { planoId: "basic", duracao: { tipo: "meses", meses: 12 }, rotulo: "1 ano", precoCentavos: 9590, ordem: 2 },
  { planoId: "plus", duracao: { tipo: "dias", dias: 30 }, rotulo: "30 dias", precoCentavos: 1990, ordem: 0 },
  { planoId: "plus", duracao: { tipo: "meses", meses: 5 }, rotulo: "5 meses", precoCentavos: 8990, ordem: 1 },
  { planoId: "plus", duracao: { tipo: "meses", meses: 12 }, rotulo: "1 ano", precoCentavos: 18990, ordem: 2 },
  { planoId: "premium", duracao: { tipo: "dias", dias: 30 }, rotulo: "30 dias", precoCentavos: 2990, ordem: 0 },
  { planoId: "premium", duracao: { tipo: "meses", meses: 5 }, rotulo: "5 meses", precoCentavos: 13490, ordem: 1 },
  { planoId: "premium", duracao: { tipo: "meses", meses: 12 }, rotulo: "1 ano", precoCentavos: 28490, ordem: 2 },
];

export interface AdicionalDoCatalogo {
  planoId: string;
  tipo: "tela" | "servidor_vip";
  precoMensalCentavos: number;
  /** VIP avulso nasce inativo: fora da oferta até o direito ser liberado. */
  ativo: boolean;
}

export const PRECOS_DE_ADICIONAIS: readonly AdicionalDoCatalogo[] = [
  { planoId: "basic", tipo: "tela", precoMensalCentavos: 1000, ativo: true },
  { planoId: "plus", tipo: "tela", precoMensalCentavos: 995, ativo: true },
  { planoId: "premium", tipo: "tela", precoMensalCentavos: 1495, ativo: true },
  { planoId: "basic", tipo: "servidor_vip", precoMensalCentavos: 590, ativo: false },
];

export type CampoAjustavel = "nome" | "resolucaoMax" | "servidorVip";

/** Ajustes de dados em `Plano`. Nenhum exige migration além da 20260913. */
export const AJUSTES_DE_PLANO: readonly { planoId: string; campo: CampoAjustavel; valor: string | boolean }[] = [
  { planoId: "basic", campo: "nome", valor: "Básico" },
  { planoId: "plus", campo: "resolucaoMax", valor: "fhd" },
  { planoId: "plus", campo: "servidorVip", valor: true },
  { planoId: "premium", campo: "servidorVip", valor: true },
];

export interface EstadoDoCatalogo {
  planos: { id: string; nome: string; resolucaoMax: string; servidorVip: boolean }[];
  precos: { planoId: string; duracaoDias: number | null; duracaoMeses: number | null; precoCentavos: number; moeda: string; ativo: boolean }[];
  adicionais: { planoId: string; tipo: string; precoMensalCentavos: number; moeda: string; ativo: boolean }[];
}

export type AcaoDoCatalogo =
  | { tipo: "criar_preco"; planoId: string; rotulo: string; duracaoDias: number | null; duracaoMeses: number | null; precoCentavos: number; moeda: string; ordem: number }
  | { tipo: "preco_ja_correto"; planoId: string; rotulo: string }
  | { tipo: "conflito_de_preco"; planoId: string; rotulo: string; existenteCentavos: number; esperadoCentavos: number }
  | { tipo: "criar_adicional"; planoId: string; adicional: "tela" | "servidor_vip"; precoMensalCentavos: number; moeda: string; ativo: boolean }
  | { tipo: "adicional_ja_existe"; planoId: string; adicional: "tela" | "servidor_vip" }
  | { tipo: "conflito_de_adicional"; planoId: string; adicional: "tela" | "servidor_vip"; existenteCentavos: number; esperadoCentavos: number }
  | { tipo: "plano_ausente"; planoId: string }
  | { tipo: "atualizar_plano"; planoId: string; campo: CampoAjustavel; de: string | boolean; para: string | boolean };

function mesmaDuracao(p: { duracaoDias: number | null; duracaoMeses: number | null }, d: DuracaoDoPreco): boolean {
  return d.tipo === "dias"
    ? p.duracaoDias === d.dias && p.duracaoMeses === null
    : p.duracaoMeses === d.meses && p.duracaoDias === null;
}

/**
 * O que precisaria mudar no banco. Não grava nada.
 *
 * Valor ativo diferente do aprovado é **conflito**, nunca sobrescrita: alguém
 * cadastrou por outro fluxo, e trocar preço em silêncio só aparece na cobrança.
 */
export function planejarCatalogo(estado: EstadoDoCatalogo): AcaoDoCatalogo[] {
  const acoes: AcaoDoCatalogo[] = [];
  const existe = (id: string) => estado.planos.some((p) => p.id === id);
  const ausentes = new Set<string>();

  for (const preco of PRECOS_DE_PLANO) {
    if (!existe(preco.planoId)) {
      if (!ausentes.has(preco.planoId)) acoes.push({ tipo: "plano_ausente", planoId: preco.planoId });
      ausentes.add(preco.planoId);
      continue;
    }
    const ativos = estado.precos.filter(
      (p) => p.planoId === preco.planoId && p.ativo && p.moeda === MOEDA && mesmaDuracao(p, preco.duracao),
    );
    if (ativos.length === 0) {
      acoes.push({
        tipo: "criar_preco", planoId: preco.planoId, rotulo: preco.rotulo,
        duracaoDias: preco.duracao.tipo === "dias" ? preco.duracao.dias : null,
        duracaoMeses: preco.duracao.tipo === "meses" ? preco.duracao.meses : null,
        precoCentavos: preco.precoCentavos, moeda: MOEDA, ordem: preco.ordem,
      });
    } else if (ativos.every((p) => p.precoCentavos === preco.precoCentavos)) {
      acoes.push({ tipo: "preco_ja_correto", planoId: preco.planoId, rotulo: preco.rotulo });
    } else {
      const diferente = ativos.find((p) => p.precoCentavos !== preco.precoCentavos)!;
      acoes.push({
        tipo: "conflito_de_preco", planoId: preco.planoId, rotulo: preco.rotulo,
        existenteCentavos: diferente.precoCentavos, esperadoCentavos: preco.precoCentavos,
      });
    }
  }

  for (const adicional of PRECOS_DE_ADICIONAIS) {
    if (!existe(adicional.planoId)) continue;
    const doTipo = estado.adicionais.filter(
      (a) => a.planoId === adicional.planoId && a.tipo === adicional.tipo && a.moeda === MOEDA,
    );
    if (doTipo.length === 0) {
      acoes.push({
        tipo: "criar_adicional", planoId: adicional.planoId, adicional: adicional.tipo,
        precoMensalCentavos: adicional.precoMensalCentavos, moeda: MOEDA, ativo: adicional.ativo,
      });
      continue;
    }
    const divergente = doTipo.find((a) => a.ativo && a.precoMensalCentavos !== adicional.precoMensalCentavos);
    if (divergente) {
      acoes.push({
        tipo: "conflito_de_adicional", planoId: adicional.planoId, adicional: adicional.tipo,
        existenteCentavos: divergente.precoMensalCentavos, esperadoCentavos: adicional.precoMensalCentavos,
      });
    } else {
      acoes.push({ tipo: "adicional_ja_existe", planoId: adicional.planoId, adicional: adicional.tipo });
    }
  }

  for (const ajuste of AJUSTES_DE_PLANO) {
    const plano = estado.planos.find((p) => p.id === ajuste.planoId);
    if (!plano) continue;
    const atual = plano[ajuste.campo];
    if (atual !== ajuste.valor) {
      acoes.push({ tipo: "atualizar_plano", planoId: ajuste.planoId, campo: ajuste.campo, de: atual, para: ajuste.valor });
    }
  }

  return acoes;
}

/** `--apply` é recusado com qualquer conflito ou plano ausente. */
export function podeAplicar(acoes: AcaoDoCatalogo[]): boolean {
  return !acoes.some((a) => a.tipo === "conflito_de_preco" || a.tipo === "conflito_de_adicional" || a.tipo === "plano_ausente");
}

/**
 * O operador digitou o host do banco que vai receber a escrita?
 *
 * Preview e Production compartilham `DATABASE_URL` hoje. Exigir o host exato em
 * `--banco=` não impede escrever em Production — impede escrever **sem saber**
 * onde.
 */
export function bancoConfirmado(databaseUrl: string | undefined, informado: string | undefined): boolean {
  if (!databaseUrl || !informado) return false;
  try {
    return new URL(databaseUrl).hostname.toLowerCase() === informado.trim().toLowerCase();
  } catch {
    return false;
  }
}
