import type { Metadata } from "next";
import { publicSiteUrl } from "@/config/public-domain";

const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXTAUTH_URL;

export const SITE_URL = publicSiteUrl(configuredUrl);
export const SITE_NAME = "Obaflix";
export const DEFAULT_DESCRIPTION =
  "Explore o catálogo Obaflix com informações sobre filmes, séries, animes e desenhos, incluindo sinopses, temporadas e novidades.";

export const catalogIndexingEnabled = process.env.CONTENT_INDEXING_ENABLED === "true";

export function absoluteUrl(path = "/") {
  return new URL(path, `${SITE_URL}/`).toString();
}

export function cleanDescription(value: string | null | undefined, fallback = DEFAULT_DESCRIPTION) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 158 ? `${normalized.slice(0, 155).trimEnd()}…` : normalized;
}

export function catalogRobots(): Metadata["robots"] {
  return catalogIndexingEnabled
    ? { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } }
    : { index: false, follow: true };
}

export function mediaMetadata({
  title,
  description,
  path,
  image,
  type = "website",
}: {
  title: string;
  description?: string | null;
  path: string;
  image?: string | null;
  type?: "website" | "video.movie" | "video.tv_show";
}): Metadata {
  const summary = cleanDescription(description);
  const images = image ? [{ url: image, alt: title }] : undefined;

  return {
    title,
    description: summary,
    alternates: { canonical: path },
    robots: catalogRobots(),
    openGraph: {
      type,
      locale: "pt_BR",
      siteName: SITE_NAME,
      url: path,
      title,
      description: summary,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: summary,
      images: image ? [image] : undefined,
    },
  };
}

export function catalogPageMetadata(title: string, description: string, path: string): Metadata {
  return mediaMetadata({ title, description, path });
}

/**
 * Título da ficha orientado à intenção "assistir <título> online". O template do
 * layout acrescenta " | Obaflix", então a marca não é repetida aqui.
 *
 *   filme com ano: Assistir Oppenheimer online (2023) — onde assistir
 *   filme sem ano: Assistir Oppenheimer online — onde assistir
 *   série:         Assistir Dexter online — temporadas e episódios
 */
export function tituloFicha(
  tipo: "filme" | "serie",
  titulo: string,
  ano?: number | null,
): string {
  if (tipo === "filme") {
    const base = ano ? `Assistir ${titulo} online (${ano})` : `Assistir ${titulo} online`;
    return `${base} — onde assistir`;
  }
  return `Assistir ${titulo} online — temporadas e episódios`;
}

/**
 * Description orientada à intenção + conteúdo único. A sinopse real entra quando
 * existe (mantém a página específica); sem sinopse, fica só a parte de intenção,
 * sem inventar conteúdo. A compressão/limite fica por conta de `cleanDescription`
 * em `mediaMetadata`.
 */
export function descricaoFicha(
  tipo: "filme" | "serie",
  titulo: string,
  sinopse?: string | null,
): string {
  const intro =
    tipo === "filme"
      ? `Quer assistir ${titulo} online? Confira sinopse, elenco, gêneros e como assistir pelo aplicativo Obaflix.`
      : `Quer assistir ${titulo} online? Veja temporadas, episódios, elenco, gêneros e como assistir pelo aplicativo Obaflix.`;
  const s = sinopse?.trim();
  return s ? `${intro} ${s}` : intro;
}
