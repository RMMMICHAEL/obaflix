export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { clientIp } from "@/lib/requestSecurity";
import { entitlementsDoUsuario, EntitlementsIndefinidos } from "@/lib/entitlements";
import { isIpBlocked } from "@/lib/playTokens";
import {
  categoriasComCanais,
  listarCanais,
  ROTULO_DA_CATEGORIA,
  type CategoriaDeCanal,
  type ItemDeCanal,
} from "@/lib/canais/catalogo";

/**
 * `GET /api/canais` — o catálogo de canais desta conta.
 *
 * Exige sessão. Não existe versão anônima: a lista já é filtrada por
 * entitlements, e uma variante pública seria uma segunda projeção do catálogo
 * para manter em dia — a forma clássica de um campo privado escapar por só um
 * dos dois caminhos.
 *
 * A lista traz **somente o que esta conta pode abrir** — o filtro por
 * entitlement acontece na consulta, em `listarCanais`. Uma conta gratuita não
 * recebe nem os metadados dos canais premium.
 *
 * O que a resposta **não** contém, em nenhuma circunstância: `.m3u8`, URL da
 * página do player, provider, `providerChannelId`, Referer, User-Agent, cookie.
 * Nada disso é lido aqui — `listarCanais` consulta apenas `Canal`, e a fonte
 * privada mora noutra tabela.
 *
 * `no-store` porque o corpo depende do plano de quem pediu. Um cache
 * compartilhado entregaria a lista de um premium para um gratuito.
 */

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

export interface DependenciasDeCatalogo {
  clientIp: (req: NextRequest) => string;
  isIpBlocked: (ip: string) => Promise<boolean>;
  getUserFromRequest: (req: NextRequest) => Promise<{ userId: string } | null>;
  nivelDaConta: (userId: string) => Promise<string>;
  listarCanais: (o: { categoria?: string; nivelDaConta: string }) => Promise<ItemDeCanal[]>;
  categoriasComCanais: (nivelDaConta: string) => Promise<CategoriaDeCanal[]>;
}

function createCanaisCatalogoHandler(d: DependenciasDeCatalogo) {
  return async function handler(req: NextRequest): Promise<NextResponse> {
    const ip = d.clientIp(req);
    if (await d.isIpBlocked(ip)) {
      return NextResponse.json({ erro: "bloqueado" }, { status: 429, headers: NO_STORE });
    }

    const usuario = await d.getUserFromRequest(req);
    if (!usuario) {
      return NextResponse.json({ erro: "nao_autenticado" }, { status: 401, headers: NO_STORE });
    }

    let nivel: string;
    try {
      nivel = await d.nivelDaConta(usuario.userId);
    } catch (e) {
      // Entitlements indefinidos é inconsistência de banco, não resposta sobre
      // a conta. 503 e catálogo nenhum: um catálogo aberto por engano custa
      // mais do que um erro visível — o mesmo critério de `entitlements.ts`.
      const indefinido = e instanceof EntitlementsIndefinidos;
      return NextResponse.json(
        { erro: indefinido ? "indeterminado" : "falha" },
        { status: 503, headers: NO_STORE },
      );
    }

    const categoria = req.nextUrl.searchParams.get("categoria") ?? undefined;

    try {
      const [canais, categorias] = await Promise.all([
        d.listarCanais({ categoria, nivelDaConta: nivel }),
        d.categoriasComCanais(nivel),
      ]);

      return NextResponse.json(
        {
          canais,
          categorias: categorias.map((c) => ({ id: c, rotulo: ROTULO_DA_CATEGORIA[c] })),
        },
        { headers: NO_STORE },
      );
    } catch {
      return NextResponse.json({ erro: "falha" }, { status: 503, headers: NO_STORE });
    }
  };
}

export const GET = Object.assign(createCanaisCatalogoHandler({
  clientIp,
  isIpBlocked,
  getUserFromRequest,
  nivelDaConta: async (userId) => (await entitlementsDoUsuario(userId)).direitos.canaisNivel,
  listarCanais,
  categoriasComCanais,
}), { createForTest: createCanaisCatalogoHandler });
