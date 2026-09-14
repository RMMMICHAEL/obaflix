/**
 * Verificação estrutural do banco do AMBIENTE ISOLADO DE TESTES.
 *
 * Confere o que a migration 20260913, as tabelas de revisão e o provedor
 * simulado deveriam ter criado. Não imprime segredo nem dado de usuário.
 *
 *   OBAFLIX_TESTE_ENV_FILE=<arquivo> npx tsx scripts/ambiente-teste/verificar-schema.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const caminho = process.env.OBAFLIX_TESTE_ENV_FILE;
if (!caminho) { console.error("Defina OBAFLIX_TESTE_ENV_FILE"); process.exit(3); }
const vars = Object.fromEntries(
  readFileSync(caminho, "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")];
  }),
);
const url = vars.OBAFLIX_TESTE_DATABASE_URL_UNPOOLED || vars.OBAFLIX_TESTE_DATABASE_URL;
if (!url || !new URL(url).hostname.endsWith(".neon.tech")) { console.error("RECUSADO: URL nao e do Neon de teste"); process.exit(3); }

const db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });

async function contar(sql: string, ...p: unknown[]): Promise<number> {
  const r = await db.$queryRawUnsafe<{ n: bigint }[]>(sql, ...p);
  return Number(r[0]?.n ?? 0);
}
async function checks(tabela: string): Promise<string[]> {
  const r = await db.$queryRawUnsafe<{ conname: string }[]>(
    `SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = $1 AND c.contype = 'c' ORDER BY conname`, tabela);
  return r.map((x) => x.conname);
}
async function definicao(constraint: string): Promise<string> {
  const r = await db.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`, constraint);
  return r[0]?.d ?? "";
}

async function main() {
  const resultado: Record<string, unknown> = {};
  const falhas: string[] = [];
  const exigir = (nome: string, ok: boolean) => { resultado[nome] = ok; if (!ok) falhas.push(nome); };

  exigir("marcador", (await contar(`SELECT count(*) AS n FROM "_ObaflixAmbiente" WHERE "ambiente" = 'teste'`)) === 1);

  // 20260913
  const colunas = await db.$queryRawUnsafe<{ tabela: string; coluna: string; nulavel: string }[]>(
    `SELECT table_name AS tabela, column_name AS coluna, is_nullable AS nulavel FROM information_schema.columns
     WHERE table_schema = 'public' AND (table_name, column_name) IN (
       ('Plano','servidorVip'), ('PlanoPreco','duracaoMeses'), ('PlanoPreco','duracaoDias'),
       ('Assinatura','telasAdicionais'), ('Assinatura','servidorVip'),
       ('PedidoPagamento','duracaoMeses'), ('PedidoPagamento','duracaoDias'), ('PedidoPagamento','telasAdicionais'),
       ('PedidoPagamento','servidorVip'), ('PedidoPagamento','valorPlanoCentavos'), ('PedidoPagamento','valorAdicionaisCentavos'),
       ('PedidoPagamento','creditoCentavos'), ('PedidoPagamento','operacao'), ('PedidoPagamento','assinaturasSubstituidas'))`);
  exigir("20260913_colunas_14", colunas.length === 14);
  exigir("20260913_duracaoDias_nulavel", colunas.filter((c) => c.coluna === "duracaoDias" && c.nulavel === "YES").length === 2);
  const checksPedido = await checks("PedidoPagamento");
  for (const c of ["PedidoPagamento_valores_check", "PedidoPagamento_operacao_check", "PedidoPagamento_adicionais_check", "PedidoPagamento_composicao_check", "PedidoPagamento_credito_check", "PedidoPagamento_provedor_check", "PedidoPagamento_status_check"]) {
    exigir(`check_${c}`, checksPedido.includes(c));
  }
  exigir("check_PlanoPreco_duracao_check", (await checks("PlanoPreco")).includes("PlanoPreco_duracao_check"));
  exigir("check_Assinatura_telasAdicionais_check", (await checks("Assinatura")).includes("Assinatura_telasAdicionais_check"));
  exigir("indice_parcial_adicionais", (await contar(`SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'PlanoAdicionalPreco_ativo_unico_idx' AND indexdef ILIKE '%WHERE%ativo%'`)) === 1);

  // Revisão manual
  exigir("revisao_tabelas", (await contar(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('RevisaoPagamento','RevisaoPagamentoEvento')`)) === 2);
  exigir("revisao_indice_parcial_pendente", (await contar(`SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'RevisaoPagamento_pendente_unico_idx' AND indexdef ILIKE '%PENDENTE%'`)) === 1);
  exigir("revisao_chave_idempotencia_unica", (await contar(`SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'RevisaoPagamentoEvento_chaveIdempotencia_key' AND indexdef ILIKE '%UNIQUE%'`)) === 1);
  exigir("revisao_trigger_imutavel", (await contar(`SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'RevisaoPagamentoEvento_imutavel' AND NOT tgisinternal`)) === 1);
  exigir("revisao_checks_3", (await checks("RevisaoPagamento")).length === 3);

  // RLS nas tabelas de dinheiro, direito e revisão
  const semRls = await db.$queryRawUnsafe<{ relname: string }[]>(
    `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
       AND relname IN ('Plano','PlanoPreco','PlanoAdicionalPreco','Assinatura','PedidoPagamento','EventoPagamento','RevisaoPagamento','RevisaoPagamentoEvento','TvDevice','TvRefreshToken','User','_ObaflixAmbiente')
       AND NOT relrowsecurity`);
  exigir("rls_ligado", semRls.length === 0);
  if (semRls.length) resultado.rls_desligado_em = semRls.map((r) => r.relname);

  resultado.provedor_check = await definicao("PedidoPagamento_provedor_check");
  resultado.tabelasPublic = await contar(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'`);

  console.log(JSON.stringify(resultado, null, 1));
  if (falhas.length) { console.error(`FALHAS: ${falhas.join(", ")}`); process.exit(4); }
}

main().catch((e) => { console.error(`ERRO: ${e instanceof Error ? e.message.split("\n")[0] : "falha"}`); process.exit(1); }).finally(() => db.$disconnect());
