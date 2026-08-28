export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked } from "@/lib/playTokens";
import { iniciarPareamento, formatarCodigo } from "@/lib/tvPairing";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * A TV pede um pareamento.
 *
 * Sem autenticação, por definição: é justamente a chamada de quem ainda não tem
 * conta associada. O que protege é o limite por IP e o TTL de 10 minutos.
 *
 * O `deviceCode` da resposta é o segredo do fluxo e sai daqui uma única vez.
 * Ele não vai para log, não entra no QR Code e não é desenhado na TV. Só a
 * própria TV o conhece, e é o que ela usa para provar que é ela no poll.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);

  if (await isIpBlocked(ip)) {
    return NextResponse.json({ erro: "acesso_negado" }, { status: 429, headers: NO_STORE });
  }

  let corpo: { fingerprint?: unknown; modelo?: unknown };
  try {
    corpo = await readJsonBody(req, 1024);
  } catch {
    return NextResponse.json({ erro: "parametros_invalidos" }, { status: 400, headers: NO_STORE });
  }

  // A impressão do aparelho já chega como hash, calculada na TV. O servidor não
  // precisa do androidId em claro e por isso não o recebe.
  const fingerprint = typeof corpo.fingerprint === "string" ? corpo.fingerprint.trim() : "";
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    return NextResponse.json({ erro: "parametros_invalidos" }, { status: 400, headers: NO_STORE });
  }

  const modelo = typeof corpo.modelo === "string" ? corpo.modelo.slice(0, 60) : "";

  const inicio = await iniciarPareamento({ fingerprint, modelo, ip });
  if ("erro" in inicio) {
    return NextResponse.json({ erro: inicio.erro }, { status: 429, headers: NO_STORE });
  }

  const base = process.env.NEXTAUTH_URL ?? req.nextUrl.origin;

  return NextResponse.json(
    {
      // Público: é o que a TV desenha e o que vai no QR Code.
      userCode: inicio.userCode,
      userCodeFormatado: formatarCodigo(inicio.userCode),
      urlVerificacao: `${base}/parear`,
      // O QR leva só o código. Nada aqui é credencial.
      urlQrCode: `${base}/parear?c=${inicio.userCode}`,

      // Secreto: fica no aparelho, nunca na tela.
      deviceCode: inicio.deviceCode,

      expiraEmSeg: inicio.expiraEmSeg,
      intervaloSeg: inicio.intervaloSeg,
    },
    { headers: NO_STORE },
  );
}
