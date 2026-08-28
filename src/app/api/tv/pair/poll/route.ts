export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked } from "@/lib/playTokens";
import { consultarPareamento, normalizarCodigo } from "@/lib/tvPairing";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * A TV pergunta se já foi aprovada.
 *
 * Sem autenticação — o `deviceCode` *é* a credencial. Ele nunca apareceu na
 * tela, então quem o tem é a TV que iniciou o pareamento.
 *
 * A TV manda os dois códigos: o público localiza o registro, o secreto prova a
 * posse. Mandar os dois deixa a chamada em **uma** leitura de Redis, e esta é a
 * chamada que mais se repete no fluxo inteiro.
 *
 * Nenhuma resposta distingue "código inexistente" de "código de outro
 * aparelho": as duas dão `expirado`. Distinguir entregaria um oráculo para
 * varrer códigos.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);

  if (await isIpBlocked(ip)) {
    return NextResponse.json({ estado: "expirado" }, { status: 429, headers: NO_STORE });
  }

  let corpo: { userCode?: unknown; deviceCode?: unknown; fingerprint?: unknown };
  try {
    corpo = await readJsonBody(req, 1024);
  } catch {
    return NextResponse.json({ estado: "expirado" }, { status: 400, headers: NO_STORE });
  }

  const userCode = normalizarCodigo(typeof corpo.userCode === "string" ? corpo.userCode : "");
  const deviceCode = typeof corpo.deviceCode === "string" ? corpo.deviceCode : "";
  const fingerprint = typeof corpo.fingerprint === "string" ? corpo.fingerprint.trim() : "";

  if (userCode.length !== 8 || !deviceCode || !/^[a-f0-9]{64}$/i.test(fingerprint)) {
    return NextResponse.json({ estado: "expirado" }, { headers: NO_STORE });
  }

  const resultado = await consultarPareamento({
    userCode,
    deviceCode,
    fingerprint,
    ip,
    userAgent: req.headers.get("user-agent") || "unknown",
  });

  if (resultado.estado !== "aprovado") {
    return NextResponse.json({ estado: resultado.estado }, { headers: NO_STORE });
  }

  // Único momento em que os tokens saem do servidor. Corpo de resposta, nunca
  // querystring — URL entra em log de proxy, de CDN e no histórico.
  return NextResponse.json(
    {
      estado: "aprovado",
      accessToken: resultado.sessao.accessToken,
      refreshToken: resultado.sessao.refreshToken,
      expiraEmSeg: resultado.sessao.expiraEmSeg,
      deviceId: resultado.sessao.deviceId,
    },
    { headers: NO_STORE },
  );
}
