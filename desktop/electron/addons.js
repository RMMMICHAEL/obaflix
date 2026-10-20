"use strict";

const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");
const crypto = require("node:crypto");

// Protocolo público Stremio; implementação própria. Referências em docs/electron-addons.md.
const PRESETS = [
  { key: "fenixflix", name: "FenixFlix", url: "https://fenixflix.fenixhub.online/manifest.json" },
  { key: "brazuca", name: "Brazuca Torrents", url: "https://94c8cb9f702d-brazuca-torrents.baby-beamup.club/manifest.json" },
];
const MAX_JSON = 2 * 1024 * 1024;

function publicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a > 0 && a !== 10 && a !== 127 && a < 224 &&
      !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0)) &&
      !(a === 198 && (b === 18 || b === 19));
  }
  // Aceita apenas unicast IPv6 global; exclui IPv4 mapeado, link-local e ULA.
  return net.isIPv6(address) && /^[23][0-9a-f]{3}:/i.test(address) &&
    !address.toLowerCase().startsWith("2001:db8:");
}

function httpsUrl(raw) {
  if (typeof raw !== "string" || raw.length > 8192 || /[\u0000-\u0020\u007f]/.test(raw)) throw new Error("Endereço inválido");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("O addon deve usar HTTPS público");
  }
  return url;
}

async function publicTarget(raw, lookup = dns.lookup) {
  const url = httpsUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new Error("Destino local ou reservado bloqueado");
  }
  return { url, address: addresses[0] };
}

