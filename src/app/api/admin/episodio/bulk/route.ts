export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, withCors } from "@/lib/auth";

export async function OPTIONS(req: NextRequest) {
  const guard = await requireAdmin(req); return guard ?? new NextResponse(null, { status: 204 });
}

// POST /api/admin/episodio/bulk
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

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

      const urlDub = e.urlDub || e.urlBR || e.url_dub || null;
      const urlLeg = e.urlLeg || e.urlENG || e.url_leg || null;
      const titulo = e.titulo || e.nome || null;

      try {
        // Upsert pela constraint única (serieId, temporada, numeroEp) — evita duplicatas
        await prisma.episodio.upsert({
          where: { serieId_temporada_numeroEp: { serieId, temporada, numeroEp } },
          update: {
            titulo: titulo || undefined,
            urlDub: urlDub || undefined,
            urlLeg: urlLeg || undefined,
          },
          create: {
            id: `${serieId}-t${temporada}e${numeroEp}`,
            serieId,
            temporada,
            numeroEp,
            titulo,
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

  return withCors(NextResponse.json({ ok, errors }), req);
}
