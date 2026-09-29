export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { entitlementsDoUsuario } from "@/lib/entitlements";
import { detectarAmbiente, HEADER_CLIENTE } from "@/config/site-mode";
import { bannerDesktopAtivo, decidirBannerDesktop, type ContaDoBanner } from "@/lib/ads/bannerDesktop";

/**
 * `GET /api/ads/banner-desktop` — "este usuário do app Windows vê o banner?".
 *
 * Resposta: `{ exibir: boolean }` e mais nada. Sem nome de plano, de rede
 * publicitária ou de zona: quem precisa saber disso é o documento isolado do
 * banner, não o app.
 *
 * Custo: navegador e Android saem antes de ler sessão. No desktop, uma leitura
 * de JWT e `entitlementsDoUsuario` — que responde do Redis (120 s, a mesma
 * chave que o player já aquece) e só vai ao Postgres no miss. O
 * `Cache-Control: private` deixa o próprio Chromium do app reaproveitar a
 * resposta pela mesma janela, então navegar entre Home e catálogo não gera
 * invocação nova.
 */
const SEM_BANNER = { exibir: false } as const;
const CACHE_PRIVADO = { "Cache-Control": "private, max-age=120", Vary: "Cookie" };

function createBannerDesktopHandler(deps: {
  getUserFromRequest?: typeof getUserFromRequest;
  entitlementsDoUsuario?: typeof entitlementsDoUsuario;
  env?: Record<string, string | undefined>;
} = {}) {
  const usuarioDe = deps.getUserFromRequest ?? getUserFromRequest;
  const entitlements = deps.entitlementsDoUsuario ?? entitlementsDoUsuario;

  return async function GET(req: NextRequest) {
    const ativo = bannerDesktopAtivo(deps.env);
    const ambiente = detectarAmbiente(req.headers.get("user-agent"), req.headers.get(HEADER_CLIENTE));
    // Curto-circuito barato: nada de sessão, Redis ou Postgres para quem nunca
    // veria o banner.
    if (!ativo || ambiente !== "desktop") {
      return NextResponse.json(SEM_BANNER, { headers: { "Cache-Control": "no-store" } });
    }

    let conta: ContaDoBanner;
    try {
      const user = await usuarioDe(req);
      conta = user
        ? { tipo: "resolvida", direitos: (await entitlements(user.userId)).direitos }
        : { tipo: "anonima" };
    } catch {
      // Direito indefinido não vira banner para quem talvez pague.
      conta = { tipo: "indefinida" };
    }

    const exibir = decidirBannerDesktop({ ativo, ambiente, conta });
    return NextResponse.json({ exibir }, { headers: CACHE_PRIVADO });
  };
}

export const GET = Object.assign(createBannerDesktopHandler(), {
  createForTest: createBannerDesktopHandler,
});
