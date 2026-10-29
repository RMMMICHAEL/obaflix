export const META_PIXEL_ID = "1457288029878728";
export const CONSENTIMENTO_ANUNCIOS = "obaflix_consent_anuncios";

type Fbq = (...args: unknown[]) => void;

/** Só dispara se o visitante aceitou (o pixel só é carregado após o aceite). Nunca passe dado pessoal em `dados`. */
export function enviarEventoMeta(evento: string, dados?: Record<string, unknown>, eventID?: string) {
  const fbq = (window as unknown as { fbq?: Fbq }).fbq;
  if (!fbq) return;
  if (eventID) fbq("track", evento, dados, { eventID });
  else fbq("track", evento, dados);
}