async function requestJson(raw, redirects = 0) {
  const { url, address } = await publicTarget(raw);
  return new Promise((resolve, reject) => {
    // O endereço conferido fica fixo na conexão; DNS rebinding não troca o destino.
    const req = https.get(url, {
      headers: { Accept: "application/json", "User-Agent": "ObaflixDesktop/1.0" },
      lookup: (_host, options, callback) => options.all
        ? callback(null, [address]) : callback(null, address.address, address.family),
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 3 || !res.headers.location) return reject(new Error("Redirecionamento inválido"));
        return resolve(requestJson(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("Addon indisponível")); }
      if (Number(res.headers["content-length"]) > MAX_JSON) {
        res.destroy(); return reject(new Error("Resposta do addon muito grande"));
      }
      let size = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_JSON) { res.destroy(new Error("Resposta do addon muito grande")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("JSON inválido no addon")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("O addon demorou para responder")), 10_000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
  });
}

function parseManifest(data) {
  if (!data || typeof data !== "object" || !["id", "name", "version"].every(k =>
    typeof data[k] === "string" && data[k].trim() && data[k].length <= 200) ||
    !Array.isArray(data.types) || !Array.isArray(data.resources)) throw new Error("Manifest inválido");
  const strings = value => Array.isArray(value) ? value.filter(v => typeof v === "string") : [];
  const types = strings(data.types);
  const prefixes = strings(data.idPrefixes);
  const resources = data.resources.map(r => typeof r === "string"
    ? { name: r, types, prefixes }
    : { name: r?.name, types: r?.types?.length ? strings(r.types) : types,
      prefixes: r?.idPrefixes?.length ? strings(r.idPrefixes) : prefixes });
  if (data.behaviorHints?.configurationRequired === true) throw new Error("Este addon precisa ser configurado antes de ativar");
  return { id: data.id, name: data.name, version: data.version, resources };
}

function supports(manifest, type, id) {
  return manifest.resources.some(r => r.name === "stream" && r.types.includes(type) &&
    (!r.prefixes.length || r.prefixes.some(prefix => id.startsWith(prefix))));
}

function streamUrl(manifestUrl, type, id) {
  if (!["movie", "series"].includes(type) || !/^tt\d{1,12}(?::\d{1,4}:\d{1,4})?$/.test(id)) {
    throw new Error("Identificador de conteúdo inválido");
  }
  const url = httpsUrl(manifestUrl);
  url.pathname = url.pathname.replace(/\/manifest\.json$/, "") + "/stream/" + type + "/" + encodeURIComponent(id) + ".json";
  return url.href;
}

function parseStream(stream) {
  if (!stream || typeof stream !== "object") return null;
  const title = String(stream.name || stream.title || stream.description || "Fonte do addon").slice(0, 180);
  if (!stream.url) return { title, reason: stream.infoHash ? "Torrent: reprodução P2P ainda não disponível nesta etapa."
    : stream.externalUrl ? "Esta fonte abre um aplicativo externo." : "Formato de fonte ainda não suportado." };
  if (/^magnet:|^torrent:/i.test(stream.url)) return { title, reason: "Torrent: reprodução P2P ainda não disponível nesta etapa." };
  try { httpsUrl(stream.url); } catch { return { title, reason: "A fonte precisa fornecer um endereço HTTPS público." }; }
  const request = stream.behaviorHints?.proxyHeaders?.request || {};
  const names = Object.keys(request);
  // Não encaminha cookies, Authorization nem headers arbitrários de terceiros.
  if (names.some(k => k.toLowerCase() !== "referer")) return { title, reason: "Esta fonte exige cabeçalhos ainda não suportados." };
  const referer = request[names[0]] || "";
  if (referer) { try { httpsUrl(referer); } catch { return { title, reason: "Referência de origem inválida." }; } }
  return { title, stream: stream.url, referer, tipo: /\.m3u8(?:$|\?)/i.test(stream.url) ? "hls" : "mp4" };
}

function createAddonService({ readSettings, writeSettings, authorize, fetchJson = requestJson,
  validateMedia = publicTarget, now = Date.now }) {
  let enabled = new Set(readSettings().filter(key => PRESETS.some(p => p.key === key)));
  const manifests = new Map();
  const cache = new Map();
  const pending = new Map();
  const options = new Map();
  const list = () => PRESETS.map(p => ({ key: p.key, name: manifests.get(p.key)?.name || p.name, enabled: enabled.has(p.key) }));
  const manifest = async preset => {
    if (!manifests.has(preset.key)) manifests.set(preset.key, parseManifest(await fetchJson(preset.url)));
    return manifests.get(preset.key);
  };
  return async function handle(event, request = {}) {
    if (!request || typeof request !== "object") throw new Error("Pedido inválido");
    if (request.action === "list") return { addons: list() };
    const preset = PRESETS.find(p => p.key === request.key);
    if (request.action === "enable" || request.action === "disable") {
      if (!preset) throw new Error("Addon desconhecido");
      if (request.action === "enable") await manifest(preset);
      const next = new Set(enabled);
      if (request.action === "enable") next.add(preset.key); else next.delete(preset.key);
      writeSettings([...next]);
      enabled = next;
      cache.clear(); options.clear();
      return { addons: list() };
    }
    if (!["streams", "resolve"].includes(request.action) || !/^[\w-]{16,64}$/.test(request.sessao || "")) {
      throw new Error("Sessão de reprodução inválida");
    }
    // Confere a sessão no backend antes até de ler o cache; nunca confia no id do renderer.
    const target = await authorize(event, request.sessao);
    if (!target || !["movie", "series"].includes(target.type) || !target.id) throw new Error("Reprodução não autorizada");
    const scope = request.sessao + ":" + target.type + ":" + target.id;
    if (request.action === "resolve") {
      const option = options.get(request.sourceId);
      if (!option || option.scope !== scope || option.until <= now() || !enabled.has(option.key)) {
        throw new Error("Fonte expirada. Busque os addons novamente.");
      }
      if (!option.stream) throw new Error(option.reason);
      await validateMedia(option.stream);
      return { stream: option.stream, tipo: option.tipo, referer: option.referer };
    }
    if (!preset || !enabled.has(preset.key)) throw new Error("Addon não ativado");
    const key = preset.key + ":" + scope;
    if (cache.get(key)?.until > now()) return cache.get(key).value;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const meta = await manifest(preset);
      if (!supports(meta, target.type, target.id)) return { sources: [], message: "Addon incompatível com este conteúdo." };
      const data = await fetchJson(streamUrl(preset.url, target.type, target.id));
      if (!Array.isArray(data?.streams)) throw new Error("Lista de fontes inválida");
      if (cache.size >= 20) cache.clear();
      for (const [id, option] of options) if (option.until <= now()) options.delete(id);
      if (options.size >= 1000) options.clear();
      const until = now() + 60_000;
      const sources = data.streams.slice(0, 100).map(parseStream).filter(Boolean).map(source => {
        const id = crypto.randomBytes(18).toString("base64url");
        options.set(id, { ...source, scope, until, key: preset.key });
        return { id, title: source.title, available: !!source.stream, reason: source.reason };
      });
      const value = { sources };
      cache.set(key, { until, value });
      return value;
    })().finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  };
}

function registerAddonIpc({ ipcMain, isTrusted, service, onResolved }) {
  ipcMain.handle("desktop-addons", async (event, request) => {
    if (!isTrusted(event)) return { error: "Acesso negado" };
    try {
      const result = await service(event, request);
      if (request.action === "resolve") await onResolved(result);
      return result;
    } catch (error) {
      // Não devolve URLs de configuração, tokens ou detalhes de rede ao renderer.
      return { error: error?.message?.startsWith("Fonte expirada") ? error.message : "Não foi possível consultar o addon. Verifique a sessão e tente novamente." };
    }
  });
}

module.exports = { PRESETS, publicAddress, publicTarget, requestJson, parseManifest, supports, streamUrl,
  parseStream, createAddonService, registerAddonIpc };
