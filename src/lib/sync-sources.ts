/**
 * Produtores de catálogo conhecidos (inventário da fase 1, ver
 * docs/admin-separado-fase-1.md). Nenhum deles envia `SyncRun` ainda: até a
 * migração para /api/integracoes/catalogo/heartbeat, o painel mostra
 * "sem telemetria" — nunca uma execução inventada.
 *
 * `source`/`job` são os identificadores que cada produtor passará no
 * heartbeat. `legacy` casa linhas antigas de `SyncMetric` (hoje só o
 * popular-sync grava, sem distinguir execução local de Vercel).
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
  { id: "megafrix-local", label: "MegaFrix (tarefa Windows 5h)", executaOnde: "Agendador do Windows", frequenciaHoras: 5, match: [{ source: "megafrix-local" }] },
  { id: "webcine-local", label: "WebCine (tarefa Windows 5h)", executaOnde: "Agendador do Windows", frequenciaHoras: 5, match: [{ source: "webcine-local" }] },
  { id: "superflix-local", label: "SuperFlix calendário (tarefa Windows 5h)", executaOnde: "Agendador do Windows", frequenciaHoras: 5, match: [{ source: "superflix-local" }] },
  { id: "tmdb-popular", label: "TMDB Popular", executaOnde: "Agendador do Windows (5h) e Vercel Cron diário", frequenciaHoras: 5, match: [{ source: "tmdb-popular" }, { source: "tmdb", job: "popular-sync" }] },
  { id: "megafrix-vercel", label: "MegaFrix (Vercel Cron diário)", executaOnde: "Vercel Cron 03:00 UTC", frequenciaHoras: 24, match: [{ source: "megafrix-vercel" }] },
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
