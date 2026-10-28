import crypto from "crypto";
import type { PedidoParaProvedor, ProvedorPix, ResultadoCriacaoPix } from "./pedidos";
import type { ResultadoConfirmacaoBlackcat, StatusBlackcat } from "./blackcat";

/**
 * Pix da Cakto para o Obaflix Cortes (pagamento único, 30 dias, sem recorrência).
 *
 * Mesmo contrato da Blackcat: a criação só devolve o Pix — nunca concede nada —
 * e o direito nasce em `confirmarPedidoPorId`, depois de `GET /orders/{id}/`
 * autenticado. O id do pedido Cakto é o `transacaoId` (não o `externalId` da
 * adquirente). Documentação: https://docs.cakto.com.br/llms.txt
 */
export const BASE_CAKTO = "https://api.cakto.com.br/public_api";
export const TIMEOUT_CAKTO_MS = 15_000;

/** Oferta fixa da Cakto por plano. O valor cobrado é o da oferta: nada dinâmico. */
export const OFERTAS_CAKTO: Readonly<Record<string, { oferta: string; centavos: number }>> = {
  "cortes-start": { oferta: "5g29gxj", centavos: 2700 },
  "cortes-pro": { oferta: "zfuzuex", centavos: 4700 },
  "cortes-ai": { oferta: "33bgxsx", centavos: 19700 },
};

type Env = Record<string, string | undefined>;

/** Só a string exata "true" liga (mesmo critério de `cobrancaPixAtiva`). */
export function caktoPixAtivo(env: Env = process.env): boolean {
  return env.CAKTO_PIX_ATIVO === "true";
}

/** Piloto Cakto: somente Start com token privado; sem configuracao, recusa. */
export function pilotoCaktoAutorizado(planoId: string, tokenRecebido: string | null, env: Env = process.env): boolean {
  if (env.CAKTO_VENDAS_PUBLICAS === "true") return true;
  if (planoId !== "cortes-start") return false;
  const esperado = Buffer.from(env.CAKTO_PILOTO_TOKEN ?? "");
  const recebido = Buffer.from(tokenRecebido ?? "");
  return esperado.length >= 32 && esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}

/** Piloto do checkout web: admin de sessão por cookie E papel confirmado no banco.
 * O token privado permanece exclusivo do servidor; nenhuma credencial vai para JS ou URL.
 * Não libera visitantes, Pro ou AI, e não interfere no modo público (controlado pela flag).
 */
export function pilotoCaktoAdminPermitido(
  planoId: string,
  usuario: { origem?: string; role?: string } | null,
  roleBanco: string | null | undefined,
  env: Env = process.env,
): boolean {
  return planoId === "cortes-start" && env.CAKTO_VENDAS_PUBLICAS !== "true" &&
    (env.CAKTO_PILOTO_TOKEN?.length ?? 0) >= 32 &&
    usuario?.origem === "cookie" && usuario.role === "admin" && roleBanco === "admin";
}

