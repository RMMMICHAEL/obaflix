/**
 * Total de uma compra: plano na duração escolhida + adicionais. Módulo puro.
 *
 * ## Regras aprovadas (2026-09-13)
 *
 * - Telas adicionais: no máximo 2 (até 4 telas no total), preço **mensal** por
 *   tela, acompanham a duração inteira da assinatura.
 * - Servidor VIP avulso: preço **mensal**, acompanha a duração inteira; só para
 *   plano cujo direito não inclui VIP. Continua **fora da oferta** até o direito
 *   `servidorVip` existir e estar protegido.
 * - Cupom: indisponível nesta fase.
 *
 * O preço de cada adicional vem do banco, por plano. Nenhum valor é decidido
 * aqui nem enviado pelo cliente.
 */

import { mesesCobraveis, type Duracao } from "./vigencia";

export const TELAS_ADICIONAIS_MAX = 2;

export interface PrecosDosAdicionais {
  /** Preço mensal por tela extra; `null` quando não há preço ativo. */
  telaMensalCentavos: number | null;
  /** Preço mensal do VIP avulso; `null` quando não há preço ativo. */
  servidorVipMensalCentavos: number | null;
}

export type ResultadoDoTotal =
  | {
      ok: true;
      meses: number;
      baseCentavos: number;
      telasCentavos: number;
      servidorVipCentavos: number;
      totalCentavos: number;
    }
  | {
      ok: false;
      codigo: "duracao_invalida" | "telas_acima_do_limite" | "adicional_indisponivel" | "servidor_vip_ja_incluso" | "parametros_invalidos";
    };

function centavosValidos(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export function calcularTotal(entrada: {
  precoPlanoCentavos: number;
  duracao: Duracao;
  telasAdicionais: number;
  servidorVip: boolean;
  /** Direito do plano, do banco. Nunca nome do plano. */
  planoIncluiServidorVip: boolean;
  /** Se o VIP avulso está ofertado. Hoje `false`. */
  servidorVipOfertado: boolean;
  adicionais: PrecosDosAdicionais;
}): ResultadoDoTotal {
  if (!centavosValidos(entrada.precoPlanoCentavos)) return { ok: false, codigo: "parametros_invalidos" };
  const telas = entrada.telasAdicionais;
  if (!Number.isInteger(telas) || telas < 0) return { ok: false, codigo: "parametros_invalidos" };
  if (telas > TELAS_ADICIONAIS_MAX) return { ok: false, codigo: "telas_acima_do_limite" };

  // Adicional mensal só se multiplica por duração que tenha meses cobráveis.
  // Sem adicional, um preço legado em dias (ex.: 180) continua comprável.
  const meses = mesesCobraveis(entrada.duracao);
  if (meses === null) {
    if (telas > 0 || entrada.servidorVip) return { ok: false, codigo: "duracao_invalida" };
    const base = entrada.precoPlanoCentavos;
    return { ok: true, meses: 0, baseCentavos: base, telasCentavos: 0, servidorVipCentavos: 0, totalCentavos: base };
  }

  let telasCentavos = 0;
  if (telas > 0) {
    if (!centavosValidos(entrada.adicionais.telaMensalCentavos)) return { ok: false, codigo: "adicional_indisponivel" };
    telasCentavos = entrada.adicionais.telaMensalCentavos * telas * meses;
  }

  let servidorVipCentavos = 0;
  if (entrada.servidorVip) {
    if (entrada.planoIncluiServidorVip) return { ok: false, codigo: "servidor_vip_ja_incluso" };
    if (!entrada.servidorVipOfertado || !centavosValidos(entrada.adicionais.servidorVipMensalCentavos)) {
      return { ok: false, codigo: "adicional_indisponivel" };
    }
    servidorVipCentavos = entrada.adicionais.servidorVipMensalCentavos * meses;
  }

  const totalCentavos = entrada.precoPlanoCentavos + telasCentavos + servidorVipCentavos;
  return { ok: true, meses, baseCentavos: entrada.precoPlanoCentavos, telasCentavos, servidorVipCentavos, totalCentavos };
}
