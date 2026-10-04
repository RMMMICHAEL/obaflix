export const PRAZOS_PREPARACAO = { candidata: 90_000, preflight: 60_000, busca: 240_000, fontes: 15_000 };
export type ReasonPreparacao = "current_incompatible" | "resolve_timeout" | "resolve_failed" | "preflight_failed" | "compatible";
class PrazoPreparacao extends Error { name = "PrazoPreparacao"; }

/** Inclui IPC que não oferece abort: resposta tardia é consumida e descartada. */
async function limitar<T>(acao: () => Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new PrazoPreparacao();
  return new Promise<T>((resolve, reject) => {
    let acabou = false;
    const fim = (fn: () => void) => { if (acabou) return; acabou = true; clearTimeout(timer); signal.removeEventListener("abort", abortar); fn(); };
    const abortar = () => fim(() => reject(new PrazoPreparacao()));
    const timer = setTimeout(abortar, ms);
    signal.addEventListener("abort", abortar, { once: true });
    Promise.resolve().then(acao).then(valor => fim(() => resolve(valor)), erro => fim(() => reject(erro)));
  });
}

/** Atual, fontes em ordem e opções descobertas da MESMA sessão. Sem anúncio. */
export async function encontrarMidiaCompativel<T, F>(atual: T | null, fontes: F[], portas: {
  ativa: () => boolean;
  signal?: AbortSignal;
  id: (fonte: F) => string;
  idAtual: string;
  fontesAtuais?: () => F[];
  fontesPendentes?: () => boolean;
  iniciar?: (numero: number) => void;
  verificar: (midia: T) => Promise<boolean>;
  resolver: (fonte: F, signal: AbortSignal, descobrir: (novas: F[]) => void, verificar: (midia: T) => Promise<boolean>) => Promise<T | null>;
  diagnosticar?: (sourceId: string, reason: ReasonPreparacao) => void;
  prazos?: Partial<typeof PRAZOS_PREPARACAO>;
}): Promise<T | null> {
  const prazos = { ...PRAZOS_PREPARACAO, ...portas.prazos };
  const busca = new AbortController();
  const abortar = () => busca.abort();
  portas.signal?.addEventListener("abort", abortar, { once: true });
  if (portas.signal?.aborted) busca.abort();
  const teto = setTimeout(abortar, prazos.busca);
  const ativa = () => !busca.signal.aborted && portas.ativa();
  const fila: F[] = [];
  const conhecidas = new Set<string>();
  const vistas = new Set<string>();
  const adicionar = (novas: F[]) => {
    if (!ativa()) return;
    for (const fonte of novas) {
      const id = portas.id(fonte);
      if (id === portas.idAtual || conhecidas.has(id)) continue;
      conhecidas.add(id);
      fila.push(fonte);
    }
  };
  adicionar(fontes);
  const diag = (id: string, reason: ReasonPreparacao) => portas.diagnosticar?.(id, reason);
  const testar = (midia: T, signal: AbortSignal) => limitar(() => portas.verificar(midia), prazos.preflight, signal).catch(() => false);
  try {
    portas.iniciar?.(0);
    if (atual && ativa() && await testar(atual, busca.signal) && ativa()) { diag(portas.idAtual, "compatible"); return atual; }
    if (!ativa()) return null;
    diag(portas.idAtual, "current_incompatible");
    let esperandoDesde = 0;
    for (let index = 0; ativa(); index++) {
      if (portas.fontesAtuais) adicionar(portas.fontesAtuais());
      const fonte = fila[index];
      if (!fonte) {
        if (!portas.fontesPendentes?.()) break;
        esperandoDesde ||= Date.now();
        if (Date.now() - esperandoDesde >= prazos.fontes) break;
        await limitar(() => new Promise<void>(r => setTimeout(r, 100)), 200, busca.signal).catch(() => {});
        index--;
        continue;
      }
      esperandoDesde = 0;
      const id = portas.id(fonte);
      if (vistas.has(id)) continue;
      vistas.add(id);
      portas.iniciar?.(vistas.size);
      const candidata = new AbortController();
      const cancelar = () => candidata.abort();
      busca.signal.addEventListener("abort", cancelar, { once: true });
      try {
        const midia = await limitar(async () => {
          const resolvida = await portas.resolver(fonte, candidata.signal, adicionar, m => testar(m, candidata.signal));
          if (!resolvida || candidata.signal.aborted || !ativa()) return null;
          return await testar(resolvida, candidata.signal) ? resolvida : null;
        }, prazos.candidata, busca.signal);
        if (!ativa()) return null;
        if (midia) { diag(id, "compatible"); return midia; }
        diag(id, "preflight_failed");
      } catch (erro) {
        if (!ativa()) return null;
        diag(id, erro instanceof PrazoPreparacao ? "resolve_timeout" : (erro as { code?: string })?.code === "preflight_failed" ? "preflight_failed" : "resolve_failed");
      } finally { candidata.abort(); busca.signal.removeEventListener("abort", cancelar); }
    }
    return null;
  } finally { clearTimeout(teto); portas.signal?.removeEventListener("abort", abortar); busca.abort(); }
}

/** Consome rejeições de play() tanto nativo quanto JW, inclusive após teardown. */
export function controlarMidia(acao: () => unknown, absorver = true): void {
  if (!absorver) { acao(); return; }
  try { Promise.resolve(acao()).catch(() => {}); } catch { /* player já removido */ }
}
