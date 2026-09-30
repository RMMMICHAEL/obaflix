export const VERSAO_MINIMA_DESKTOP = "1.0.12";

export const DESKTOP_UPDATE_READY_EVENT =
  "obaflix:desktop-update-ready";

/**
 * URL final reservada para a migração obrigatória das versões antigas.
 *
 * IMPORTANTE:
 * o bloqueio não deve chegar à Production antes de este arquivo existir
 * publicamente e ter sido validado por SHA256/Authenticode.
 *
 * A landing pública continua apontando para a versão anterior até o gate
 * de homologação real ser concluído.
 */
export const DOWNLOAD_ATUALIZACAO_DESKTOP =
  "https://app.obaflix.online/Obaflix-Setup-1.0.12.exe";

type VersaoSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseVersao(valor: string): VersaoSemver | null {
  const normalizada = String(valor || "").trim().replace(/^v/i, "");

  const match = normalizada.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );

  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compararIdentificadorPrerelease(a: string, b: string): number {
  const aNumerico = /^\d+$/.test(a);
  const bNumerico = /^\d+$/.test(b);

  if (aNumerico && bNumerico) {
    const numeroA = Number(a);
    const numeroB = Number(b);

    if (numeroA < numeroB) return -1;
    if (numeroA > numeroB) return 1;
    return 0;
  }

  if (aNumerico && !bNumerico) return -1;
  if (!aNumerico && bNumerico) return 1;

  return a.localeCompare(b);
}

/**
 * Retorna:
 * - -1 quando a < b
 * -  0 quando a === b
 * -  1 quando a > b
 * - null para entradas que não são SemVer simples válidas
 */
export function compararVersoesSemver(
  a: string,
  b: string,
): -1 | 0 | 1 | null {
  const esquerda = parseVersao(a);
  const direita = parseVersao(b);

  if (!esquerda || !direita) return null;

  for (const campo of ["major", "minor", "patch"] as const) {
    if (esquerda[campo] < direita[campo]) return -1;
    if (esquerda[campo] > direita[campo]) return 1;
  }

  const preA = esquerda.prerelease;
  const preB = direita.prerelease;

  // Pela regra SemVer, uma versão estável é superior à prerelease
  // que possui o mesmo major.minor.patch.
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;

  const limite = Math.max(preA.length, preB.length);

  for (let i = 0; i < limite; i += 1) {
    const itemA = preA[i];
    const itemB = preB[i];

    if (itemA === undefined) return -1;
    if (itemB === undefined) return 1;

    const comparacao = compararIdentificadorPrerelease(itemA, itemB);

    if (comparacao < 0) return -1;
    if (comparacao > 0) return 1;
  }

  return 0;
}

export function desktopPrecisaAtualizar(
  versaoAtual: string,
  versaoMinima = VERSAO_MINIMA_DESKTOP,
): boolean {
  const comparacao = compararVersoesSemver(
    versaoAtual,
    versaoMinima,
  );

  // Uma resposta inválida não pode prender navegador/Android/TV
  // numa tela sem saída. O bloqueio só acontece após versão Electron
  // válida e comprovadamente inferior à mínima.
  return comparacao !== null && comparacao < 0;
}