export interface ConfiguracaoCakto { clientId: string; clientSecret: string }
export function lerConfiguracaoCakto(env: Env = process.env): ConfiguracaoCakto | null {
  const clientId = env.CAKTO_CLIENT_ID?.trim(), clientSecret = env.CAKTO_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Só Cortes, só o valor exato da oferta e sem adicionais: upgrade com crédito
 * (valor dinâmico) não cabe numa oferta fixa e é recusado antes de virar pedido.
 */
export function caktoAceitaCompra(c: { planoId: string; valorCentavos: number; moeda: string }): boolean {
  const o = OFERTAS_CAKTO[c.planoId];
  return !!o && c.moeda === "BRL" && c.valorCentavos === o.centavos;
}

/** "49.90" → 4990. Recusa tudo que não for decimal com até 2 casas. */
export function reaisParaCentavos(valor: unknown): number | null {
  const s = typeof valor === "number" ? String(valor) : typeof valor === "string" ? valor.trim() : "";
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(s);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
}

/** E.164 sem "+": 11 ou 10 dígitos do Brasil ganham o 55; já com 55 fica como está. */
export function telefoneE164(telefone: string): string | null {
  const d = telefone.replace(/\D/g, "");
  if (/^\d{10,11}$/.test(d)) return `55${d}`;
  return /^55\d{10,11}$/.test(d) ? d : null;
}

/** Fingerprint estável por pedido e sem dado pessoal: hash da nossa referência. */
export const fingerprintDoPedido = (refExterna: string) =>
  crypto.createHash("sha256").update(`obaflix-cakto:${refExterna}`).digest("hex").slice(0, 32);

const ehTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/**
 * Token OAuth2 (client credentials) reaproveitado até perto de expirar.
 * shortcut: cache por instância do servidor; cada instância pede o próprio token. Trocar por Redis se o volume exigir.
 */
export function criarTokenCakto(config: ConfiguracaoCakto, buscar: typeof fetch = fetch, agora: () => number = Date.now) {
  let cache: { token: string; expira: number } | null = null;
  return async (): Promise<{ ok: true; token: string } | { ok: false; falha: "timeout" | "rede" | "recusado" | "indisponivel" }> => {
    if (cache && cache.expira > agora()) return { ok: true, token: cache.token };
    let r: Response;
    try {
      r = await buscar(`${BASE_CAKTO}/token/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret }),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_CAKTO_MS),
      });
    } catch (e) { return { ok: false, falha: ehTimeout(e) ? "timeout" : "rede" }; }
    if (!r.ok) return { ok: false, falha: r.status >= 500 || r.status === 429 ? "indisponivel" : "recusado" };
    const j = await r.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof j?.access_token !== "string" || !j.access_token) return { ok: false, falha: "indisponivel" };
    const segundos = typeof j.expires_in === "number" && j.expires_in > 120 ? j.expires_in : 600;
    cache = { token: j.access_token, expira: agora() + (segundos - 60) * 1000 };
    return { ok: true, token: cache.token };
  };
}

/** "2026-04-29 01:30:00+00:00" ou ISO → Date válida no futuro do pedido, ou null. */
const dataCakto = (v: unknown) => {
  if (typeof v !== "string") return null;
  const d = new Date(v.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
};

export function provedorCakto(config: ConfiguracaoCakto, buscar: typeof fetch = fetch, token = criarTokenCakto(config, buscar)): ProvedorPix & { aceitaCompra: typeof caktoAceitaCompra } {
  return {
    aceitaCompra: caktoAceitaCompra,
    async criarVenda(pedido: PedidoParaProvedor): Promise<ResultadoCriacaoPix> {
      const oferta = pedido.planoId ? OFERTAS_CAKTO[pedido.planoId] : undefined;
      const telefone = telefoneE164(pedido.pagador.telefone);
      // Defesa: a rota já recusou isto em `aceitaCompra`; aqui nunca se cobra valor fora da oferta.
      if (!oferta || pedido.valorCentavos !== oferta.centavos || pedido.moeda !== "BRL" || !telefone) return { ok: false, falha: "configuracao" };
      const t = await token();
      if (!t.ok) return { ok: false, falha: t.falha };
      let r: Response;
      try {
        r = await buscar(`${BASE_CAKTO}/payments/`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${t.token}`,
            "Content-Type": "application/json",
            // `refExterna` já está gravada no pedido CRIADO: a mesma chave em qualquer reenvio deste pedido.
            "X-Idempotency-Key": pedido.refExterna,
          },
          body: JSON.stringify({
            paymentMethod: "pix",
            customer: {
              name: pedido.pagador.nome,
              email: pedido.pagador.email,
              phone: telefone,
              fingerprint: fingerprintDoPedido(pedido.refExterna),
              docType: pedido.pagador.documento.tipo,
              docNumber: pedido.pagador.documento.numero,
            },
            items: [{ offerId: oferta.oferta, quantity: 1 }],
            metadata: { sck: pedido.refExterna },
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(TIMEOUT_CAKTO_MS),
        });
      } catch (e) { return { ok: false, falha: ehTimeout(e) ? "timeout" : "rede", criacaoIncerta: true }; }
      if (!r.ok) return { ok: false, falha: r.status >= 500 || r.status === 429 ? "indisponivel" : "recusado", ...(r.status >= 500 || [408, 429].includes(r.status) ? { criacaoIncerta: true } : {}) };
      const j = await r.json().catch(() => null) as Record<string, any> | null;
      const id = typeof j?.id === "string" && j.id.trim() ? j.id.trim() : null;
      if (!id) return { ok: false, falha: "resposta_invalida", criacaoIncerta: true };
      const expiraEm = dataCakto(j?.pix?.expirationDate);
      const valorCentavos = reaisParaCentavos(j?.amount);
      // Pedido existe lá, mas não é o que pedimos: revisão manual, nunca uso.
      if (j?.status !== "waiting_payment" || j?.offer?.id !== oferta.oferta || valorCentavos === null) {
        return { ok: false, falha: "estado_externo_inesperado", transacaoId: id, ...(expiraEm ? { expiraEm } : {}) };
      }
      const qr = typeof j?.pix?.qrCode === "string" ? j.pix.qrCode : "";
      if (!qr || !expiraEm) return { ok: false, falha: "resposta_incompleta", transacaoId: id, ...(expiraEm ? { expiraEm } : {}) };
      // Valor divergente é conferido por `criarPedidoPix` (→ REVISAO_MANUAL).
      return { ok: true, venda: { transacaoId: id, valorCentavos, expiraEm, qrCode: qr, copiaECola: qr, qrCodeBase64: null } };
    },
  };
}

export function criarProvedorCakto(env: Env = process.env, buscar: typeof fetch = fetch) {
  const config = lerConfiguracaoCakto(env);
  return config ? provedorCakto(config, buscar) : null;
}

