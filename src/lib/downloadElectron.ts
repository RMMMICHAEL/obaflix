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

export interface ResultadoLote { concluidas: number; falhas: number; total: number; cancelado: boolean }
/**
 * Baixa um lote de cenas como UMA ação de download: autoriza uma única vez, antes
 * do primeiro arquivo, e então recorta todas as cenas em sequência da mesma fonte
 * já validada. Legítimo porque a autorização (`autorizar`) consome uma concessão
 * nova em `/fontes` e devolve a mídia validada; os recortes seguintes são feitos
 * localmente (ffmpeg) sobre esse mesmo stream, sem novo contato com o servidor —
 * não reaproveita concessão consumida nem contorna validação.
 *
 * `contextoValido()` é conferido logo após a autorização e antes de cada cena: se
 * fonte, usuário, conteúdo ou sessão mudarem, o lote para com segurança (a mídia
 * validada deixa de valer). Interrompe cedo quando o usuário cancela
 * (`cancelado()`), quando a autorização é recusada/cancelada (false) ou
 * interrompida (throw). Falha técnica de uma cena não encerra o lote: conta como
 * falha e segue para a próxima.
 */
export async function executarLoteDownload(
  operacoes: OperacaoDownload[],
  portas: {
    autorizar(): Promise<boolean>;
    contextoValido(): boolean;
    iniciar(operacao: OperacaoDownload, indice: number): Promise<ResultadoDownload>;
    aoIniciarCena?(indice: number, operacao: OperacaoDownload): void;
    aoConcluirCena?(indice: number, resultado: ResultadoDownload): void;
    cancelado?(): boolean;
  },
): Promise<ResultadoLote> {
  const total = operacoes.length;
  const parado = (concluidas: number, falhas: number): ResultadoLote => ({ concluidas, falhas, total, cancelado: true });
  if (!total) return { concluidas: 0, falhas: 0, total: 0, cancelado: false };
  if (portas.cancelado?.()) return parado(0, 0);

  // Uma autorização para o lote inteiro.
  let autorizada: boolean;
  try {
    autorizada = await portas.autorizar();
  } catch {
    return parado(0, 0); // autorização interrompida (anúncio/liberação)
  }
  if (!autorizada) return parado(0, 0); // recusada/cancelada no convite
  // A concessão vale enquanto a fonte validada não mudar.
  if (!portas.contextoValido()) return parado(0, 0);

  let concluidas = 0;
  let falhas = 0;
  for (let i = 0; i < total; i += 1) {
    if (portas.cancelado?.() || !portas.contextoValido()) return parado(concluidas, falhas);
    portas.aoIniciarCena?.(i, operacoes[i]);
    let resultado: ResultadoDownload;
    try {
      resultado = await portas.iniciar(operacoes[i], i);
    } catch {
      resultado = { error: "falha" };
    }
    portas.aoConcluirCena?.(i, resultado);
    if (resultado.cancelado) return parado(concluidas, falhas);
    if (resultado.ok) concluidas += 1; else falhas += 1;
  }
  return { concluidas, falhas, total, cancelado: false };
}
