/**
 * Produtores de catálogo conhecidos (inventário em docs/admin-separado-fase-1.md).
 * Fonte que ainda não registrou `SyncRun` aparece como "sem telemetria" —
 * nunca uma execução inventada.
 *
 * `source` = `<job>-local` (tarefa Windows, scripts/run-local-syncs.ts) ou
 * `<job>-vercel` (withCronTelemetry nos handlers de cron), ver
 * src/lib/sync-telemetry.ts. A SyncMetric antiga do popular-sync aparece à
 * parte, porque não distingue a origem.
 *
 * Atraso: com frequência conhecida, alerta quando o último SUCESSO passa de
 * 2× o intervalo (job de 5h → alerta após 10h sem sucesso).
 */
export type SyncSourceDef = {
  id: string;
  label: string;
  executaOnde: string;
  frequenciaHoras: number | null;
  match: Array<{ source: string; job?: string }>;
};

export const SYNC_SOURCES: SyncSourceDef[] = [
  { id: "megaflix-local", label: "MegaFlix/App (tarefa Windows)", executaOnde: "Agendador do Windows", frequenciaHoras: 5, match: [{ source: "megaflix-local" }] },
  { id: "tmdb-popular-local", label: "TMDB Popular (tarefa Windows)", executaOnde: "Agendador do Windows", frequenciaHoras: 5, match: [{ source: "tmdb-popular-local" }] },
  { id: "webcine-local", label: "WebCine (tarefa Windows)", executaOnde: "Agendador do Windows", frequenciaHoras: 5, match: [{ source: "webcine-local" }] },
  { id: "superflix-local", label: "SuperFlix calendário (tarefa Windows)", executaOnde: "Agendador do Windows", frequenciaHoras: 5, match: [{ source: "superflix-local" }] },
  { id: "megaflix-vercel", label: "MegaFlix/App (Vercel Cron)", executaOnde: "Vercel Cron 03:00 UTC", frequenciaHoras: 24, match: [{ source: "megaflix-vercel" }] },
  { id: "tmdb-popular-vercel", label: "TMDB Popular (Vercel Cron)", executaOnde: "Vercel Cron 03:30 UTC", frequenciaHoras: 24, match: [{ source: "tmdb-popular-vercel" }] },
  { id: "webcine-vercel", label: "WebCine (Vercel, disparo manual)", executaOnde: "Vercel, sob demanda", frequenciaHoras: null, match: [{ source: "webcine-vercel" }] },
  { id: "superflix-vercel", label: "SuperFlix (Vercel, disparo manual)", executaOnde: "Vercel, sob demanda", frequenciaHoras: null, match: [{ source: "superflix-vercel" }] },
  // SyncMetric antiga do popular-sync: não diz se veio da tarefa local ou da Vercel.
  { id: "tmdb-popular-legado", label: "TMDB Popular (métrica legada, origem indistinta)", executaOnde: "local ou Vercel", frequenciaHoras: null, match: [{ source: "tmdb", job: "popular-sync" }] },
  { id: "tmdb-top250", label: "TMDB Top 250", executaOnde: "Painel / script manual", frequenciaHoras: null, match: [{ source: "tmdb-top250" }] },
  { id: "megaflix-tampermonkey", label: "MegaFlix painel (Tampermonkey)", executaOnde: "Chrome do operador, manual", frequenciaHoras: null, match: [{ source: "megaflix-tampermonkey" }] },
  { id: "importacao-manual", label: "Importação manual", executaOnde: "Terminal / painel, manual", frequenciaHoras: null, match: [{ source: "importacao-manual" }] },
];

export type SyncRunLike = {
  id: string;
  source: string;
  job: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  [key: string]: unknown;
};

export type SyncSourceStatus = {
  id: string;
  label: string;
  executaOnde: string;
  frequenciaHoras: number | null;
  telemetria: boolean;
  ultima: SyncRunLike | null;
  ultimoSucessoEm: Date | null;
  atrasada: boolean;
  horasSemSucesso: number | null;
};

/**
 * Resumo de erro exibível: sem URL (pode carregar host de provider, query com
 * chave de API ou link assinado) e com tamanho limitado.
 */
export function sanitizeErrorSummary(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[url removida]")
    .replace(/\b(api_key|token|secret|senha|password|authorization)=[^\s&"']+/gi, "$1=[removido]")
    .trim()
    .slice(0, max);
  return clean || null;
}

const matches = (def: SyncSourceDef, run: SyncRunLike) =>
  def.match.some((m) => m.source === run.source && (m.job === undefined || m.job === run.job));

/** `runs` em ordem decrescente de início. */
export function summarizeSyncSources(runs: SyncRunLike[], now: Date, defs = SYNC_SOURCES) {
  const fontes: SyncSourceStatus[] = defs.map((def) => {
    const own = runs.filter((run) => matches(def, run));
    const ultima = own[0] ?? null;
    const sucesso = own.find((run) => run.status === "SUCCESS");
    const ultimoSucessoEm = sucesso ? sucesso.finishedAt ?? sucesso.startedAt : null;
    const horasSemSucesso = ultimoSucessoEm ? (now.getTime() - ultimoSucessoEm.getTime()) / 3600000 : null;
    // Sem telemetria não há como afirmar atraso: fica "sem telemetria", não "atrasada".
    const atrasada = def.frequenciaHoras !== null && ultima !== null
      && (horasSemSucesso === null || horasSemSucesso > 2 * def.frequenciaHoras);
    return {
      id: def.id, label: def.label, executaOnde: def.executaOnde, frequenciaHoras: def.frequenciaHoras,
      telemetria: ultima !== null, ultima, ultimoSucessoEm, atrasada,
      horasSemSucesso: horasSemSucesso === null ? null : Math.round(horasSemSucesso * 10) / 10,
    };
  });
  // Fontes que mandaram telemetria mas não estão no inventário: aparecem, não somem.
  const outras = new Map<string, SyncRunLike>();
  for (const run of runs) {
    if (defs.some((def) => matches(def, run))) continue;
    const key = `${run.source}:${run.job}`;
    if (!outras.has(key)) outras.set(key, run);
  }
  return { fontes, outras: [...outras.values()] };
}
