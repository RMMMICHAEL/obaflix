"use strict";

// Leitura mínima de manifestos HLS para comparar servidores antes de escolher um.
// Espelha android/app/src/main/java/com/obaflix/bridge/HlsManifest.kt — os dois
// extratores precisam pontuar as mesmas fontes da mesma forma.

function looksLikeManifest(text) {
  return String(text || "").trimStart().startsWith("#EXTM3U");
}

/**
 * Divide a lista de atributos de uma tag EXT-X preservando vírgulas dentro de
 * valores entre aspas, como em CODECS="avc1.4d401f,mp4a.40.2".
 */
function splitAttributes(raw) {
  const parts = [];
  let current = "";
  let quoted = false;
  for (const char of String(raw || "")) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === "," && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);

  const values = new Map();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (key) values.set(key, value);
  }
  return values;
}

function qualityLabel(resolution, bandwidth) {
  const height = Number.parseInt(String(resolution || "").split("x")[1], 10);
  if (Number.isFinite(height) && height > 0) return `${height}p`;
  if (bandwidth > 0) return `${Math.round(bandwidth / 1000)} kbps`;
  return "auto";
}

function parse(text, baseUrl) {
  if (!looksLikeManifest(text)) return { isMaster: false, variants: [], audioTracks: [], subtitles: [] };

  const variants = [];
  const audio = new Set();
  const subtitles = new Map();

  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();

    if (/^#EXT-X-STREAM-INF:/i.test(trimmed)) {
      const attrs = splitAttributes(trimmed.slice(trimmed.indexOf(":") + 1));
      const bandwidth =
        Number.parseInt(attrs.get("BANDWIDTH") || attrs.get("AVERAGE-BANDWIDTH") || "0", 10) || 0;
      const resolution = attrs.get("RESOLUTION") || null;
      variants.push({ bandwidth, resolution, label: qualityLabel(resolution, bandwidth) });
      continue;
    }

    if (/^#EXT-X-MEDIA:/i.test(trimmed)) {
      const attrs = splitAttributes(trimmed.slice(trimmed.indexOf(":") + 1));
      const name = attrs.get("NAME") || attrs.get("LANGUAGE") || null;
      const type = (attrs.get("TYPE") || "").toUpperCase();
      if (type === "AUDIO") {
        if (name) audio.add(name);
      } else if (type === "SUBTITLES" || type === "CLOSED-CAPTIONS") {
        const uri = attrs.get("URI");
        if (!uri) continue;
        try {
          const resolved = new URL(uri, baseUrl).toString();
          if (!subtitles.has(resolved)) {
            subtitles.set(resolved, { file: resolved, label: name || "Legenda", kind: "captions" });
          }
        } catch { /**/ }
      }
    }
  }

  const seenLabels = new Set();
  const distinct = variants
    .filter((variant) => {
      if (seenLabels.has(variant.label)) return false;
      seenLabels.add(variant.label);
      return true;
    })
    .sort((a, b) => b.bandwidth - a.bandwidth);

  return {
    isMaster: variants.length > 0,
    variants: distinct,
    audioTracks: [...audio],
    subtitles: [...subtitles.values()],
  };
}

module.exports = { looksLikeManifest, parse };
