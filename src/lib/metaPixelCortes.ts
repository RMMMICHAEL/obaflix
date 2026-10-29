export const META_PIXEL_ID = "1457288029878728";
export const CONSENTIMENTO_ANUNCIOS = "obaflix_consent_anuncios";
export const EVENTO_PIXEL_PRONTO = "obaflix:pixel-pronto";
export const EVENTO_PREFERENCIAS = "obaflix:cookies";

type Fbq = (...args: unknown[]) => void;
const fbq = () => (window as unknown as { fbq?: Fbq }).fbq;

export const pixelPronto = () => typeof window !== "undefined" && !!fbq();

// Espelha OFERTAS_CAKTO (cakto.ts importa crypto; não serve ao cliente): base do plano + taxa Pix de R$ 0,99.
const BASE_CAKTO: Record<string, number> = { "cortes-start": 2700, "cortes-pro": 4700, "cortes-ai": 19700 };
const TAXA_CAKTO = 99;

/** Total efetivamente cobrado no Pix: a taxa só entra quando o valor base é o da oferta Cakto do plano. */
export const totalPixCentavos = (planoId: string, baseCentavos: number) =>
  BASE_CAKTO[planoId] === baseCentavos ? baseCentavos + TAXA_CAKTO : baseCentavos;

/** Devolve true só se o evento foi entregue ao Pixel. Nunca passe dado pessoal em `dados`. */
export function enviarEventoMeta(evento: string, dados?: Record<string, unknown>, eventID?: string): boolean {
  const f = typeof window === "undefined" ? undefined : fbq();
  if (!f) return false;
  if (eventID) f("track", evento, dados, { eventID });
  else f("track", evento, dados);
  return true;
}
