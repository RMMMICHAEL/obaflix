export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/**
 * Estado da sessão, do ponto de vista do aparelho.
 *
 * É a rota que o app de TV consulta na abertura para saber se já está pareado.
 * Existe também como prova viva do ponto único de autorização: responde igual
 * para cookie (site, Electron, móvel) e para Bearer (TV), porque atrás dela há
 * um só `getUserFromRequest`.
 *
 * O corpo é deliberadamente magro. Não devolve e-mail, nome nem userId: a TV
 * não precisa de nada disso para decidir entre mostrar o catálogo e mostrar a
 * tela de pareamento, e o que não sai daqui não aparece em log de proxy, em
 * cache intermediário nem na tela de uma sala de estar.
 *
 * Consumo: nenhuma consulta ao Supabase e nenhum comando no Redis. A resposta
 * sai da verificação da assinatura do token, que é local. Por isso não há rate
 * limit — um limitador custaria um comando de Redis por tentativa e tornaria o
 * abuso mais caro para nós do que para quem abusa. O caminho caro (extração,
 * proxy de mídia) continua protegido pelos limitadores que já existem lá.
 */
export async function GET(req: NextRequest) {
  const usuario = await getUserFromRequest(req);

  if (!usuario) {
    // Resposta única para "sem credencial", "token expirado" e "assinatura
    // inválida". Distinguir os três daria ao cliente um oráculo sobre o estado
    // do token que ele não precisa ter.
    return NextResponse.json(
      { autenticado: false },
      { status: 401, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    {
      autenticado: true,
      origem: usuario.origem,
      // Serve para a TV mostrar qual aparelho ela é na tela de dispositivos.
      // Null quando a credencial veio de cookie — cookie não é de aparelho.
      dispositivo: usuario.deviceId,
    },
    { headers: NO_STORE },
  );
}
