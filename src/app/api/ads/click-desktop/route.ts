export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { entitlementsDoUsuario } from "@/lib/entitlements";
import { detectarAmbiente, HEADER_CLIENTE } from "@/config/site-mode";
import type { ContaDoBanner } from "@/lib/ads/bannerDesktop";
import { cliqueDesktopAtivo, decidirCliqueDesktop, frequenciaDoCliqueDesktop } from "@/lib/ads/cliqueDesktop";

/**
 * `GET /api/ads/click-desktop` — "este usuário do app Windows recebe anúncio
 * por clique, e com que frequência?".
 *
 * Resposta: `{ exibir: false }` ou `{ exibir: true, intervaloCliques,
 * cooldownSeg }`. Nunca o Direct Link, nome de rede ou zona: a URL mora só no
 * processo principal do Electron.
 *
 * Custo: o mesmo da rota do banner. Navegador e Android saem antes de ler
 * sessão; no desktop, JWT + `entitlementsDoUsuario` (Redis 120 s, mesma chave
 * do banner e do player; Postgres só no miss). `Cache-Control: private` de
 * 120 s: o Chromium do app reaproveita a resposta nessa janela.
 */
const SEM_ANUNCIO = { exibir: false } as const;
const CACHE_PRIVADO = { "Cache-Control": "private, max-age=120", Vary: "Cookie" };

function createCliqueDesktopHandler(deps: {
  getUserFromRequest?: typeof getUserFromRequest;
  entitlementsDoUsuario?: typeof entitlementsDoUsuario;
  env?: Record<string, string | undefined>;
} = {}) {
  const usuarioDe = deps.getUserFromRequest ?? getUserFromRequest;
  const entitlements = deps.entitlementsDoUsuario ?? entitlementsDoUsuario;

  return async function GET(req: NextRequest) {
    const ativo = cliqueDesktopAtivo(deps.env);
    const ambiente = detectarAmbiente(req.headers.get("user-agent"), req.headers.get(HEADER_CLIENTE));
    if (!ativo || ambiente !== "desktop") {
      return NextResponse.json(SEM_ANUNCIO, { headers: { "Cache-Control": "no-store" } });
    }

    let conta: ContaDoBanner;
    try {
      const user = await usuarioDe(req);
      conta = user
        ? { tipo: "resolvida", direitos: (await entitlements(user.userId)).direitos }
        : { tipo: "anonima" };
    } catch {
      // Direito indefinido não vira anúncio para quem talvez pague.
      conta = { tipo: "indefinida" };
    }

    if (!decidirCliqueDesktop({ ativo, ambiente, conta })) {
      return NextResponse.json(SEM_ANUNCIO, { headers: CACHE_PRIVADO });
    }
    const { intervaloCliques, cooldownSeg } = frequenciaDoCliqueDesktop(deps.env);
    return NextResponse.json({ exibir: true, intervaloCliques, cooldownSeg }, { headers: CACHE_PRIVADO });
  };
}

export const GET = Object.assign(createCliqueDesktopHandler(), {
  createForTest: createCliqueDesktopHandler,
});
