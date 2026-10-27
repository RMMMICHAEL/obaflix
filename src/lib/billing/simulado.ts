import crypto from "crypto";
import { getRedis } from "@/lib/redis";
import { criarConfirmadorBlackcat, criarProvedorBlackcat, type ResultadoConfirmacaoBlackcat, type StatusBlackcat } from "./blackcat";
import { cobrancaPixAtiva, type ProvedorPix } from "./pedidos";
import { caktoPixAtivo, criarConfirmadorCakto, criarProvedorCakto, OFERTAS_CAKTO } from "./cakto";

/**
 * Pagamento SIMULADO para o ambiente isolado de testes.
 *
 * Existe porque a documentação pública da Blackcat não oferece sandbox e nenhum
 * PIX real está autorizado. Não valida a integração com o provedor — só deixa
 * o resto do fluxo (pedido, confirmação, ativação, revisão, estorno) rodar com
 * o mesmo código de produção.
 *
 * Ligada somente com as três condições juntas. Qualquer uma ausente devolve o
 * provedor real — que, sem chave, recusa cobrar.
 */
export function simulacaoDePagamentoAtiva(env: Record<string, string | undefined> = process.env): boolean {
  return env.PAGAMENTO_SIMULADO === "true" && env.OBAFLIX_AMBIENTE === "teste" && env.VERCEL_ENV !== "production";
}

type RedisMinimo = { get(chave: string): Promise<string | null>; set(chave: string, valor: string, opts?: { ex?: number }): Promise<unknown> };

const TTL_VENDA_SEG = 7 * 24 * 3600;
const PREFIXO = "simulado:venda:";

interface VendaSimulada { status: StatusBlackcat; amount: number; paidAt: string | null }

export function criarProvedorSimulado(redis: RedisMinimo = getRedis(), agora: () => Date = () => new Date()): ProvedorPix {
  return {
    async criarVenda(pedido) {
      const transacaoId = `sim_${crypto.randomBytes(12).toString("hex")}`;
      const venda: VendaSimulada = { status: "PENDING", amount: pedido.valorCentavos, paidAt: null };
      await redis.set(PREFIXO + transacaoId, JSON.stringify(venda), { ex: TTL_VENDA_SEG });
      return {
        ok: true,
        venda: {
          transacaoId,
          valorCentavos: pedido.valorCentavos,
          expiraEm: new Date(agora().getTime() + 30 * 60_000),
          // Não pagável: não é um código PIX.
          qrCode: "PAGAMENTO-SIMULADO-NAO-PAGAVEL",
          copiaECola: "PAGAMENTO-SIMULADO-NAO-PAGAVEL",
          qrCodeBase64: null,
        },
      };
    },
  };
}

export function criarConfirmadorSimulado(redis: RedisMinimo = getRedis()) {
  return async (transacaoId: string): Promise<ResultadoConfirmacaoBlackcat> => {
    const bruto = await redis.get(PREFIXO + transacaoId);
    if (!bruto) return { ok: false, falha: "nao_encontrada" };
    const v = JSON.parse(bruto) as VendaSimulada;
    return { ok: true, confirmacao: { transactionId: transacaoId, status: v.status, amount: v.amount, paidAt: v.paidAt ? new Date(v.paidAt) : null } };
  };
}

export const STATUS_SIMULAVEIS: readonly StatusBlackcat[] = ["PENDING", "PAID", "CANCELLED", "REFUNDED"];

/** Muda o estado de uma venda simulada que já existe. `valorCentavos` só para testar divergência. */
export async function definirStatusSimulado(
  redis: RedisMinimo,
  transacaoId: string,
  status: StatusBlackcat,
  valorCentavos: number | undefined,
  agora: Date,
): Promise<boolean> {
  const bruto = await redis.get(PREFIXO + transacaoId);
  if (!bruto) return false;
  const v = JSON.parse(bruto) as VendaSimulada;
  const novo: VendaSimulada = {
    status,
    amount: Number.isInteger(valorCentavos) && (valorCentavos as number) > 0 ? (valorCentavos as number) : v.amount,
    paidAt: status === "PAID" ? agora.toISOString() : v.paidAt,
  };
  await redis.set(PREFIXO + transacaoId, JSON.stringify(novo), { ex: TTL_VENDA_SEG });
  return true;
}

/**
 * Provedor usado pela rota de pedidos. Cakto só para planos Cortes com oferta e
 * `CAKTO_PIX_ATIVO=true`; o resto segue Blackcat (ou a simulação), que exige
 * `BLACKCAT_PIX_ATIVO=true`. Sem provedor ligado para o plano: `null` → 503.
 */
export function provedorDeCobranca(env: Record<string, string | undefined> = process.env, planoId?: string): { provedor: ProvedorPix | null; nome: "blackcat" | "simulado" | "cakto" } {
  if (!simulacaoDePagamentoAtiva(env) && caktoPixAtivo(env) && planoId && OFERTAS_CAKTO[planoId]) return { provedor: criarProvedorCakto(env), nome: "cakto" };
  if (!cobrancaPixAtiva(env)) return { provedor: null, nome: "blackcat" };
  return simulacaoDePagamentoAtiva(env)
    ? { provedor: criarProvedorSimulado(), nome: "simulado" }
    : { provedor: criarProvedorBlackcat(env), nome: "blackcat" };
}

/** Confirmador pelo provedor gravado no pedido: pedido Cakto nunca é consultado na Blackcat, e vice-versa. */
export function confirmadorDoPedido(provedor: string, env: Record<string, string | undefined> = process.env) {
  return provedor === "cakto" ? criarConfirmadorCakto(env) : confirmadorDeCobranca(env);
}

/** Confirmador usado pela confirmação, reconciliação e revisão. */
export function confirmadorDeCobranca(env: Record<string, string | undefined> = process.env) {
  return simulacaoDePagamentoAtiva(env) ? criarConfirmadorSimulado() : criarConfirmadorBlackcat(env);
}
