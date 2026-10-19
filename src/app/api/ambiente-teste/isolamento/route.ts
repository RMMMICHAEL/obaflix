export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ambienteTesteIsolado } from "@/lib/isolamentoTeste";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * OK/FALHA do isolamento do Preview de testes. Somente leitura: não escreve no
 * banco nem chama Redis ou pagamento. Fora de Preview com OBAFLIX_AMBIENTE=teste
 * responde 404 (Production não expõe nada); no Preview, o acesso já passa pela
 * Vercel Authentication do projeto.
 */
export async function GET() {
  if (process.env.VERCEL_ENV !== "preview" || process.env.OBAFLIX_AMBIENTE !== "teste") {
    return new NextResponse(null, { status: 404, headers: NO_STORE });
  }
  if (!ambienteTesteIsolado(process.env)) return new NextResponse("FALHA", { status: 503, headers: NO_STORE });
  try {
    // Transação READ ONLY: o Postgres recusa qualquer escrita dentro dela.
    const [, marcador] = await prisma.$transaction([
      prisma.$executeRawUnsafe("SET TRANSACTION READ ONLY"),
      prisma.$queryRawUnsafe<{ ambiente: string }[]>(`SELECT "ambiente" FROM "_ObaflixAmbiente"`),
    ]);
    const ok = marcador.length === 1 && marcador[0].ambiente === "teste";
    return new NextResponse(ok ? "OK" : "FALHA", { status: ok ? 200 : 503, headers: NO_STORE });
  } catch {
    return new NextResponse("FALHA", { status: 503, headers: NO_STORE });
  }
}
