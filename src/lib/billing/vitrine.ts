/**
 * A vitrine comercial: como cada plano é apresentado ao público.
 *
 * ## Uma fonte só
 *
 * TV, página `/planos` e checkout leem esta projeção pela mesma resposta de
 * `GET /api/billing/plans`. Nenhum cliente guarda tabela própria de benefícios
 * ou de preços: os benefícios saem **dos direitos gravados em `Plano`** e os
 * preços **das linhas ativas de `PlanoPreco`**. Mudar um direito no banco muda
 * o que se anuncia; não existe um segundo lugar para esquecer de atualizar.
 *
 * ## Apresentação, não autorização
 *
 * Nome público, tema, selo e suporte são escolhidos por id de plano — é texto e
 * cor de vitrine. Nenhuma decisão de acesso usa isto: quem decide é o direito,
 * no servidor, em cada rota protegida.
 *
 * ## Informação comercial × limite técnico
 *
 * `resolucaoMax` é gravado e **não é aplicado** por nenhuma rota
 * (`direitosAplicados.ts`). Por isso a qualidade é anunciada como "Suporte a…"
 * e nunca como limite. O servidor VIP não aparece enquanto o direito não existir
 * e não estiver protegido (`SERVIDOR_VIP_NA_VITRINE`).
 */

export type TemaDoPlano = "azul" | "roxo" | "ambar" | "verde" | "ciano" | "rosa";

/** Cor de destaque e cor do texto sobre ela, por tema. Única tabela usada por /planos e /checkout. */
export const TONS_DOS_TEMAS: Record<TemaDoPlano, { cor: string; texto: string }> = {
  azul: { cor: "#4C8DFF", texto: "#FFFFFF" },
  roxo: { cor: "#A66BFF", texto: "#FFFFFF" },
  ambar: { cor: "#F5B82E", texto: "#1A1206" },
  verde: { cor: "#34D399", texto: "#052016" },
  ciano: { cor: "#22D3EE", texto: "#04222A" },
  rosa: { cor: "#F472B6", texto: "#2A0A1C" },
};

export interface BeneficioDaVitrine {
  texto: string;
  /** `false` para o que o plano não inclui — a interface mostra apagado. */
  incluido: boolean;
}

export interface PlanoDaVitrine {
  nome: string;
  tema: TemaDoPlano | null;
  selo: string | null;
  /** Cortes é assinatura à parte: vitrine, ordem e upgrade separados dos tradicionais. */
  familia: "tradicional" | "cortes";
  beneficios: BeneficioDaVitrine[];
}

/** O mínimo de `Plano` que a vitrine lê. */
export interface LinhaDaVitrine {
  id: string;
  nome: string;
  telasMax: number;
  filmes: boolean;
  series: boolean;
  resolucaoMax: string;
  anunciosObrigatorios: boolean;
  downloads: boolean;
  canaisNivel: string;
  /** "nenhum" (ou ausente) nos planos tradicionais. */
  cortesNivel?: string | null;
  /** Há preço ativo de tela adicional para este plano. */
  telasAdicionaisDisponiveis?: boolean;
}

/** Nomes públicos. Os ids internos continuam os mesmos. */
const NOMES_PUBLICOS: Record<string, string> = {
  gratuito: "Gratuito",
  basic: "Básico",
  plus: "Plus",
  premium: "Premium",
};

const TEMAS: Record<string, TemaDoPlano> = {
  basic: "azul", plus: "roxo", premium: "ambar",
  "cortes-start": "verde", "cortes-pro": "ciano", "cortes-ai": "rosa",
};

const SELOS: Record<string, string> = {
  plus: "Mais escolhido", premium: "Experiência completa",
  "cortes-pro": "Cortes em lote", "cortes-ai": "IA em breve",
};

/** O que cada nível de Cortes libera hoje (playbackAuthorization). IA ainda não opera. */
const CORTES: Record<string, BeneficioDaVitrine[]> = {
  individual: [
    { texto: "Cortes individuais", incluido: true },
    { texto: "Cortes em lote", incluido: false },
  ],
  lote: [
    { texto: "Cortes individuais", incluido: true },
    { texto: "Cortes em lote", incluido: true },
  ],
  ia: [
    { texto: "Cortes individuais", incluido: true },
    { texto: "Cortes em lote", incluido: true },
    { texto: "Cortes com IA (em breve)", incluido: false },
  ],
};

