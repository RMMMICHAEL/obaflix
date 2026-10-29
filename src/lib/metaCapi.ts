import { createHash, randomUUID } from "node:crypto";
import { META_PIXEL_ID } from "./metaPixelCortes";

/**
 * Meta Conversions API (servidor). Só o Purchase de compra Cortes confirmada, com consentimento
 * registrado no pedido. Dados de correspondência mínimos: external_id (hash do pedido) e os
 * identificadores do próprio Pixel (_fbp/_fbc). Nunca CPF, telefone, e-mail, IP ou user agent.
 * O token vive só em META_CAPI_ACCESS_TOKEN; não entra em URL, log, erro nem resposta.
 */

const VERSAO_GRAPH = "v23.0";
const PRAZO_MS = 4000;
export const COOKIE_CONSENTIMENTO_ANUNCIOS = "obaflix_ads";
const FBP = /^fb\.[0-2]\.\d{10,13}\.\d{5,20}$/;
const FBC = /^fb\.[0-2]\.\d{10,13}\.[A-Za-z0-9_-]{1,200}$/;
const URL_PURCHASE = "https://obaflixbr.com/cortes/checkout";
const URL_TESTE = "https://obaflixbr.com/cortes";
const USER_AGENT_VALIDO = /^[\x20-\x7E]{1,512}$/;

export interface CompraParaMeta {
  pedidoId: string;
  planoId: string;
  /** Total efetivamente cobrado no Pix, em centavos (com a taxa, quando aplicável). */
  valorTotalCentavos: number;
  fbp?: string | null;
  fbc?: string | null;
  /** User agent do navegador na criação do pedido (só com consentimento). */
  userAgent?: string | null;
  /** Instante da confirmação. */
  em: Date;
}

export type ResultadoMeta = { ok: true; recebidos: number } | { ok: false; motivo: "configuracao" | "rede" | "recusado" | "indisponivel" | "sem_confirmacao" };

type Fetch = typeof fetch;
export interface DependenciasMeta { fetch?: Fetch; token?: string | undefined }

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Consentimento e identificadores do Pixel vindos dos cookies da requisição de compra. Sem o cookie de aceite, null. */
export function marketingDosCookies(cookies: { get(nome: string): { value: string } | undefined }, userAgent?: string | null): { fbp: string | null; fbc: string | null; userAgent: string | null } | null {
  if (cookies.get(COOKIE_CONSENTIMENTO_ANUNCIOS)?.value !== "1") return null;
  const fbp = cookies.get("_fbp")?.value ?? "";
  const fbc = cookies.get("_fbc")?.value ?? "";
  return { fbp: FBP.test(fbp) ? fbp : null, fbc: FBC.test(fbc) ? fbc : null, userAgent: userAgent && USER_AGENT_VALIDO.test(userAgent) ? userAgent : null };
}

async function postar(corpo: Record<string, unknown>, deps: DependenciasMeta): Promise<ResultadoMeta> {
  const token = (deps.token ?? process.env.META_CAPI_ACCESS_TOKEN)?.trim();
  if (!token) return { ok: false, motivo: "configuracao" };
  const f = deps.fetch ?? fetch;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const r = await f(`https://graph.facebook.com/${VERSAO_GRAPH}/${META_PIXEL_ID}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...corpo, access_token: token }),
        signal: AbortSignal.timeout(PRAZO_MS),
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null) as { events_received?: unknown } | null;
        // HTTP 200 sem events_received >= 1 não é entrega: não conta como enviado.
        const recebidos = typeof j?.events_received === "number" ? j.events_received : 0;
        return recebidos >= 1 ? { ok: true, recebidos } : { ok: false, motivo: "sem_confirmacao" };
      }
      if (r.status < 500 && r.status !== 429) return { ok: false, motivo: "recusado" };
    } catch { /* tenta de novo uma vez */ }
  }
  return { ok: false, motivo: "indisponivel" };
}

function eventoPurchase(c: CompraParaMeta) {
  return {
    event_name: "Purchase",
    event_time: Math.floor(c.em.getTime() / 1000),
    // Mesmo identificador que o Pixel do navegador usa (CheckoutCortes): deduplicação na Meta.
    event_id: c.pedidoId,
    action_source: "website",
    event_source_url: URL_PURCHASE,
    user_data: {
      external_id: [sha256(c.pedidoId)],
      ...(c.userAgent ? { client_user_agent: c.userAgent } : {}),
      ...(c.fbp ? { fbp: c.fbp } : {}),
      ...(c.fbc ? { fbc: c.fbc } : {}),
    },
    custom_data: {
      currency: "BRL",
      value: c.valorTotalCentavos / 100,
      content_ids: [c.planoId],
      content_type: "product",
      order_id: c.pedidoId,
    },
  };
}

export const enviarPurchaseMeta = (c: CompraParaMeta, deps: DependenciasMeta = {}): Promise<ResultadoMeta> =>
  postar({ data: [eventoPurchase(c)] }, deps);

/** Teste de conexão: um PageView sintético, sempre com test_event_code (não conta como evento real). Nunca Purchase. */
export function enviarEventoTesteMeta(testEventCode: string, deps: DependenciasMeta = {}): Promise<ResultadoMeta> {
  return postar({
    test_event_code: testEventCode,
    data: [{
      event_name: "PageView",
      event_time: Math.floor(Date.now() / 1000),
      event_id: `capi-teste-${randomUUID()}`,
      action_source: "website",
      event_source_url: URL_TESTE,
      user_data: { external_id: [sha256("capi-teste")], client_user_agent: "Obaflix-CAPI-Teste" },
    }],
  }, deps);
}

export const TEST_EVENT_CODE_VALIDO = /^[A-Za-z0-9]{1,30}$/;
