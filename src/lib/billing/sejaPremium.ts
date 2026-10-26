import { PLANO_SEJA_PREMIUM_ID } from "./vitrine";

/**
 * Cadastro do plano "SEJA PREMIUM": direitos do Gratuito (lidos da linha viva, não de uma constante), sem anúncios,
 * R$ 10,00 por 30 dias, pagamento único. Função pura: o script decide o que gravar, aqui só se calcula.
 */
export const PRECO_SEJA_PREMIUM = {
  id: "preco-seja-premium-30d",
  rotulo: "30 dias",
  duracaoDias: 30,
  duracaoMeses: null as number | null,
  precoCentavos: 1000,
  moeda: "BRL",
  ativo: true,
  ordem: 0,
} as const;

/** Campos do Gratuito que o novo plano NÃO herda: identidade, posição, estado e o único direito que muda. */
const NAO_HERDADOS = ["id", "nome", "descricao", "ordem", "ativo", "ehPadrao", "anunciosObrigatorios", "criadoEm", "atualizadoEm"];

type Linha = Record<string, unknown>;

export function dadosDoPlanoSejaPremium(gratuito: Linha): Linha {
  const herdado = Object.fromEntries(Object.entries(gratuito).filter(([campo]) => !NAO_HERDADOS.includes(campo)));
  return {
    ...herdado,
    id: PLANO_SEJA_PREMIUM_ID,
    nome: "SEJA PREMIUM",
    descricao: "Remove os anúncios. Demais direitos iguais ao plano Gratuito.",
    // Abaixo do Básico (1): comprar o Básico depois é upgrade imediato. O Gratuito (0) não é assinatura, não compete.
    ordem: 0,
    ativo: true,
    ehPadrao: false,
    anunciosObrigatorios: false,
    episodiosPorAnuncio: null,
  };
}

export type AcaoSejaPremium =
  | { tipo: "gratuito_ausente" }
  | { tipo: "criar_plano"; dados: Linha }
  | { tipo: "plano_ja_existe"; divergencias: string[] }
  | { tipo: "criar_preco"; dados: Record<string, unknown> }
  | { tipo: "preco_ja_correto" }
  | { tipo: "conflito_de_preco"; noBanco: number };

export function planejarSejaPremium(entrada: {
  gratuito: Linha | null;
  plano: Linha | null;
  preco: { precoCentavos: number; duracaoDias: number | null; moeda: string } | null;
}): AcaoSejaPremium[] {
  if (!entrada.gratuito) return [{ tipo: "gratuito_ausente" }];
  const acoes: AcaoSejaPremium[] = [];
  const esperado = dadosDoPlanoSejaPremium(entrada.gratuito);
  if (!entrada.plano) {
    acoes.push({ tipo: "criar_plano", dados: esperado });
  } else {
    const divergencias = Object.entries(esperado)
      .filter(([campo, valor]) => campo !== "descricao" && JSON.stringify(entrada.plano![campo]) !== JSON.stringify(valor))
      .map(([campo]) => campo);
    acoes.push({ tipo: "plano_ja_existe", divergencias });
  }
  if (!entrada.preco) {
    acoes.push({ tipo: "criar_preco", dados: { ...PRECO_SEJA_PREMIUM, planoId: PLANO_SEJA_PREMIUM_ID } });
  } else if (
    entrada.preco.precoCentavos === PRECO_SEJA_PREMIUM.precoCentavos &&
    entrada.preco.duracaoDias === PRECO_SEJA_PREMIUM.duracaoDias &&
    entrada.preco.moeda === PRECO_SEJA_PREMIUM.moeda
  ) {
    acoes.push({ tipo: "preco_ja_correto" });
  } else {
    acoes.push({ tipo: "conflito_de_preco", noBanco: entrada.preco.precoCentavos });
  }
  return acoes;
}

/** Nunca grava sem o Gratuito para herdar, nem sobre um preço divergente. Plano existente divergente também trava. */
export function podeAplicarSejaPremium(acoes: AcaoSejaPremium[]): boolean {
  return !acoes.some(
    (a) =>
      a.tipo === "gratuito_ausente" ||
      a.tipo === "conflito_de_preco" ||
      (a.tipo === "plano_ja_existe" && a.divergencias.length > 0),
  );
}