/** Processo de atendimento, não direito técnico. */
const SUPORTE: Record<string, string> = {
  basic: "Suporte padrão",
  plus: "Suporte",
  premium: "Suporte prioritário",
};

const QUALIDADE: Record<string, string> = {
  sd: "Qualidade SD",
  hd: "Suporte a HD",
  fhd: "Suporte a Full HD",
  "4k": "Suporte a até 4K quando disponível",
};

const CANAIS: Record<string, BeneficioDaVitrine> = {
  nenhum: { texto: "Sem canais de TV", incluido: false },
  gratuito: { texto: "Canais gratuitos", incluido: true },
  plus: { texto: "Canais até o nível Plus", incluido: true },
  premium: { texto: "Canais até o nível Premium", incluido: true },
};

/**
 * O servidor VIP só entra na vitrine quando existir o direito `servidorVip` e a
 * filtragem das fontes premium estiver ligada no servidor. Hoje, nenhum dos
 * dois — ver `src/lib/servidorVip.ts` e `docs/planos-comerciais.md`.
 */
export const SERVIDOR_VIP_NA_VITRINE = false;

/**
 * O adicional avulso de VIP (Básico) segue a mesma decisão: enquanto o VIP estiver
 * fora da vitrine, o checkout recusa comprá-lo, mesmo com preço cadastrado.
 */
export const SERVIDOR_VIP_AVULSO_OFERTADO = SERVIDOR_VIP_NA_VITRINE;

/** Espelho de `TELAS_ADICIONAIS_MAX` (precificacao.ts), para o texto da vitrine. */
const TELAS_ADICIONAIS_NO_TEXTO = 2;

export function nomePublicoDoPlano(id: string, nomeDoBanco: string): string {
  return NOMES_PUBLICOS[id] ?? nomeDoBanco;
}

/**
 * A vitrine de um plano. Função pura.
 *
 * Os benefícios seguem sempre a mesma ordem — telas, catálogo, qualidade,
 * anúncios, downloads, canais, suporte — para os cards se alinharem.
 */
export function vitrineDoPlano(linha: LinhaDaVitrine): PlanoDaVitrine {
  const cortes = linha.cortesNivel && linha.cortesNivel !== "nenhum" ? CORTES[linha.cortesNivel] ?? [] : null;
  const beneficios: BeneficioDaVitrine[] = cortes ? [...cortes] : [];

  beneficios.push({
    texto: linha.telasMax === 1 ? "1 tela" : `${linha.telasMax} telas simultâneas`,
    incluido: true,
  });
  if (linha.telasAdicionaisDisponiveis === true) {
    beneficios.push({ texto: `Até ${TELAS_ADICIONAIS_NO_TEXTO} telas adicionais`, incluido: true });
  }
  beneficios.push({ texto: "Filmes e séries", incluido: linha.filmes === true && linha.series === true });

  const qualidade = QUALIDADE[linha.resolucaoMax];
  if (qualidade) beneficios.push({ texto: qualidade, incluido: true });

  beneficios.push(
    linha.anunciosObrigatorios === false
      ? { texto: "Sem anúncios", incluido: true }
      : { texto: "Com anúncios na reprodução", incluido: false },
  );

  // Download completo vale para todo plano; `downloads` é a isenção do anúncio nele.
  beneficios.push(
    linha.downloads === true
      ? { texto: "Downloads sem anúncios", incluido: true }
      : { texto: "Downloads com anúncios", incluido: true },
  );

  const canais = CANAIS[linha.canaisNivel];
  if (canais) beneficios.push(canais);

  const suporte = SUPORTE[linha.id];
  if (suporte) beneficios.push({ texto: suporte, incluido: true });

  return {
    nome: nomePublicoDoPlano(linha.id, linha.nome),
    tema: TEMAS[linha.id] ?? null,
    selo: SELOS[linha.id] ?? null,
    familia: cortes ? "cortes" : "tradicional",
    beneficios,
  };
}
