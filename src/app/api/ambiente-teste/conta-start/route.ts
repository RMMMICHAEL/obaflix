export const dynamic = "force-dynamic";
import { timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ambienteTesteIsolado } from "@/lib/isolamentoTeste";

// TEMPORÁRIA: cria UMA conta de teste Cortes Start (cortesia, sem cobrança) no Neon
// de TESTE, como foi feito para a conta Cortes Pro. Só cria. Remover após executar.
const NO_STORE = { "Cache-Control": "no-store" };
const EMAIL = "cortes.start@teste.obaflix.invalid";

function tokenValido(recebido: string | null): boolean {
  const esperado = process.env.PREPARO_TOKEN ?? "";
  if (esperado.length < 32 || !recebido) return false;
  const a = Buffer.from(recebido), b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview" || process.env.OBAFLIX_AMBIENTE !== "teste"
    || process.env.VERCEL_GIT_COMMIT_REF !== "feat/cortes-permissoes") {
    return new NextResponse(null, { status: 404, headers: NO_STORE });
  }
  if (!tokenValido(req.headers.get("x-preparo-token"))) return new NextResponse(null, { status: 404, headers: NO_STORE });
  if (!ambienteTesteIsolado(process.env)) return NextResponse.json({ etapa: "isolamento", ok: false }, { status: 503, headers: NO_STORE });
  const corpo = (await req.json().catch(() => ({}))) as { senha?: string };
  if (!corpo.senha || corpo.senha.length < 12) return NextResponse.json({ etapa: "entrada", ok: false }, { status: 400, headers: NO_STORE });

  try {
    const marcador = await prisma.$queryRawUnsafe<{ ambiente: string }[]>(`SELECT "ambiente" FROM "_ObaflixAmbiente"`);
    if (marcador.length !== 1 || marcador[0].ambiente !== "teste") throw new Error("marcador");
    const plano = await prisma.plano.findUnique({ where: { id: "cortes-start" }, select: { cortesNivel: true } });
    if (plano?.cortesNivel !== "individual") throw new Error("plano-start-ausente");
    if (await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } })) throw new Error("conta-ja-existe");

    const senhaHash = await bcrypt.hash(corpo.senha, 10);
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: EMAIL, nome: "Teste Cortes Start", senhaHash } });
      await tx.assinatura.create({
        data: { userId: user.id, planoId: "cortes-start", status: "ATIVA", origem: "cortesia", iniciaEm: new Date(), terminaEm: new Date("2027-12-31") },
      });
    });
    return NextResponse.json({ ok: true, conta: { plano: "cortes-start", cortesNivel: "individual" } }, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n").pop()?.slice(0, 160) : "erro";
    return NextResponse.json({ ok: false, erro: msg }, { status: 500, headers: NO_STORE });
  }
}
