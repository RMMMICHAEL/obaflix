export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { createPlayToken, checkRateLimit, isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import { assertAllowedMediaUrl } from "@/lib/mediaProviders";
import { resolverFonte } from "@/lib/fontes";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function clientUa(req: NextRequest): string {
  return req.headers.get("user-agent") || "unknown";
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const ua = clientUa(req);

  if (await isIpBlocked(ip)) {
    audit("ip_blocked", { ip, ua, detail: "bloqueado em /token" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 429, headers: NO_STORE });
  }

  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    await recordAbuseAttempt(ip);
    audit("origin_rejected", { ip, ua, detail: `origin=${origin}` });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    await recordAbuseAttempt(ip);
    audit("auth_failure", { ip, ua, detail: "/token sem sessão" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
  }

  const userId = (session.user as { id: string }).id;
  if (!userId) return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });

  if (!(await checkRateLimit(userId))) {
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429, headers: NO_STORE });
  }

  // O cliente manda um id opaco, nunca a URL: quem traduz id → embedUrl é a
  // sessão de fontes no Redis, criada por /api/player/fontes. Além de tirar o
  // domínio real do navegador, isso fecha a escolha de destino pelo cliente —
  // antes ele propunha a URL e o servidor só validava contra a allowlist.
  let corpo: { sessao?: unknown; fonteId?: unknown };
  try {
    corpo = await readJsonBody(req, 2048);
  } catch {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
  }

  const sessao = typeof corpo.sessao === "string" ? corpo.sessao : "";
  const fonteId = typeof corpo.fonteId === "string" ? corpo.fonteId : "";
  if (!sessao || !fonteId) {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
  }

  const { fonte, motivo } = await resolverFonte(sessao, userId, fonteId);
  if (!fonte) {
    // `codigo` separa os dois casos que antes vinham como o mesmo 404: a sessão
    // inteira sumiu (o cliente precisa reabrir) ou só este id não existe nela
    // (o cliente pode seguir para a próxima fonte). Sem isso o player tentava
    // todas as fontes em sequência e multiplicava requisições à toa.
    const sessaoMorreu = motivo !== undefined;
    if (!sessaoMorreu) await recordAbuseAttempt(ip);
    audit("play_token_rejected", { userId, ip, ua, detail: `fonte não resolvida (${motivo ?? "id_desconhecido"})` });
    return NextResponse.json(
      {
        error: sessaoMorreu ? "Sessão de reprodução expirada" : "Fonte indisponível",
        codigo: sessaoMorreu ? "sessao_invalida" : "fonte_desconhecida",
        motivo,
      },
      { status: sessaoMorreu ? 410 : 404, headers: NO_STORE },
    );
  }

  // A allowlist continua, agora como segunda linha: protege contra uma sessão
  // montada com um host que deixou de ser aceito entre um deploy e outro.
  try {
    await assertAllowedMediaUrl(fonte.embedUrl);
  } catch {
    return NextResponse.json({ error: "Fonte indisponível" }, { status: 403, headers: NO_STORE });
  }

  const playToken = createPlayToken(userId, fonte.embedUrl, ip);
  return NextResponse.json({ playToken }, { headers: NO_STORE });
}
