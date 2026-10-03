export const JANELA_RETRY_DOWNLOAD_MS = 5 * 60_000;
export interface OperacaoDownload {
  usuario: string;
  instancia: string;
  sessao: string | null;
  conteudoId: string;
  temporada?: number;
  numeroEp?: number;
  fonteId: string;
  stream: string;
  referer: string;
  tipo: "mp4" | "hls";
  titulo: string;
  modo: "completo" | "trecho";
  inicioSeg?: number;
  fimSeg?: number;
}
export interface RetryDownload { operacao: OperacaoDownload; expiraEm: number }
export function podeRepetirDownload(retry: RetryDownload | null, atual: OperacaoDownload, agora = Date.now()): boolean {
  return !!retry && agora < retry.expiraEm && JSON.stringify(retry.operacao) === JSON.stringify(atual);
}

export interface ResultadoDownload { ok?: boolean; cancelado?: boolean; caminho?: string; error?: string }
/** Só o botão de retry reaproveita autorização; a porta de IPC vem depois dela. */
export async function executarTentativaDownload(
  operacao: OperacaoDownload,
  retentativa: boolean,
  retry: RetryDownload | null,
  portas: {
    autorizar(): Promise<boolean>;
    atual(): OperacaoDownload | null;
    guardarRetry(retry: RetryDownload | null): void;
    iniciar(operacao: OperacaoDownload): Promise<ResultadoDownload>;
    agora?: () => number;
  },
): Promise<ResultadoDownload> {
  const agora = portas.agora ?? Date.now;
  let autorizacao = retentativa && podeRepetirDownload(retry, operacao, agora()) ? retry : null;
  if (!autorizacao) {
    portas.guardarRetry(null);
    if (!await portas.autorizar()) return { cancelado: true };
    autorizacao = { operacao, expiraEm: agora() + JANELA_RETRY_DOWNLOAD_MS };
  }
  const atual = portas.atual();
  if (!atual || !podeRepetirDownload(autorizacao, atual, agora())) {
    portas.guardarRetry(null);
    return { cancelado: true };
  }
  portas.guardarRetry(autorizacao);
  const resultado = await portas.iniciar(operacao);
  if (resultado.ok || resultado.cancelado) portas.guardarRetry(null);
  return resultado;
}
