/**
 * Executa localmente os mesmos quatro handlers usados pelos antigos cron jobs
 * da Vercel. Nenhuma chamada é feita ao domínio publicado do Obaflix.
 *
 * Uso:
 *   npm run sync:local
 *   npm run sync:local:check
 */

import { loadEnvConfig } from "@next/env";
import { randomBytes } from "crypto";
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { NextRequest } from "next/server";

loadEnvConfig(process.cwd());
process.env.LOCAL_SYNC_RUNNER = "1";
process.env.CRON_SECRET ||= randomBytes(32).toString("hex");

type Handler = (request: NextRequest) => Promise<Response>;
type RouteNamespace = {
  GET?: Handler;
  default?: { GET?: Handler };
};

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
  const line = stamp(message);
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

async function handlerFrom(loader: () => Promise<RouteNamespace>): Promise<Handler> {
  const routeNamespace = await loader();
  const handler = routeNamespace.GET ?? routeNamespace.default?.GET;
  if (!handler) throw new Error("Handler GET não encontrado");
  return handler;
}

const jobs: Array<{
  name: string;
  path: string;
  load: () => Promise<RouteNamespace>;
}> = [
  {
    name: "megafrix",
    path: "/api/cron/sync",
    load: () => import("../src/app/api/cron/sync/route"),
  },
  {
    name: "popular-tmdb",
    path: "/api/cron/popular-sync",
    load: () => import("../src/app/api/cron/popular-sync/route"),
  },
  {
    name: "webcine",
    path: "/api/cron/sync-webcine",
    load: () => import("../src/app/api/cron/sync-webcine/route"),
  },
  {
    name: "superflix",
    path: "/api/cron/sync-superflix",
    load: () => import("../src/app/api/cron/sync-superflix/route"),
  },
];

async function executeJob(job: (typeof jobs)[number]): Promise<boolean> {
  const startedAt = Date.now();
  await log(`${job.name}: iniciando`);

  try {
    const handler = await handlerFrom(job.load);
    const request = new NextRequest(`http://127.0.0.1${job.path}`, {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const response = await handler(request);
    const body = await response.text();
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    await appendFile(
      logPath,
      `${stamp(`${job.name}: resposta HTTP ${response.status}`)}\n${body}\n`,
      "utf8",
    );

    if (!response.ok) {
      await log(`${job.name}: falhou com HTTP ${response.status} após ${durationSeconds}s`);
      return false;
    }

    let parsed: { ok?: boolean } | null = null;
    try { parsed = JSON.parse(body); } catch { /* resposta não JSON */ }
    if (parsed?.ok === false) {
      await log(`${job.name}: retornou ok=false após ${durationSeconds}s`);
      return false;
    }

    await log(`${job.name}: concluído em ${durationSeconds}s`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await log(`${job.name}: erro — ${detail}`);
    return false;
  }
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
      await handlerFrom(job.load);
      await log(`${job.name}: handler carregado`);
    }
    await log("Verificação local concluída; nenhuma sincronização foi executada.");
    return;
  }

  const lock = acquireLock();
  writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
  let failures = 0;

  try {
    await log(`Ciclo iniciado; log: ${logPath}`);
    for (const job of jobs) {
      if (!(await executeJob(job))) failures++;
    }
    await log(`Ciclo finalizado: ${jobs.length - failures} sucesso(s), ${failures} falha(s).`);
  } finally {
    closeSync(lock);
    try { unlinkSync(lockPath); } catch { /* já removido */ }
  }

  if (failures) process.exitCode = 1;
}

main().catch(async (error) => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await log(`Falha fatal: ${detail}`);
  process.exitCode = 1;
});
