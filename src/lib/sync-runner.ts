import {
  redactSecrets,
  summarizeJobResult,
  SYNC_JOBS,
  syncSource,
  type SyncJobId,
  type SyncRunRecorder,
  type SyncRunResult,
} from "@/lib/sync-telemetry";

/**
 * Núcleo do ciclo local de sincronização (tarefa Windows de 5h).
 *
 * Cada job é isolado: falha ou exceção de um não impede os seguintes, e cada
 * um gera o próprio SyncRun `<job>-local`. O código de saída diferencia:
 *   0 = todos concluídos (SUCCESS ou SKIPPED por lock)
 *   2 = falha parcial (ao menos um falhou e ao menos um concluiu)
 *   1 = falha total (todos falharam) — ou erro fatal antes do ciclo
 */
export const EXIT_OK = 0;
export const EXIT_TOTAL = 1;
export const EXIT_PARCIAL = 2;

export type CycleHandler = (request: Request) => Promise<Response>;

export type CycleJob = { id: SyncJobId; loadHandler: () => Promise<CycleHandler> };

export type JobOutcome = { id: SyncJobId; source: string; httpStatus: number | null; durationMs: number; result: SyncRunResult };

export type CycleDeps = {
  jobs: CycleJob[];
  cronSecret: string;
  recorder: SyncRunRecorder;
  /** Linha curta de progresso (console + arquivo). Já recebe texto sem segredos. */
  log: (line: string) => Promise<void> | void;
  /** Corpo completo da resposta, para o arquivo de log. Já recebe texto sem segredos. */
  logBody?: (job: SyncJobId, httpStatus: number, body: string) => Promise<void> | void;
  now?: () => Date;
  intervalHours?: number;
  env?: Record<string, string | undefined>;
};

export function exitCodeFor(outcomes: JobOutcome[]): number {
  if (outcomes.length === 0) return EXIT_OK;
  const failed = outcomes.filter((o) => o.result.status === "FAILED").length;
  if (failed === 0) return EXIT_OK;
  return failed === outcomes.length ? EXIT_TOTAL : EXIT_PARCIAL;
}

export async function runSyncCycle(deps: CycleDeps): Promise<{ outcomes: JobOutcome[]; exitCode: number }> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const clean = (text: string) => redactSecrets(text, env);
  const outcomes: JobOutcome[] = [];

  for (const job of deps.jobs) {
    const startedAt = now();
    const run = {
      source: syncSource(job.id, "local"),
      job: SYNC_JOBS[job.id].job,
      startedAt,
      expectedNextAt: deps.intervalHours ? new Date(startedAt.getTime() + deps.intervalHours * 3600000) : null,
    };
    await deps.log(`${job.id}: iniciando`);
    const runId = await deps.recorder.start(run);

    let httpStatus: number | null = null;
    let result: SyncRunResult;
    try {
      const handler = await job.loadHandler();
      const response = await handler(new Request(`http://127.0.0.1${SYNC_JOBS[job.id].path}`, {
        headers: { authorization: `Bearer ${deps.cronSecret}` },
      }));
      httpStatus = response.status;
      const text = await response.text();
      await deps.logBody?.(job.id, response.status, clean(text));
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* resposta não JSON: conta como falha pelo status/ok */ }
      result = summarizeJobResult(job.id, response.status, body);
    } catch (error) {
      result = summarizeJobResult(job.id, 500, null, error);
    }

    const finishedAt = now();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    await deps.recorder.finish(runId, run, result, finishedAt);
    outcomes.push({ id: job.id, source: run.source, httpStatus, durationMs, result });

    const seconds = (durationMs / 1000).toFixed(1);
    if (result.status === "FAILED") {
      await deps.log(clean(`${job.id}: FALHOU${httpStatus ? ` (HTTP ${httpStatus})` : ""} após ${seconds}s — ${result.errorSummary ?? "sem detalhe"}`));
    } else if (result.status === "SKIPPED") {
      await deps.log(clean(`${job.id}: ignorado após ${seconds}s — ${result.errorSummary ?? ""}`));
    } else {
      await deps.log(`${job.id}: concluído em ${seconds}s — F +${result.moviesAdded}/~${result.moviesUpdated} · S +${result.seriesAdded}/~${result.seriesUpdated} · E +${result.episodesAdded}/~${result.episodesUpdated}`);
    }
  }

  const exitCode = exitCodeFor(outcomes);
  const ok = outcomes.filter((o) => o.result.status !== "FAILED").map((o) => o.id);
  const falhas = outcomes.filter((o) => o.result.status === "FAILED").map((o) => o.id);
  const tipo = exitCode === EXIT_OK ? "sucesso" : exitCode === EXIT_PARCIAL ? "falha parcial" : "falha total";
  await deps.log(`Ciclo finalizado (${tipo}, código ${exitCode}): ${ok.length} ok [${ok.join(", ")}], ${falhas.length} falha(s) [${falhas.join(", ")}].`);
  return { outcomes, exitCode };
}
