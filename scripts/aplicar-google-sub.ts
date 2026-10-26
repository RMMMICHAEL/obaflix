/**
 * aplicar-google-sub.ts — aplica a migration ADITIVA `20261026120000_user_google_sub` (coluna `User.googleSub` + índice
 * único) com verificação antes e depois. Não altera nenhuma linha.
 *
 * Uso (a URL vem do ambiente, nunca da linha de comando, e nada de credencial é impresso):
 *   DIRECT_URL=<url sem pooler> npx tsx scripts/aplicar-google-sub.ts                         # só verifica (dry-run)
 *   DIRECT_URL=<url sem pooler> npx tsx scripts/aplicar-google-sub.ts --apply --banco=<host>   # aplica
 *   (--ambiente=teste para o banco isolado de homologação; o padrão é produção e RECUSA um banco com marcador de teste)
 *
 * O que verifica:
 *   - o host da URL é o informado em `--banco=` (como nos outros scripts de cadastro);
 *   - antes: a tabela User existe e `googleSub` ainda não; registra contagem e um HASH calculado no próprio servidor
 *     (md5 de id, e-mail e senhaHash de todas as linhas, em ordem) — nenhum dado sai do banco;
 *   - aplica em UMA transação (DDL transacional do Postgres): se qualquer passo falhar, nada muda;
 *   - depois: coluna e índice único existem, e contagem e hash são IDÊNTICOS aos de antes (prova de que nenhuma linha mudou).
 * Reversão (mantém dados; só remove a estrutura): DROP INDEX IF EXISTS "User_googleSub_key"; ALTER TABLE "User" DROP COLUMN IF EXISTS "googleSub";
 * Em rollback de CÓDIGO a coluna deve ficar: ela guarda vínculos já criados.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const url = process.env.DIRECT_URL ?? "";
const aplicar = process.argv.includes("--apply");
const banco = process.argv.find((a) => a.startsWith("--banco="))?.slice("--banco=".length);
const ambiente = process.argv.find((a) => a.startsWith("--ambiente="))?.slice("--ambiente=".length) ?? "producao";

function recusar(motivo: string): never {
  console.error(`RECUSADO: ${motivo}`);
  process.exit(3);
}

async function main() {
  if (!url) recusar("defina DIRECT_URL no ambiente");
  const host = new URL(url).hostname;
  const prisma = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
  try {
    const marcador = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_ObaflixAmbiente'`,
    );
    const ehTeste = marcador[0].n > 0;
    if (ambiente === "producao" && ehTeste) recusar("banco com marcador de teste: nao e producao");
    if (ambiente === "teste" && !ehTeste) recusar("--ambiente=teste exige o marcador do banco isolado");

    const instantaneo = async () => {
      const [r] = await prisma.$queryRawUnsafe<{ n: number; h: string | null }[]>(
        `SELECT count(*)::int AS n, md5(string_agg("id" || '|' || "email" || '|' || coalesce("senhaHash", ''), ',' ORDER BY "id")) AS h FROM "User"`,
      );
      return r;
    };
    const colunas = async () =>
      (await prisma.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'User'`,
      )).map((c) => c.column_name);

    const antesCols = await colunas();
    if (!antesCols.includes("email") || !antesCols.includes("senhaHash")) recusar("tabela User inesperada");
    const antes = await instantaneo();
    const jaTem = antesCols.includes("googleSub");
    console.log(JSON.stringify({ host: host.split(".")[0] + "…", ambiente, usuarios: antes.n, hash: antes.h?.slice(0, 8), googleSub: jaTem ? "existe" : "ausente" }));

    if (!aplicar) { console.log("Dry-run: nada foi alterado. Use --apply --banco=<host>."); return; }
    if (banco !== host) recusar("--banco= nao confere com o host da DIRECT_URL");

    const sql = readFileSync(join(process.cwd(), "prisma", "migrations", "20261026120000_user_google_sub", "migration.sql"), "utf8");
    const comandos = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((c) => c.trim()).filter(Boolean);
    await prisma.$transaction(async (tx) => { for (const c of comandos) await tx.$executeRawUnsafe(c); });

    const depois = await instantaneo();
    const colunasDepois = await colunas();
    const [indice] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'User' AND indexname = 'User_googleSub_key' AND indexdef ILIKE '%UNIQUE%'`,
    );
    const ok = colunasDepois.includes("googleSub") && indice.n === 1 && depois.n === antes.n && depois.h === antes.h;
    console.log(JSON.stringify({ coluna: colunasDepois.includes("googleSub"), indiceUnico: indice.n === 1, linhasIguais: depois.n === antes.n && depois.h === antes.h }));
    if (!ok) { console.error("VERIFICACAO FALHOU: nao prossiga com o deploy"); process.exitCode = 1; }
  } finally {
    await prisma.$disconnect();
  }
}

main();
