type MediaAvailability = {
  urlDub?: unknown;
  urlLeg?: unknown;
};

function availability(value: unknown): "disponivel" | null {
  return typeof value === "string" && value.trim().length > 0 ? "disponivel" : null;
}

/**
 * Source URLs are infrastructure secrets, not catalog metadata. Public APIs may
 * expose availability, but never the upstream player/CDN URL itself.
 */
export function publicMedia<T extends object>(record: T) {
  const media = record as T & MediaAvailability;
  return {
    ...record,
    ...(Object.prototype.hasOwnProperty.call(record, "urlDub")
      ? { urlDub: availability(media.urlDub) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "urlLeg")
      ? { urlLeg: availability(media.urlLeg) }
      : {}),
  };
}
