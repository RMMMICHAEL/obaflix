export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { syncSuperflixCalendar } from "@/lib/superflix-calendar";

export async function GET(req: NextRequest) {
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
