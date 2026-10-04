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
