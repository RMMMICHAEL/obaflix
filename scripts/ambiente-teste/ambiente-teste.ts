/**
 * Operações do banco e do Redis do AMBIENTE ISOLADO DE TESTES.
 *
 * Nunca imprime segredo: só provedor, nome do banco, contagens e o id do
 * marcador. As credenciais vêm de um arquivo local fora do repositório
 * (`OBAFLIX_TESTE_ENV_FILE`), com as variáveis `OBAFLIX_TESTE_*`.
 *
 *   npx tsx scripts/ambiente-teste/ambiente-teste.ts inspecionar
 *   npx tsx scripts/ambiente-teste/ambiente-teste.ts redis-vazio
 *   npx tsx scripts/ambiente-teste/ambiente-teste.ts marcar --ambiente-id=<uuid>
 *   npx tsx scripts/ambiente-teste/ambiente-teste.ts verificar --ambiente-id=<uuid>
 *
 * `marcar` recusa banco com usuários. `verificar` recusa banco sem marcador,
 * com id diferente, com pedido PAGO de provedor real ou com usuário fora do
 * domínio fictício. Qualquer recusa sai com código diferente de zero.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const DOMINIO_FICTICIO = "@teste.obaflix.invalid";

function lerVariaveis(): Record<string, string> {
  const caminho = process.env.OBAFLIX_TESTE_ENV_FILE;
  if (!caminho) throw new Error("Defina OBAFLIX_TESTE_ENV_FILE com o arquivo das variaveis OBAFLIX_TESTE_*");
  const vars: Record<string, string> = {};
  for (const linha of readFileSync(caminho, "utf8").split(/\r?\n/)) {
    const i = linha.indexOf("=");
    if (i <= 0) continue;
    vars[linha.slice(0, i).trim()] = linha.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return vars;
}

function argumento(nome: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${nome}=`))?.split("=")[1];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recusar(motivo: string): never {
  console.error(`RECUSADO: ${motivo}`);
  process.exit(3);
}

async function comBanco<T>(vars: Record<string, string>, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const url = vars.OBAFLIX_TESTE_DATABASE_URL_UNPOOLED || vars.OBAFLIX_TESTE_DATABASE_URL;
  if (!url) recusar("sem OBAFLIX_TESTE_DATABASE_URL");
  const host = new URL(url).hostname;
  // O banco de teste é Neon. Qualquer outro provedor aqui é sinal de URL trocada.
  if (!host.endsWith(".neon.tech")) recusar(`host nao e do Neon de teste (${host.split(".").slice(-2).join(".")})`);
  const db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
  try { return await fn(db); } finally { await db.$disconnect(); }
}

async function tabelaExiste(db: PrismaClient, nome: string): Promise<boolean> {
  const r = await db.$queryRawUnsafe<{ existe: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS existe`, nome);
  return r[0]?.existe === true;
}

async function inspecionar(vars: Record<string, string>) {
  await comBanco(vars, async (db) => {
    const [info] = await db.$queryRawUnsafe<{ banco: string; versao: string; tabelas: bigint }[]>(
      `SELECT current_database() AS banco, split_part(version(), ' ', 2) AS versao,
              (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') AS tabelas`);
    const marcador = await tabelaExiste(db, "_ObaflixAmbiente");
    const usuarios = (await tabelaExiste(db, "User"))
      ? Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "User"`))[0].n)
      : null;
    console.log(JSON.stringify({ provedor: "neon", banco: info.banco, postgres: info.versao, tabelasPublic: Number(info.tabelas), marcador, usuarios }));
  });
}

async function redisVazio(vars: Record<string, string>) {
  const url = vars.OBAFLIX_TESTE_KV_REST_API_URL;
  const token = vars.OBAFLIX_TESTE_KV_REST_API_TOKEN;
  if (!url || !token) recusar("sem OBAFLIX_TESTE_KV_REST_API_URL/TOKEN");
  if (!new URL(url).hostname.endsWith(".upstash.io")) recusar("host de Redis nao e Upstash");
  const r = await fetch(`${url}/dbsize`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) recusar(`Redis respondeu ${r.status}`);
  const { result } = (await r.json()) as { result: number };
  console.log(JSON.stringify({ provedor: "upstash", chaves: result }));
  if (result !== 0) recusar("Redis de teste nao esta vazio: pode nao ser o recurso novo");
}

async function marcar(vars: Record<string, string>) {
  const id = argumento("ambiente-id");
  if (!id || !UUID.test(id)) recusar("--ambiente-id=<uuid> obrigatorio");
  await comBanco(vars, async (db) => {
    if (await tabelaExiste(db, "User")) {
      const n = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "User"`))[0].n);
      if (n > 0) recusar("banco com usuarios: nao parece o banco novo de testes");
    }
    if (await tabelaExiste(db, "_ObaflixAmbiente")) recusar("marcador ja existe; use verificar");
    await db.$transaction([
      db.$executeRawUnsafe(`CREATE TABLE "_ObaflixAmbiente" ("id" UUID PRIMARY KEY, "ambiente" TEXT NOT NULL CHECK ("ambiente" = 'teste'), "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT now())`),
      db.$executeRawUnsafe(`CREATE UNIQUE INDEX "_ObaflixAmbiente_unico" ON "_ObaflixAmbiente" ((true))`),
      db.$executeRawUnsafe(`INSERT INTO "_ObaflixAmbiente" ("id", "ambiente") VALUES ($1::uuid, 'teste')`, id),
      db.$executeRawUnsafe(`ALTER TABLE "_ObaflixAmbiente" ENABLE ROW LEVEL SECURITY`),
    ]);
    console.log(JSON.stringify({ marcador: "gravado", ambienteId: id }));
  });
}

async function verificar(vars: Record<string, string>) {
  const id = argumento("ambiente-id");
  if (!id || !UUID.test(id)) recusar("--ambiente-id=<uuid> obrigatorio");
  await comBanco(vars, async (db) => {
    if (!(await tabelaExiste(db, "_ObaflixAmbiente"))) recusar("sem marcador _ObaflixAmbiente: NAO e o banco de testes");
    const linhas = await db.$queryRawUnsafe<{ id: string; ambiente: string }[]>(`SELECT "id"::text AS id, "ambiente" FROM "_ObaflixAmbiente"`);
    if (linhas.length !== 1 || linhas[0].id !== id || linhas[0].ambiente !== "teste") recusar("id do marcador diferente do autorizado");
    if (await tabelaExiste(db, "PedidoPagamento")) {
      const pagos = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "PedidoPagamento" WHERE "status" = 'PAGO' AND "provedor" <> 'simulado'`))[0].n);
      if (pagos > 0) recusar("ha pedido PAGO de provedor real");
    }
    let usuarios = 0;
    if (await tabelaExiste(db, "User")) {
      const fora = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "User" WHERE "email" NOT LIKE $1`, `%${DOMINIO_FICTICIO}`))[0].n);
      if (fora > 0) recusar("ha usuario fora do dominio ficticio");
      usuarios = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "User"`))[0].n);
    }
    const [info] = await db.$queryRawUnsafe<{ banco: string; tabelas: bigint }[]>(
      `SELECT current_database() AS banco, (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') AS tabelas`);
    console.log(JSON.stringify({ verificacao: "ok", ambienteId: id, banco: info.banco, tabelasPublic: Number(info.tabelas), usuarios }));
  });
}

/** Planos, preços ativos e adicionais do banco de teste. Sem segredo nem dado de usuário. */
async function catalogo(vars: Record<string, string>) {
  await comBanco(vars, async (db) => {
    if (!(await tabelaExiste(db, "Plano"))) { console.log(JSON.stringify({ planos: null })); return; }
    const planos = await db.$queryRawUnsafe<unknown[]>(
      `SELECT "id", "nome", "ordem", "ehPadrao", "servidorVip", "resolucaoMax" FROM "Plano" ORDER BY "ordem"`);
    const precos = await db.$queryRawUnsafe<unknown[]>(
      `SELECT "planoId", "rotulo", "precoCentavos", "duracaoDias", "duracaoMeses" FROM "PlanoPreco" WHERE "ativo" ORDER BY "planoId", "ordem"`);
    const adicionais = await db.$queryRawUnsafe<unknown[]>(
      `SELECT "planoId", "tipo", "precoMensalCentavos", "ativo" FROM "PlanoAdicionalPreco" ORDER BY "planoId", "tipo"`);
    console.log(JSON.stringify({ planos, precos, adicionais }));
  });
}

const comando = process.argv[2];
const vars = lerVariaveis();
const acoes: Record<string, (v: Record<string, string>) => Promise<void>> = { inspecionar, "redis-vazio": redisVazio, marcar, verificar, catalogo };
if (!acoes[comando]) recusar(`comando desconhecido: ${comando}`);
acoes[comando](vars).catch((e) => { console.error(`ERRO: ${e instanceof Error ? e.message.split("\n")[0] : "falha"}`); process.exit(1); });