const STATUS_CAKTO: Record<string, StatusBlackcat> = {
  paid: "PAID",
  waiting_payment: "PENDING", processing: "PENDING", authorized: "PENDING",
  canceled: "CANCELLED", refused: "CANCELLED",
  // Chargeback segue o modelo de estorno existente: pedido ESTORNADO e direito cancelado.
  refunded: "REFUNDED", chargedback: "REFUNDED",
};

/**
 * Consulta autenticada `GET /orders/{id}/` no formato da confirmação existente.
 * Status sem tradução segura (refund_requested, prechargeback, in_protest…) não
 * vira decisão: devolve `resposta_invalida` e o pedido fica como está.
 * Produto, método, tipo e oferta oficial são conferidos antes de aceitar paid.
 * A moeda vem da oferta: orders não documenta currency nem offer.id.
 */
export function confirmadorCakto(config: ConfiguracaoCakto, buscar: typeof fetch = fetch, token = criarTokenCakto(config, buscar)) {
  return async (id: string, esperado?: { planoId?: string }): Promise<ResultadoConfirmacaoBlackcat> => {
    const t = await token();
    if (!t.ok) return { ok: false, falha: t.falha === "recusado" ? "recusada" : t.falha };
    let r: Response;
    try {
      r = await buscar(`${BASE_CAKTO}/orders/${encodeURIComponent(id)}/`, {
        headers: { Authorization: `Bearer ${t.token}` }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_CAKTO_MS),
      });
    } catch (e) { return { ok: false, falha: ehTimeout(e) ? "timeout" : "rede" }; }
    if (!r.ok) return { ok: false, falha: r.status === 404 ? "nao_encontrada" : [401, 403].includes(r.status) ? "recusada" : "indisponivel" };
    const j = await r.json().catch(() => null) as Record<string, any> | null;
    const status = typeof j?.status === "string" ? STATUS_CAKTO[j.status] : undefined;
    const centavos = reaisParaCentavos(j?.amount);
    if (j?.id !== id || !status || centavos === null) return { ok: false, falha: "resposta_invalida" };
    const ofertaEsperada = esperado?.planoId ? OFERTAS_CAKTO[esperado.planoId] : undefined;
    const ofertaRecebida = j?.offer?.id ?? j?.offerId;
    let diverge = j?.paymentMethod !== "pix" || j?.type !== "unique" || typeof j?.product?.id !== "string" || !j.product.id
      || (j?.currency != null && j.currency !== "BRL")
      || (ofertaRecebida != null && ofertaRecebida !== ofertaEsperada?.oferta);
    if (status === "PAID" && !diverge) {
      if (!ofertaEsperada) return { ok: false, falha: "resposta_invalida" };
      // O banco guarda o plano, não o produto Cakto; uma consulta à oferta oficial resolve o vínculo.
      let oferta: Response;
      try {
        oferta = await buscar(`${BASE_CAKTO}/offers/${encodeURIComponent(ofertaEsperada.oferta)}/`, {
          headers: { Authorization: `Bearer ${t.token}` }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_CAKTO_MS),
        });
      } catch (e) { return { ok: false, falha: ehTimeout(e) ? "timeout" : "rede" }; }
      if (!oferta.ok) return { ok: false, falha: "indisponivel" };
      const o = await oferta.json().catch(() => null) as Record<string, any> | null;
      const produto = typeof o?.product === "string" ? o.product : o?.product?.id;
      diverge = !produto || produto !== j.product.id || o?.currency !== "BRL" || o?.type !== "unique"
        || reaisParaCentavos(o?.price) !== ofertaEsperada.centavos || centavos !== ofertaEsperada.centavos;
    }
    return { ok: true, confirmacao: { transactionId: id, status, amount: diverge ? Number.NaN : centavos, paidAt: dataCakto(j?.paidAt) } };
  };
}

export function criarConfirmadorCakto(env: Env = process.env, buscar: typeof fetch = fetch) {
  const config = lerConfiguracaoCakto(env);
  return config ? confirmadorCakto(config, buscar) : null;
}

/** Assinatura do webhook: HMAC-SHA256(segredo, `${timestamp}.${corpo cru}`), header `v1=<hex>`, 5 min. */
export function assinaturaWebhookValida(
  segredo: string, timestamp: string | null, assinatura: string | null, corpo: Buffer, agoraMs: number = Date.now(),
): boolean {
  if (!segredo || !timestamp || !assinatura || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(agoraMs / 1000 - Number(timestamp)) > 300) return false;
  const recebida = assinatura.trim().replace(/^v1=/, "");
  if (!/^[0-9a-f]{64}$/i.test(recebida)) return false;
  const esperada = crypto.createHmac("sha256", segredo).update(Buffer.concat([Buffer.from(`${timestamp}.`), corpo])).digest();
  return crypto.timingSafeEqual(esperada, Buffer.from(recebida, "hex"));
}
