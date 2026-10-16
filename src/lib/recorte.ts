/** Texto de edição independente do intervalo numérico. */
export function mascararTempo(texto: string): string {
  const digitos = texto.replace(/\D/g, "").slice(0, 6);
  if (digitos.length <= 2) return digitos;
  if (digitos.length <= 4) return `${digitos.slice(0, -2)}:${digitos.slice(-2)}`;
  return `${digitos.slice(0, -4)}:${digitos.slice(-4, -2)}:${digitos.slice(-2)}`;
}

export function segundosDoTexto(texto: string): number | null {
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(texto)) return null;
  const partes = texto.split(":").map(Number);
  if (partes.slice(1).some((p) => p >= 60)) return null;
  return partes.reduce((total, n) => total * 60 + n, 0);
}

export function textoDoTempo(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos));
  const ss = String(s % 60).padStart(2, "0");
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  return s >= 3600 ? `${String(Math.floor(s / 3600)).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function ajustarIntervalo(qual: "inicio" | "fim", valor: number, inicio: number, fim: number, duracao: number) {
  const total = Math.max(1, duracao);
  if (qual === "inicio") {
    inicio = Math.max(0, Math.min(total - 1, valor));
    fim = Math.min(total, Math.max(fim, inicio + 1));
  } else {
    inicio = Math.max(0, Math.min(total - 1, inicio));
    fim = Math.min(total, Math.max(inicio + 1, valor));
  }
  return { inicio, fim };
}

export interface Cena { inicio: number; fim: number }

function montarCena(a: string | undefined, b: string | undefined, total: number): Cena | null {
  if (a === undefined || b === undefined) return null;
  const inicio = segundosDoTexto(a);
  const fim = segundosDoTexto(b);
  if (inicio === null || fim === null || inicio < 0) return null;
  if (total > 0 && inicio >= total) return null;
  const fimReal = total > 0 ? Math.min(fim, total) : fim;
  if (fimReal <= inicio) return null;
  return { inicio, fim: fimReal };
}

/**
 * Converte texto colado em cenas válidas. Aceita intervalos "mm:ss-mm:ss"
 * (um por linha e/ou separados por vírgula na mesma linha) e também horários
 * sem traço separados por vírgula, pareados em sequência ("00:10, 00:20"). Cada
 * cena é validada contra o formato de horário e clampada na duração; início fora
 * da mídia, fim ≤ início ou horário malformado são descartados. Devolve as cenas
 * válidas e quantas entradas foram ignoradas, para a interface avisar.
 */
export function parsearCenas(texto: string, duracao: number): { cenas: Cena[]; ignoradas: number } {
  const total = Math.max(0, Math.floor(duracao));
  const cenas: Cena[] = [];
  let ignoradas = 0;
  for (const linha of String(texto).replace(/[–—]/g, "-").split(/\r?\n/)) {
    const bruto = linha.trim();
    if (!bruto) continue;
    if (bruto.includes("-")) {
      for (const parte of bruto.split(",")) {
        const t = parte.trim();
        if (!t) continue;
        const [a, b, ...resto] = t.split("-").map((x) => x.trim());
        const cena = resto.length ? null : montarCena(a, b, total);
        if (cena) cenas.push(cena); else ignoradas++;
      }
    } else {
      const tempos = bruto.split(",").map((x) => x.trim()).filter(Boolean);
      for (let i = 0; i < tempos.length; i += 2) {
        const cena = montarCena(tempos[i], tempos[i + 1], total);
        if (cena) cenas.push(cena); else ignoradas++;
      }
    }
  }
  return { cenas, ignoradas };
}

/** Cursor fica junto ao mesmo dígito depois de inserir/remover separadores. */
export function cursorDaMascara(texto: string, cursor: number, resultado: string): number {
  const quantidade = texto.slice(0, cursor).replace(/\D/g, "").length;
  if (!quantidade) return 0;
  let vistos = 0;
  for (let i = 0; i < resultado.length; i++) {
    if (/\d/.test(resultado[i]) && ++vistos === quantidade) return i + 1;
  }
  return resultado.length;
}
