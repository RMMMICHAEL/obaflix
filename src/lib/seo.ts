import type { Metadata } from "next";

const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";

export const SITE_URL = configuredUrl.replace(/\/$/, "");
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
