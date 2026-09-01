export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { headerMatchesHost, readJsonBody, checkRateLimit } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import { resolverFonte, ambienteDaSessao, resolvidoNoServidor } from "@/lib/fontes";
import { extractCineVs } from "@/lib/cinevs";

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
 *
 * Duas formas de resposta, e a diferença importa:
 *
 *   `embedUrl`   — página para o extrator do aparelho abrir. É o caso comum.
 *   `streamUrl`  — mídia já resolvida por nós. Só para provedor cuja resolução
 *                  depende de credencial de conta, que não pode viajar para o
 *                  aparelho (ver `resolvidoNoServidor` em lib/fontes.ts).
 *
 * O segundo caso cria **dependência do backend para resolver a fonte** — e é
 * bom ser claro sobre isso. O que ele **não** cria é proxy: a Vercel faz
 * algumas chamadas JSON pequenas e devolve um endereço; o vídeo vai do CDN
 * direto para o aparelho, sem um byte de Transfer Out nosso. Se esta rota
 * estiver fora do ar, essa fonte não abre — as outras continuam abrindo, e o
 * failover cobre.
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

  // Provedor cuja resolução depende de credencial de conta: resolve aqui e
  // desce só a URL final. O aparelho não pode fazer isto sozinho sem receber a
  // credencial junto, e credencial em APK é credencial pública.
  //
  // A mídia continua saindo do CDN direto para o aparelho — o que roda aqui
  // são três chamadas JSON pequenas, com o token em cache no processo. Nenhum
  // byte de vídeo passa pela Vercel.
  if (resolvidoNoServidor(fonte)) {
    // Nada aqui vem do cliente. O `embedUrl` foi montado por nós quando a
    // sessão nasceu, e é dele que saem os identificadores; o cliente mandou só
    // um `fonteId` opaco, que precisa existir numa sessão dele. Não há URL de
    // destino recebida de fora — o host da API vem de env —, então esta rota
    // não vira proxy nem alcança endereço escolhido por terceiro.
    const alvo = new URL(fonte.embedUrl);
    const tmdbId = alvo.searchParams.get("id") ?? "";
    // Guarda barata: sem id não há o que resolver, e sair para a API de fora
    // com parâmetro vazio só gasta chamada e polui o log do provedor.
    if (!/^\d{1,12}$/.test(tmdbId)) {
      return NextResponse.json(
        { error: "Fonte indisponível", codigo: "resolucao_falhou" },
        { status: 404, headers: NO_STORE },
      );
    }

    const cv = await extractCineVs({
      tmdbId,
      type: alvo.searchParams.get("type") === "movie" ? "movie" : "tv",
      season: Number(alvo.searchParams.get("season") ?? 1),
      episode: Number(alvo.searchParams.get("episode") ?? 1),
      titleHint: alvo.searchParams.get("q") ?? "",
    }).catch(() => null);

    if (!cv?.streamUrl) {
      // Falha aqui não derruba a reprodução: o cliente cai para a próxima
      // fonte, como faz com qualquer extração que não deu certo.
      return NextResponse.json(
        { error: "Fonte indisponível", codigo: "resolucao_falhou" },
        { status: 404, headers: NO_STORE },
      );
    }
    // Mesmo registro das demais resoluções: quem, quando, qual fonte. Sem URL,
    // sem token — a auditoria precisa do rastro, não do segredo.
    audit("stream_started", { userId, ip, ua, detail: "/fonte-nativa: resolvida no servidor" });

    // NO_STORE porque a URL é temporária: ela carrega expiração própria e não
    // pode sobreviver em cache de borda, de CDN ou de navegador além dela.
    // Cada seleção resolve de novo; quem segura o custo é o cache do token no
    // processo, que evita repetir o passo de autenticação.
    return NextResponse.json(
      {
        streamUrl: cv.streamUrl,
        // null de propósito quando o CDN não exige Referer; mandar um atrapalha.
        referer: cv.referer ?? null,
        legendas: cv.subtitles ?? [],
      },
      { headers: NO_STORE },
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
