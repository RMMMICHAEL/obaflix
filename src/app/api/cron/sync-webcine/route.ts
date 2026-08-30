export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { executarSyncWebcine } from "@/lib/cron/webcine";

/**
 * Disparo manual do sync WebCine.
 *
 * Deixou de ter cron proprio: o plano Hobby aceita 2 cron jobs, e esta coleta
 * agora roda dentro de /api/cron/sync, na mesma cadencia diaria e sem invocacao
 * extra. A rota fica para poder rodar sob demanda (mesmo CRON_SECRET) sem
 * esperar a janela das 3h.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log: string[] = [];
  try {
    const r = await executarSyncWebcine(log);
    log.push(`✅ ${r.elapsed}s — filmes: ${r.totalFilmes} | séries: ${r.totalSeries} | eps: ${r.totalEps}`);
    return NextResponse.json({ ok: true, ...r });
  } catch (err: any) {
    log.push(`❌ Erro: ${err.message}`);
    return NextResponse.json({ ok: false, log, error: err.message }, { status: 500 });
  } finally {
    await prisma.$disconnect();
  }
}
