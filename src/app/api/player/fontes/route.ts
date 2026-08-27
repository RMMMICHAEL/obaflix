export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import {
  montarFontes, numerar, criarSessaoFontes, acrescentarFontes, lerFontes,
  projetarPublica, projetarAdmin, detectarProvider, ehTokenizada,
  suportaExtracaoNativa, ehSuperflix, hostDe,
  type Ambiente, type FonteReal,
} from "@/lib/fontes";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

const UA_NAVEGADOR =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
}

// ── Origens de catálogo ───────────────────────────────────────────────────────
// Vieram das páginas /assistir/*. Lá o resultado virava prop de um componente
// cliente, então cada URL real terminava no payload RSC. Aqui elas não saem do
// servidor: viram entradas de sessão com id opaco.

const REDECANAIS_EPISODIOS: Record<string, string> = {
  "4607:1:1": "https://redecanais.capital/player3/server.php?categoria=vod&server=RCServer01&subfolder=videos&vid=LOSTT01EP01&gid=0B265dpk7MD54cWtsLXVGSmhWeFk",
  "69050:1:1": "https://redecanais.capital/player3/server.php?categoria=vod&server=RCServer13&subfolder=ondemand&vid=RVDLT01EP01",
};

/**
 * O `warez2` traz o Voltz e outros players extras. Ganhou timeout: nas páginas
 * a chamada era sem limite e um provedor lento segurava o render inteiro.
 */
