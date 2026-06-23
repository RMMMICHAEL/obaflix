import { lookup } from "dns/promises";
import net from "net";

// Faixas IPv4 privadas / reservadas / internas que NUNCA devem ser alvo de fetch server-side.
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||                         // 0.0.0.0/8
    a === 10 ||                        // 10.0.0.0/8
    a === 127 ||                       // loopback
    (a === 169 && b === 254) ||        // link-local (cloud metadata 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224                           // multicast / reservado
  );
}

function isPrivateIPv6(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA
  if (low.startsWith("fe80")) return true;                       // link-local
  if (low.startsWith("::ffff:")) return isPrivateIPv4(low.split(":").pop() || ""); // IPv4-mapped
  return false;
}

function isPrivateIP(ip: string): boolean {
  return net.isIPv6(ip) ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/**
 * Valida uma URL alvo contra SSRF.
 * - Exige scheme http/https
 * - Bloqueia IPs literais privados/internos
 * - Resolve o DNS e bloqueia se apontar para faixa interna (anti DNS-rebinding)
 * Retorna a URL parseada se segura, ou lança Error com a razão.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("URL inválida");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("scheme não permitido");
  }

  const host = parsed.hostname;

  // IP literal → checa direto
  if (net.isIP(host)) {
    if (isPrivateIP(host)) throw new Error("destino interno bloqueado");
    return parsed;
  }

  // Hostname → resolve e valida todos os endereços retornados
  const results = await lookup(host, { all: true });
  if (results.length === 0) throw new Error("host não resolvido");
  for (const r of results) {
    if (isPrivateIP(r.address)) throw new Error("destino interno bloqueado");
  }
  return parsed;
}
