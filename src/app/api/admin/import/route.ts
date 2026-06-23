export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function isAdmin(req: NextRequest) {
  const token = req.headers.get("x-admin-token");
  return token === process.env.ADMIN_SECRET_TOKEN;
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { tipo, dados } = await req.json();
  if (!Array.isArray(dados)) return NextResponse.json({ error: "dados deve ser array" }, { status: 400 });

  let ok = 0;
  if (tipo === "filmes") {
    for (const f of dados) {
      await prisma.filme.upsert({
        where: { id: String(f.id) },
        update: { titulo: f.titulo, urlDub: f.urlBR, urlLeg: f.urlENG || null },
        create: { id: String(f.id), titulo: f.titulo, urlDub: f.urlBR, urlLeg: f.urlENG || null },
      });
      ok++;
    }
  }

  return NextResponse.json({ ok, total: dados.length });
}
