export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function isAdmin(req: NextRequest) {
  return req.headers.get("x-admin-token") === process.env.ADMIN_SECRET_TOKEN;
}

// POST /api/admin/episodio/bulk
// Body: { serieId: string, episodios: Array<{ temp, ep, titulo?, urlDub?, urlLeg? }> }
export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { serieId, episodios } = await req.json();
  if (!serieId || !Array.isArray(episodios)) {
    return NextResponse.json({ error: "serieId e episodios[] obrigatórios" }, { status: 400 });
  }

  let ok = 0;
  let errors = 0;

  await Promise.all(
    episodios.map(async (e: any) => {
      const temporada = Number(e.temp ?? e.temporada ?? 1);
      const numeroEp = Number(e.ep ?? e.numeroEp);
      if (!numeroEp) { errors++; return; }

      const epId = `${serieId}-t${temporada}e${numeroEp}`;
      const urlDub = e.urlDub || e.urlBR || e.url_dub || null;
      const urlLeg = e.urlLeg || e.urlENG || e.url_leg || null;

      try {
        await prisma.episodio.upsert({
          where: { id: epId },
          update: {
            titulo: e.titulo || e.nome || null,
            urlDub: urlDub || undefined,
            urlLeg: urlLeg || undefined,
          },
          create: {
            id: epId,
            serieId,
            temporada,
            numeroEp,
            titulo: e.titulo || e.nome || null,
            urlDub,
            urlLeg,
          },
        });
        ok++;
      } catch {
        errors++;
      }
    })
  );

  return NextResponse.json({ ok, errors });
}
