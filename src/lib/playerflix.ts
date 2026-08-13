export type PlayerflixPayloadFormat = "json" | "legacy-html" | "unknown";

export interface PlayerflixEmbedParseResult {
  embeds: string[];
  format: PlayerflixPayloadFormat;
  optionCount: number;
}

function asHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
  } catch {
    // Some legacy responses encoded the embed URL as base64.
  }

  try {
    const decoded = Buffer.from(candidate, "base64").toString("utf8").trim();
    const parsed = new URL(decoded);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
  } catch {
    // Not a URL in either supported representation.
  }

  return null;
}

export function parsePlayerflixEmbeds(body: string): PlayerflixEmbedParseResult {
  const embeds: string[] = [];
  const add = (value: unknown) => {
    const url = asHttpUrl(value);
    if (url && !embeds.includes(url)) embeds.push(url);
  };

  try {
    const payload = JSON.parse(body) as {
      data?: { options?: unknown } | null;
    };
    const options = Array.isArray(payload.data?.options) ? payload.data.options : [];

    for (const option of options) {
      if (option && typeof option === "object" && "embed" in option) {
        add((option as { embed?: unknown }).embed);
      }
    }

    return { embeds, format: "json", optionCount: options.length };
  } catch {
    // Fall through to the legacy HTML parser.
  }

  const legacyMatches = [...body.matchAll(/data-embed=["']([^"']+)["']/gi)];
  for (const match of legacyMatches) add(match[1]);

  return {
    embeds,
    format: legacyMatches.length > 0 ? "legacy-html" : "unknown",
    optionCount: legacyMatches.length,
  };
}
