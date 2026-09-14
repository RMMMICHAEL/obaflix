/**
 * Preparação do catálogo comercial no banco: preços de 30 dias e ajustes de
 * plano. Módulo puro — quem grava é `scripts/precos-planos.ts`, em dry-run por
 * padrão.
 *
 * ## Bootstrap, não segunda tabela
 *
 * Em runtime, preço vem só de `PlanoPreco` e benefício só de `Plano`
 * (`vitrine.ts`). Os valores abaixo existem para **criar** as linhas que
 * faltam; depois de gravadas, o banco é a fonte de verdade e este arquivo não
 * é lido por nenhuma rota.
 *
 * ## O que ainda não pode ser criado
 *
 * 5 meses e 1 ano foram aprovados como **meses de calendário**. `PlanoPreco` só
 * representa duração em dias, e converter para um número de dias seria decidir
 * por conta própria quanto vale "5 meses". Ficam em
 * `PRECOS_PENDENTES_DE_SCHEMA`, documentados e **não criáveis** até a coluna de
 * meses existir (proposta em `docs/planos-comerciais.md`).
 */

export const MOEDA = "BRL";
export const DURACAO_30_DIAS = 30;
export const ROTULO_30_DIAS = "30 dias";

export const PRECOS_DE_30_DIAS: readonly { planoId: string; precoCentavos: number }[] = [
  { planoId: "basic", precoCentavos: 1000 },
  { planoId: "plus", precoCentavos: 1990 },
  { planoId: "premium", precoCentavos: 2990 },
];

/** Aprovados. Dependem de duração em meses de calendário no schema. */
export const PRECOS_PENDENTES_DE_SCHEMA: readonly { planoId: string; meses: 5 | 12; precoCentavos: number }[] = [
  { planoId: "basic", meses: 5, precoCentavos: 4490 },
  { planoId: "basic", meses: 12, precoCentavos: 9590 },
  { planoId: "plus", meses: 5, precoCentavos: 8990 },
  { planoId: "plus", meses: 12, precoCentavos: 18990 },
  { planoId: "premium", meses: 5, precoCentavos: 13490 },
  { planoId: "premium", meses: 12, precoCentavos: 28490 },
];

/** Ajustes de dados em `Plano` para alinhar com a matriz final. Nenhum exige migration. */
export const AJUSTES_DE_PLANO: readonly { planoId: string; campo: "nome" | "resolucaoMax"; valor: string }[] = [
  { planoId: "basic", campo: "nome", valor: "Básico" },
  { planoId: "plus", campo: "resolucaoMax", valor: "fhd" },
];

export interface EstadoDoCatalogo {
  planos: { id: string; nome: string; resolucaoMax: string }[];
  precos: { planoId: string; duracaoDias: number; precoCentavos: number; moeda: string; ativo: boolean }[];
}

export type AcaoDoCatalogo =
  | { tipo: "criar_preco"; planoId: string; precoCentavos: number; duracaoDias: number; rotulo: string; moeda: string }
  | { tipo: "preco_ja_correto"; planoId: string }
  | { tipo: "conflito_de_preco"; planoId: string; existenteCentavos: number; esperadoCentavos: number }
  | { tipo: "plano_ausente"; planoId: string }
  | { tipo: "atualizar_plano"; planoId: string; campo: "nome" | "resolucaoMax"; de: string; para: string };

/**
 * O que precisaria mudar no banco. Não grava nada.
 *
 * Preço ativo de 30 dias com valor diferente é **conflito**, nunca
 * sobrescrita: alguém cadastrou por outro fluxo, e trocar preço em silêncio é o
 * tipo de erro que só aparece na cobrança.
 */
export function planejarCatalogo(estado: EstadoDoCatalogo): AcaoDoCatalogo[] {
  const acoes: AcaoDoCatalogo[] = [];

  for (const { planoId, precoCentavos } of PRECOS_DE_30_DIAS) {
    if (!estado.planos.some((p) => p.id === planoId)) {
      acoes.push({ tipo: "plano_ausente", planoId });
      continue;
    }
    const ativos = estado.precos.filter(
      (p) => p.planoId === planoId && p.ativo && p.duracaoDias === DURACAO_30_DIAS && p.moeda === MOEDA,
    );
    if (ativos.length === 0) {
      acoes.push({
        tipo: "criar_preco", planoId, precoCentavos,
        duracaoDias: DURACAO_30_DIAS, rotulo: ROTULO_30_DIAS, moeda: MOEDA,
      });
    } else if (ativos.every((p) => p.precoCentavos === precoCentavos)) {
      acoes.push({ tipo: "preco_ja_correto", planoId });
    } else {
      const diferente = ativos.find((p) => p.precoCentavos !== precoCentavos)!;
      acoes.push({
        tipo: "conflito_de_preco", planoId,
        existenteCentavos: diferente.precoCentavos, esperadoCentavos: precoCentavos,
      });
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
  return !acoes.some((a) => a.tipo === "conflito_de_preco" || a.tipo === "plano_ausente");
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
