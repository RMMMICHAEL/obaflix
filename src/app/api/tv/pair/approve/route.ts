export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import {
  aprovarPareamento,
  descreverPareamento,
  normalizarCodigo,
} from "@/lib/tvPairing";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/**
 * O lado do celular.
 *
 * GET   descreve o aparelho que está esperando, para a pessoa confirmar que é a
 *       própria TV antes de autorizar.
 * POST  autoriza.
 *
 * Autenticação obrigatória nos dois — é aqui que a conta entra no fluxo. É esta
 * exigência que faz o QR Code ser inofensivo: quem fotografa o código de outra
 * pessoa só consegue aprovar aquela TV para a *própria* conta, e o dono da TV
 * verá uma conta que não é a dele.
 */

function exigirMesmaOrigem(req: NextRequest): NextResponse | null {
  // Chamada de navegador com sessão em cookie: sem esta checagem, um site
  // qualquer poderia disparar a aprovação com o cookie da vítima.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    return NextResponse.json({ erro: "acesso_negado" }, { status: 403, headers: NO_STORE });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) {
    return NextResponse.json({ erro: "nao_autenticado" }, { status: 401, headers: NO_STORE });
  }

  const codigo = normalizarCodigo(req.nextUrl.searchParams.get("c") ?? "");
  if (codigo.length !== 8) {
    return NextResponse.json({ erro: "codigo_invalido" }, { status: 400, headers: NO_STORE });
  }

  const aparelho = await descreverPareamento(codigo);
  if (!aparelho) {
    return NextResponse.json({ erro: "expirado" }, { status: 404, headers: NO_STORE });
  }

  // Só o que ajuda a pessoa a reconhecer o aparelho. A faixa de rede substitui
  // o IP: dá o "é a minha casa" sem guardar nem mostrar o endereço inteiro.
  return NextResponse.json(
    { modelo: aparelho.modelo || "Aparelho de TV", rede: aparelho.rede, criadoEm: aparelho.criadoEm },
    { headers: NO_STORE },
  );
}

export async function POST(req: NextRequest) {
  const bloqueio = exigirMesmaOrigem(req);
  if (bloqueio) return bloqueio;

  const usuario = await getUserFromRequest(req);
  if (!usuario) {
    return NextResponse.json({ erro: "nao_autenticado" }, { status: 401, headers: NO_STORE });
  }

  // Uma TV não aprova outra TV. Aprovar exige o navegador com a sessão da
  // conta; um access token de TV roubado não escala para parear mais aparelhos.
  if (usuario.origem !== "cookie") {
    return NextResponse.json({ erro: "acesso_negado" }, { status: 403, headers: NO_STORE });
  }

  let corpo: { userCode?: unknown };
  try {
    corpo = await readJsonBody(req, 512);
  } catch {
    return NextResponse.json({ erro: "codigo_invalido" }, { status: 400, headers: NO_STORE });
  }

  const codigo = normalizarCodigo(typeof corpo.userCode === "string" ? corpo.userCode : "");
  if (codigo.length !== 8) {
    return NextResponse.json({ erro: "codigo_invalido" }, { status: 400, headers: NO_STORE });
  }

  const resultado = await aprovarPareamento(codigo, usuario.userId);
  if (!resultado.ok) {
    const status = resultado.motivo === "rate_limited" || resultado.motivo === "bloqueado" ? 429 : 410;
    return NextResponse.json({ erro: resultado.motivo }, { status, headers: NO_STORE });
  }

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
