export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";

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
/**
 * E-mail reduzido ao que basta para reconhecer a conta.
 *
 * "michael@gmail.com" vira "mic***@gmail.com". Suficiente para conferir se a TV
 * está na mesma conta do celular, e pouco o bastante para ficar numa tela de
 * sala de estar sem entregar o endereço a quem passa.
 */
function mascarar(email: string): string {
  const [nome, dominio] = email.split("@");
  if (!dominio) return "***";
  return nome.slice(0, 3) + "***@" + dominio;
}

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

  // A conta só é consultada quando alguém pede — `?conta=1`, que só a tela de
  // perfil da TV usa. O caminho de abertura do aplicativo continua com zero
  // consulta ao banco, que é a razão de esta rota não ter rate limit.
  let conta: string | null = null;
  if (req.nextUrl.searchParams.get("conta") === "1") {
    const dono = await prisma.user.findUnique({
      where: { id: usuario.userId },
      select: { email: true },
    });
    conta = dono?.email ? mascarar(dono.email) : null;
  }

  return NextResponse.json(
    {
      autenticado: true,
      origem: usuario.origem,
      // Serve para a TV mostrar qual aparelho ela é na tela de dispositivos.
      // Null quando a credencial veio de cookie — cookie não é de aparelho.
      dispositivo: usuario.deviceId,
      // Mascarado, e só quando pedido. Sem isto não havia como responder "a TV
      // está na mesma conta do celular?", que é a primeira pergunta quando as
      // duas telas mostram listas diferentes de Continuar Assistindo.
      ...(conta ? { conta } : {}),
    },
    { headers: NO_STORE },
  );
}
