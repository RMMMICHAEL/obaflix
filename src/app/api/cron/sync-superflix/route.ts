export const dynamic = "force-dynamic";
// Era 300 no checkout local, onde é ignorado (o runner chama em processo;
// medido: ~6s). 60 é o teto do plano Hobby usado pelos demais crons e evita
// que o deploy seja recusado agora que a rota está versionada.
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { withCronTelemetry } from "@/lib/sync-telemetry";
import { syncSuperflixCalendar } from "@/lib/superflix-calendar";

async function handleGET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const result = await syncSuperflixCalendar();
    return NextResponse.json({
      ok: result.erros.length === 0,
      ...result,
      duracaoMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

// Registra SyncRun "superflix-vercel"; o runner local grava "superflix-local" por conta própria.
export const GET = withCronTelemetry("superflix", handleGET);
