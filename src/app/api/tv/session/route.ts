export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked } from "@/lib/playTokens";
import { renovarSessao, revogarDispositivo, faixaDeRede } from "@/lib/tvPairing";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Ciclo de vida da sessão da TV.
 *
 * POST    renova: troca o refresh por um par novo, com rotação.
 * DELETE  encerra: revoga o aparelho.
 *
 * A renovação não usa o access token — usa o refresh, que é a credencial de
 * longo prazo. É de propósito: a TV renova justamente quando o access já
 * expirou, e exigir um token válido para pedir outro seria um ciclo impossível.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (await isIpBlocked(ip)) {
    return NextResponse.json({ erro: "acesso_negado" }, { status: 429, headers: NO_STORE });
  }

  let corpo: { refreshToken?: unknown; fingerprint?: unknown };
  try {
    corpo = await readJsonBody(req, 1024);
  } catch {
    return NextResponse.json({ erro: "invalido" }, { status: 400, headers: NO_STORE });
  }

  const refreshToken = typeof corpo.refreshToken === "string" ? corpo.refreshToken : "";
  const fingerprint = typeof corpo.fingerprint === "string" ? corpo.fingerprint.trim() : "";
  if (!refreshToken || !/^[a-f0-9]{64}$/i.test(fingerprint)) {
    return NextResponse.json({ erro: "invalido" }, { status: 400, headers: NO_STORE });
  }

  const resultado = await renovarSessao({
    refreshToken,
    fingerprint,
    rede: faixaDeRede(ip),
    userAgent: req.headers.get("user-agent") || "unknown",
  });

  if (!resultado.ok) {
    // "reuso" chega ao cliente como o mesmo 401 dos demais: a TV precisa saber
    // que tem de parear de novo, e não por que. Quem precisa da distinção é o
    // log de auditoria, e lá ela está registrada.
    return NextResponse.json({ erro: "reautenticar" }, { status: 401, headers: NO_STORE });
  }

  return NextResponse.json(
    {
      accessToken: resultado.sessao.accessToken,
      refreshToken: resultado.sessao.refreshToken,
      expiraEmSeg: resultado.sessao.expiraEmSeg,
      deviceId: resultado.sessao.deviceId,
    },
    { headers: NO_STORE },
  );
}

/**
 * Sair da conta nesta TV.
 *
 * Aceita as duas entradas: a própria TV encerrando com seu Bearer, ou o usuário
 * removendo o aparelho pelo site com o cookie. Pelo site é preciso dizer qual
 * aparelho; pela TV, ela é o aparelho e o id vem do próprio token.
 */
export async function DELETE(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) {
    return NextResponse.json({ erro: "nao_autenticado" }, { status: 401, headers: NO_STORE });
  }

  let deviceId = usuario.deviceId;

  if (!deviceId) {
    let corpo: { deviceId?: unknown };
    try {
      corpo = await readJsonBody(req, 512);
    } catch {
      return NextResponse.json({ erro: "invalido" }, { status: 400, headers: NO_STORE });
    }
    deviceId = typeof corpo.deviceId === "string" ? corpo.deviceId : null;
  }

  if (!deviceId) {
    return NextResponse.json({ erro: "invalido" }, { status: 400, headers: NO_STORE });
  }

  // revogarDispositivo confirma que o aparelho é do usuário antes de revogar —
  // um deviceId de outra conta não é encontrado e vira 404.
  const ok = await revogarDispositivo(usuario.userId, deviceId);
  if (!ok) {
    return NextResponse.json({ erro: "nao_encontrado" }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
