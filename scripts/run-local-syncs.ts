/**
 * Executa localmente os mesmos quatro handlers usados pelos antigos cron jobs
 * da Vercel. Nenhuma chamada é feita ao domínio publicado do Obaflix.
 *
 * Origem: copiado de D:\streaming-app\scripts\run-local-syncs.ts (não
 * versionado lá), que é o que a tarefa Windows "Obaflix - Sincronizar
 * catalogos a cada 5 horas" executa. Esta versão mantém ordem dos jobs, lock,
 * pasta de logs e `--check`, e acrescenta:
 *   - SyncRun por job (`megaflix-local`, `tmdb-popular-local`, `webcine-local`,
 *     `superflix-local`), sem segredo nem URL sensível;
 *   - log sem valores de variáveis sensíveis;
 *   - código de saída 0 (ok), 2 (falha parcial), 1 (falha total/fatal).
 *
 * Uso:
 *   npm run sync:local
 *   npm run sync:local:check
 *
 * Telemetria (SYNC_TELEMETRY):
 *   db   (padrão) grava SyncRun direto com DATABASE_URL;
 *   http envia para OBAFLIX_INTEGRACAO_URL/api/integracoes/catalogo/heartbeat
 *        com CATALOG_SYNC_TOKEN;
 *   off  não grava.
 * Falha de telemetria nunca muda o resultado dos jobs.
 */

import { loadEnvConfig } from "@next/env";
import { randomBytes } from "crypto";
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { NextRequest } from "next/server";
import { EXIT_TOTAL, runSyncCycle, type CycleHandler, type CycleJob } from "../src/lib/sync-runner";
import { createDbRecorder, createHttpRecorder, redactSecrets, type SyncRunRecorder } from "../src/lib/sync-telemetry";

loadEnvConfig(process.cwd());
process.env.LOCAL_SYNC_RUNNER = "1";
process.env.CRON_SECRET ||= randomBytes(32).toString("hex");

type Handler = (request: NextRequest) => Promise<Response>;
type RouteNamespace = {
  GET?: Handler;
  default?: { GET?: Handler };
};

const INTERVAL_HOURS = 5;
const checkOnly = process.argv.includes("--check");
const dataRoot = join(process.env.LOCALAPPDATA || tmpdir(), "Obaflix", "sync");
const logRoot = join(dataRoot, "logs");
const lockPath = join(dataRoot, "sync.lock");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = join(logRoot, `sync-${runId}.log`);

mkdirSync(logRoot, { recursive: true });

function stamp(message: string): string {
  return `[${new Date().toISOString()}] ${message}`;
}

async function log(message: string): Promise<void> {
  const line = stamp(redactSecrets(message));
  console.log(line);
  await appendFile(logPath, `${line}\n`, "utf8");
}

function acquireLock(): number {
  try {
    return openSync(lockPath, "wx");
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;

    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs <= 5 * 60 * 60 * 1000) {
      throw new Error("Já existe uma sincronização local em andamento.");
    }

    unlinkSync(lockPath);
    return openSync(lockPath, "wx");
  }
}

function requiredEnvironmentProblems(): string[] {
  const missing: string[] = [];
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!process.env.TMDB_API_KEY && !process.env.TMDB_JWT) {
    missing.push("TMDB_API_KEY ou TMDB_JWT");
  }
  for (const name of ["WEBCINE_REFRESH_TOKEN", "WEBCINE_DEVICE_ID", "WEBCINE_PROFILE_ID"]) {
    if (!process.env[name]) missing.push(name);
  }
  return missing;
}

async function handlerFrom(loader: () => Promise<RouteNamespace>): Promise<CycleHandler> {
  const routeNamespace = await loader();
  const handler = routeNamespace.GET ?? routeNamespace.default?.GET;
  if (!handler) throw new Error("Handler GET não encontrado");
  return (request) => handler(new NextRequest(request));
}

// Mesma ordem da versão anterior: megafrix/megaflix, popular, webcine, superflix.
const jobs: CycleJob[] = [
  { id: "megaflix", loadHandler: () => handlerFrom(() => import("../src/app/api/cron/sync/route")) },
  { id: "tmdb-popular", loadHandler: () => handlerFrom(() => import("../src/app/api/cron/popular-sync/route")) },
  { id: "webcine", loadHandler: () => handlerFrom(() => import("../src/app/api/cron/sync-webcine/route")) },
  { id: "superflix", loadHandler: () => handlerFrom(() => import("../src/app/api/cron/sync-superflix/route")) },
];

async function createRecorder(): Promise<SyncRunRecorder> {
  const mode = (process.env.SYNC_TELEMETRY ?? "db").toLowerCase();
  const warn = (message: string) => { void log(message); };
  if (mode === "off") return { start: async () => null, finish: async () => {} };
  if (mode === "http") {
    const baseUrl = process.env.OBAFLIX_INTEGRACAO_URL;
    const token = process.env.CATALOG_SYNC_TOKEN;
    if (!baseUrl || !token) throw new Error("SYNC_TELEMETRY=http exige OBAFLIX_INTEGRACAO_URL e CATALOG_SYNC_TOKEN");
    return createHttpRecorder({ baseUrl, token, onError: warn });
  }
  const { prisma } = await import("../src/lib/prisma");
  return createDbRecorder(prisma as any, warn);
}

async function main(): Promise<void> {
  const missing = requiredEnvironmentProblems();
  if (missing.length) {
    throw new Error(`Variáveis ausentes: ${missing.join(", ")}`);
  }

  // Importa todos os handlers durante a verificação para detectar dependências
  // ou erros de compilação sem alterar o banco.
  if (checkOnly) {
    for (const job of jobs) {
      await job.loadHandler();
      await log(`${job.id}: handler carregado`);
    }
    await log("Verificação local concluída; nenhuma sincronização foi executada.");
    return;
  }

  const lock = acquireLock();
  writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");

  try {
    await log(`Ciclo iniciado; log: ${logPath}`);
    const { exitCode } = await runSyncCycle({
      jobs,
      cronSecret: process.env.CRON_SECRET!,
      recorder: await createRecorder(),
      log,
      logBody: (job, status, body) => appendFile(logPath, `${stamp(`${job}: resposta HTTP ${status}`)}\n${body}\n`, "utf8"),
      intervalHours: INTERVAL_HOURS,
    });
    process.exitCode = exitCode;
  } finally {
    closeSync(lock);
    try { unlinkSync(lockPath); } catch { /* já removido */ }
  }
}

main()
  .catch(async (error) => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await log(`Falha fatal: ${detail}`);
    process.exitCode = EXIT_TOTAL;
  })
  .finally(async () => {
    try { (await import("../src/lib/prisma")).prisma.$disconnect(); } catch { /* sem conexão aberta */ }
  });
