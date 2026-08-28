export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { headerMatchesHost, readJsonBody, checkRateLimit } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import { resolverFonte, ambienteDaSessao } from "@/lib/fontes";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/**
 * Entrega a URL real de UMA fonte, sob demanda.
 *
 * Existe porque em Electron e Android a extração precisa rodar no aparelho: o
 * CDN dos provedores recusa o IP de datacenter da Vercel, e passar a mídia pelo
 * proxy custaria centenas de MB de Transfer Out por episódio. Nesses ambientes
 * a URL tem de chegar ao dispositivo — o que dá para eliminar é a entrega
 * antecipada de todas elas.
 *
 * Limite honesto desta rota: o ambiente é declarado pelo cliente, então um
 * navegador que se anuncie como nativo consegue resolver uma fonte por vez.
 * O ganho não é impedir isso — é que deixou de existir a lista completa em
 * claro no payload e no bundle. Aqui cada resolução exige sessão válida, passa
 * por rate limit e fica registrada.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip") || "unknown";
  const ua = req.headers.get("user-agent") || "unknown";

  if (await isIpBlocked(ip)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 429, headers: NO_STORE });
  }

  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    await recordAbuseAttempt(ip);
    audit("origin_rejected", { ip, ua, detail: "/fonte-nativa" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }

  const usuario = await getUserFromRequest(req);
  if (!usuario) {
    await recordAbuseAttempt(ip);
    audit("auth_failure", { ip, ua, detail: "/fonte-nativa sem sessão" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
  }
  const userId = usuario.userId;
  if (!userId) return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });

  const limite = await checkRateLimit(`fonte-nativa:${userId}`, 40, 60);
  if (!limite.allowed) {
    audit("rate_limited", { userId, ip, ua, detail: "/fonte-nativa" });
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429, headers: NO_STORE });
  }

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

  // Sessão aberta como "web" nunca resolve URL: o navegador não extrai nada
  // localmente, então não existe caso legítimo em que ele precise da URL real.
  const ambiente = await ambienteDaSessao(sessao, userId);
  if (ambiente === "web") {
    audit("stream_rejected", { userId, ip, ua, detail: "/fonte-nativa: sessão web" });
    return NextResponse.json({ error: "Fonte não disponível neste modo" }, { status: 403, headers: NO_STORE });
  }

  const { fonte, motivo } = await resolverFonte(sessao, userId, fonteId);
  if (!fonte) {
    const sessaoMorreu = motivo !== undefined;
    if (!sessaoMorreu) await recordAbuseAttempt(ip);
    audit("stream_rejected", { userId, ip, ua, detail: `/fonte-nativa: não resolvida (${motivo ?? "id_desconhecido"})` });
    return NextResponse.json(
      {
        error: sessaoMorreu ? "Sessão de reprodução expirada" : "Fonte indisponível",
        codigo: sessaoMorreu ? "sessao_invalida" : "fonte_desconhecida",
      },
      { status: sessaoMorreu ? 410 : 404, headers: NO_STORE },
    );
  }

  // Só os três casos em que o dispositivo tem de fazer a requisição ele mesmo.
  // Uma fonte que o servidor consegue extrair sozinho nunca sai daqui.
  if (!fonte.nativo && !fonte.iframeDireto && !fonte.iframeDesafio) {
    audit("stream_rejected", { userId, ip, ua, detail: "/fonte-nativa: fonte não é de extração local" });
    return NextResponse.json({ error: "Fonte não disponível neste modo" }, { status: 403, headers: NO_STORE });
  }

  return NextResponse.json({ embedUrl: fonte.embedUrl }, { headers: NO_STORE });
}
