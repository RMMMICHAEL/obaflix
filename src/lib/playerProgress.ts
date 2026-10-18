/** Uma gravação por vez; eventos intermediários cedem lugar ao estado mais recente. */
export function createProgressSaver<T>(send: (snapshot: T) => Promise<boolean>) {
  let saved: string | undefined;
  let pending: { snapshot: T; key: string } | undefined;
  let running: Promise<void> | undefined;

  async function drain() {
    while (pending) {
      const next = pending;
      pending = undefined;
      if (next.key === saved) continue;
      try {
        if (await send(next.snapshot)) saved = next.key;
      } catch {
        // Sem confirmação, o próximo checkpoint/evento pode tentar novamente.
      }
    }
  }

  function start(): Promise<void> {
    running = Promise.resolve().then(drain).finally(() => {
      running = undefined;
      // Um evento pode chegar entre o fim de drain e esta microtask.
      if (pending) return start();
    });
    return running;
  }

  return (snapshot: T): Promise<void> => {
    const key = JSON.stringify(snapshot);
    // Mesmo um retorno à posição salva precisa substituir um pendente mais novo:
    // o pedido em andamento ainda pode gravar outra posição antes dele.
    pending = { snapshot, key };
    return running ?? start();
  };
}

export const PROGRESS_CHECKPOINT_MS = 30_000;
