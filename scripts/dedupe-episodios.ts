/**
 * Remove episódios duplicados na coordenada (serieId, temporada, numeroEp),
 * preparando o banco para o índice único da migration
 * `20260930120000_episodio_unique_coordenada`.
 *
 * Uso:
 *   npx tsx scripts/dedupe-episodios.ts                          # DRY RUN (padrão)
 *   npx tsx scripts/dedupe-episodios.ts --dry-run                # idem, explícito
 *   npx tsx scripts/dedupe-episodios.ts --apply --backup-dir <dir>
 *
 * Regras (lógica em src/lib/episode-dedupe.ts):
 *   - DRY RUN não escreve nada: só relatório;
 *   - --apply exige --backup-dir; o backup (JSON das linhas afetadas e do
 *     WatchHistory delas) é gravado ANTES de qualquer alteração;
 *   - cada grupo em uma transação; invariante quebrada → rollback e o script
 *     para ali, com código de saída 1;
 *   - o backup contém dados de produção: nunca dentro do repositório
 *     (exceto em backups/, que o .gitignore exclui).
 *
 * Banco: DATABASE_URL do ambiente. Não há padrão apontando para produção.
 */
import { mkdirSync, writeFileSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { PrismaClient } from "@prisma/client";
import { runEpisodeDedupe, type Coordinate } from "../src/lib/episode-dedupe";

export function parseDedupeArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run")) throw new Error("use --apply OU --dry-run, não os dois");
  const i = argv.indexOf("--backup-dir");
  const backupDir = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && (!backupDir || backupDir.startsWith("--"))) throw new Error("--backup-dir exige um caminho");
  if (apply && !backupDir) throw new Error("--apply exige --backup-dir <dir>: sem backup, nada é alterado");
  return { mode: apply ? "apply" as const : "dry-run" as const, backupDir };
}

/** Recusa gravar dump de produção em pasta versionada. */
export function assertBackupDirOutsideGit(dir: string, repoRoot = process.cwd()) {
  const abs = resolve(dir);
  const rel = relative(resolve(repoRoot), abs);
  const insideRepo = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (insideRepo && !(rel === "backups" || rel.startsWith(`backups/`) || rel.startsWith(`backups\\`))) {
    throw new Error(`--backup-dir dentro do repositório só em backups/ (ignorado pelo git): ${rel}`);
  }
  return abs;
}

async function main() {
  const { mode, backupDir } = parseDedupeArgs(process.argv.slice(2));
  const dir = backupDir ? assertBackupDirOutsideGit(backupDir) : null;
  const prisma = new PrismaClient();
  try {
    const report = await runEpisodeDedupe(prisma as any, {
      mode,
      log: (line) => console.log(line),
      listDuplicates: async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ serieId: string; temporada: number; numeroEp: number }>>(
          `SELECT "serieId", temporada, "numeroEp" FROM "Episodio"
            GROUP BY "serieId", temporada, "numeroEp" HAVING COUNT(*) > 1
            ORDER BY "serieId", temporada, "numeroEp"`,
        );
        return rows.map((r): Coordinate => ({ serieId: r.serieId, temporada: Number(r.temporada), numeroEp: Number(r.numeroEp) }));
      },
      writeBackup: dir
        ? async (payload) => {
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `episodios-dedupe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
            writeFileSync(file, JSON.stringify(payload), { encoding: "utf8", flag: "wx", mode: 0o600 });
            return file;
          }
        : undefined,
    });

    console.log(`\nModo: ${report.mode === "apply" ? "APPLY" : "DRY RUN (nada foi alterado)"}`);
    console.log(`grupos=${report.grupos} linhas=${report.linhas} canonicos=${report.canonicos} removiveis=${report.removiveis}`);
    console.log(`fks_mover=${report.fksMover} watch_mesclar=${report.watchMesclar} campos_mesclar=${report.camposMesclar}`);
    console.log(`conflitos=${report.conflitos.length} erros=${report.erros.length}${report.mode === "apply" ? ` aplicados=${report.aplicados}` : ""}`);
    if (report.backupFile) console.log(`backup=${report.backupFile}`);
    for (const c of report.conflitos.slice(0, 50)) console.log(`  conflito: ${c}`);
    for (const e of report.erros) console.log(`  erro: ${e}`);
    if (report.erros.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /dedupe-episodios\.ts$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