async function buscarWarez2(params: URLSearchParams): Promise<{ br: string[]; eng: string[] }> {
  try {
    const r = await fetch(`https://megafrixapi.com/iptv/warez2.php?${params}`, {
      headers: { "User-Agent": "okhttp/4.9.3" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { br: [], eng: [] };
    const data = await r.json().catch(() => null);
    return { br: Array.isArray(data?.br) ? data.br : [], eng: Array.isArray(data?.eng) ? data.eng : [] };
  } catch {
    return { br: [], eng: [] };
  }
}

function mesclar(extras: string[], doBanco: string | null): string | null {
  const todas = [...extras];
  if (doBanco) {
    doBanco.split(",").map((u) => u.trim()).filter(Boolean).forEach((u) => {
      if (!todas.includes(u)) todas.push(u);
    });
  }
  return todas.length ? todas.join(",") : null;
}

// ── Alternativas do Playerflix ────────────────────────────────────────────────
// Substitui a rota /api/player/playerflix-sources, que devolvia ao cliente a URL
// completa, o slug do provedor e o rótulo real de cada servidor.

async function buscarAlternativasPlayerflix(
  tmdbId: string,
  tipo: "tv" | "movie",
  season: string,
  episode: string,
): Promise<{ url: string; nome: string }[]> {
  const ajax = new URL("https://playerflix.ink/inc/Ajax.php");
  ajax.searchParams.set("type", tipo);
  ajax.searchParams.set("id", tmdbId);
  if (tipo === "tv") {
    ajax.searchParams.set("season", season);
    ajax.searchParams.set("episode", episode);
  }
  // Sem este Referer a API responde {"status":false}, como se não existisse.
  const referer = tipo === "tv"
    ? `https://playerflix.ink/serie/${tmdbId}/${season}/${episode}`
    : `https://playerflix.ink/filme/${tmdbId}`;

  try {
    const res = await fetch(ajax, {
      headers: {
        "User-Agent": UA_NAVEGADOR,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "pt-BR,pt;q=0.5",
        Referer: referer,
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const payload = await res.json();
    const options = (payload as { data?: { options?: unknown } } | null)?.data?.options;
    if (!Array.isArray(options)) return [];

    const vistos = new Set<string>();
    const usados = new Map<string, number>();
    const saida: { url: string; nome: string; prioridade: number }[] = [];

    for (const bruto of options) {
      if (!bruto || typeof bruto !== "object") continue;
      const embed = (bruto as { embed?: unknown }).embed;
      if (typeof embed !== "string" || !embed) continue;
      let parsed: URL;
      try { parsed = new URL(embed); } catch { continue; }
      if (parsed.protocol !== "https:") continue;
      const chave = parsed.toString();
      if (vistos.has(chave)) continue;
      vistos.add(chave);

      const { temExtrator } = detectarProvider(chave);
      const rotuloBruto = String((bruto as { label?: unknown }).label ?? "").trim();
      let nome = !rotuloBruto || /^https?:\/\//i.test(rotuloBruto)
        ? parsed.hostname.replace(/^www\./, "")
        : rotuloBruto.slice(0, 40);
      const repeticoes = (usados.get(nome) || 0) + 1;
      usados.set(nome, repeticoes);
      if (repeticoes > 1) nome = `${nome} ${repeticoes}`;

      const host = parsed.hostname.toLowerCase();
      const prioridade = host === "v1.watchplay.shop" ? 0
        : host === "embedplayer2.xyz" ? 1
        : /embedplayer/.test(host) ? 2
        : /superflixapi/.test(host) ? 3
        : temExtrator ? 4 : 9;

      saida.push({ url: chave, nome, prioridade });
    }

    saida.sort((a, b) => a.prioridade - b.prioridade);
    return saida.map(({ url, nome }) => ({ url, nome }));
  } catch {
    return [];
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

interface Corpo {
  conteudoId?: unknown;
  conteudoTipo?: unknown;
  temporada?: unknown;
  numeroEp?: unknown;
  ambiente?: unknown;
  sessao?: unknown;
  alternativas?: unknown;
}

function normalizarAmbiente(valor: unknown): Ambiente {
  return valor === "electron" || valor === "android" ? valor : "web";
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") || "unknown";

  if (await isIpBlocked(ip)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 429, headers: NO_STORE });
  }

  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    await recordAbuseAttempt(ip);
    audit("origin_rejected", { ip, ua, detail: "/fontes" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    await recordAbuseAttempt(ip);
    audit("auth_failure", { ip, ua, detail: "/fontes sem sessão" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
  }
  const userId = (session.user as { id?: string }).id;
  if (!userId) return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });

  let corpo: Corpo;
  try {
    corpo = await readJsonBody<Corpo>(req, 4096);
  } catch {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
  }

  const ambiente = normalizarAmbiente(corpo.ambiente);
  const conteudoTipo = corpo.conteudoTipo === "serie" ? "serie" : "filme";
  const conteudoId = typeof corpo.conteudoId === "string" ? corpo.conteudoId.slice(0, 64) : "";
  const temporada = Number.isFinite(Number(corpo.temporada)) ? Number(corpo.temporada) : null;
  const numeroEp = Number.isFinite(Number(corpo.numeroEp)) ? Number(corpo.numeroEp) : null;

  // O role só é confirmado no banco, nunca a partir do JWT: é ele que decide se
  // a resposta carrega provider real, host e embedUrl.
  const ehAdmin = await (async () => {
    if ((session.user as { role?: string }).role !== "admin") return false;
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return u?.role === "admin";
  })();

  const projetar = (fontes: FonteReal[]) =>
    fontes.map((f) => (ehAdmin ? projetarAdmin(f) : projetarPublica(f)));

  // ── Segunda fase: alternativas do Playerflix numa sessão já existente ──────
  if (typeof corpo.sessao === "string" && corpo.alternativas === true) {
    const sessao = corpo.sessao;
    const atuais = await lerFontes(sessao, userId);
    if (!atuais) {
      return NextResponse.json({ error: "Sessão de reprodução expirada" }, { status: 410, headers: NO_STORE });
    }

    const primeira = atuais.find((f) => f.provider === "playerflix");
    if (!primeira) return NextResponse.json({ sessao, fontes: projetar(atuais) }, { headers: NO_STORE });

    let tmdbId = "";
    try { tmdbId = new URL(primeira.embedUrl).searchParams.get("id") ?? ""; } catch { /**/ }
    if (!/^\d{1,12}$/.test(tmdbId)) {
      return NextResponse.json({ sessao, fontes: projetar(atuais) }, { headers: NO_STORE });
    }

    const alternativas = await buscarAlternativasPlayerflix(
      tmdbId,
      conteudoTipo === "serie" ? "tv" : "movie",
      String(temporada ?? ""),
      String(numeroEp ?? ""),
    );

    const novas = alternativas
      .map(({ url, nome }) => {
        const { provider, temExtrator } = detectarProvider(url);
        return {
          embedUrl: url,
          provider,
          servidor: `Playerflix · ${nome}`,
          idioma: null,
          tokenized: ehTokenizada(url),
          nativo: suportaExtracaoNativa(url),
          iframeDireto: url.startsWith("https://vidsrc-embed.ru/embed/"),
          iframeDesafio: ehSuperflix(url),
          iframeInvalido: false,
          semExtrator: !temExtrator,
          disponivel: true,
        };
      })
      // Fonte sem extrator só faz sentido onde o iframe do provedor funciona.
      .filter((f) => f.semExtrator === false || ambiente !== "web");

    const crescida = await acrescentarFontes(sessao, userId, novas);
    return NextResponse.json(
      { sessao, fontes: projetar(crescida ?? atuais) },
      { headers: NO_STORE },
    );
  }

  // ── Primeira fase: monta a lista base e abre a sessão ──────────────────────
  if (!conteudoId) {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
  }

  let tmdbId: string | null = null;
  let titulo: string | null = null;
  let urlDub: string | null = null;
  let urlLeg: string | null = null;

  if (conteudoTipo === "filme") {
    const filme = await prisma.filme.findUnique({
      where: { id: conteudoId },
      select: { id: true, titulo: true, tmdbId: true, urlDub: true, urlLeg: true },
    });
    if (!filme) return NextResponse.json({ error: "Conteúdo não encontrado" }, { status: 404, headers: NO_STORE });

    const warez = await buscarWarez2(new URLSearchParams({ item_id: conteudoId }));
    tmdbId = filme.tmdbId;
    titulo = filme.titulo;
    urlDub = mesclar(warez.br, filme.urlDub);
    urlLeg = mesclar(warez.eng, filme.urlLeg);
  } else {
    if (temporada === null || numeroEp === null) {
      return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
    }
    const [serie, episodio] = await Promise.all([
      prisma.serie.findUnique({
        where: { id: conteudoId },
        select: { id: true, titulo: true, tmdbId: true },
      }),
      prisma.episodio.findFirst({
        where: { serieId: conteudoId, temporada, numeroEp },
        select: { urlDub: true, urlLeg: true },
      }),
    ]);
    if (!serie || !episodio) {
      return NextResponse.json({ error: "Conteúdo não encontrado" }, { status: 404, headers: NO_STORE });
    }

    const warez = await buscarWarez2(new URLSearchParams({
      item_id: conteudoId,
      season_num: String(temporada),
      episode_num: String(numeroEp),
    }));

    const redeCanais = serie.tmdbId
      ? REDECANAIS_EPISODIOS[`${serie.tmdbId}:${temporada}:${numeroEp}`] ?? null
      : null;

    tmdbId = serie.tmdbId;
    titulo = serie.titulo;
    urlDub = mesclar(redeCanais ? [...warez.br, redeCanais] : warez.br, episodio.urlDub);
    urlLeg = mesclar(warez.eng, episodio.urlLeg);
  }

  const fontes = numerar(montarFontes({
    tmdbId, titulo, conteudoTipo, temporada, numeroEp, urlDub, urlLeg, ambiente,
  }));

  const sessao = await criarSessaoFontes(userId, ambiente, fontes);

  return NextResponse.json({ sessao, fontes: projetar(fontes) }, { headers: NO_STORE });
}
