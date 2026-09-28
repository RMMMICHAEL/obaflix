import { NextRequest, NextResponse } from "next/server";
import { requireCatalogSync } from "@/lib/catalogSyncAuth";
import { prisma } from "@/lib/prisma";
import { sanitizeErrorSummary } from "@/lib/sync-sources";

export const dynamic = "force-dynamic";
const statuses = new Set(["RUNNING", "SUCCESS", "FAILED", "SKIPPED"]);
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const count = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0));

export async function POST(req: NextRequest) {
  const guard = await requireCatalogSync(req); if (guard) return guard;
  try {
    const body = await req.json();
    const source = text(body.source, 80);
    const job = text(body.job, 80);
    const status = text(body.status, 20).toUpperCase();
    if (!source || !job || !statuses.has(status)) return NextResponse.json({ error: "source, job e status inválidos" }, { status: 400 });
    const data = {
      source, job, status, heartbeatAt: new Date(),
      finishedAt: status === "RUNNING" ? null : new Date(),
      expectedNextAt: body.expectedNextAt ? new Date(body.expectedNextAt) : null,
      found: body.found === undefined || body.found === null ? null : count(body.found),
      moviesAdded: count(body.moviesAdded), moviesUpdated: count(body.moviesUpdated),
      seriesAdded: count(body.seriesAdded), seriesUpdated: count(body.seriesUpdated),
      episodesAdded: count(body.episodesAdded), episodesUpdated: count(body.episodesUpdated),
      errors: count(body.errors), errorSummary: sanitizeErrorSummary(body.errorSummary),
    };
    const run = body.runId
      ? await prisma.syncRun.update({ where: { id: text(body.runId, 64) }, data })
      : await prisma.syncRun.create({ data });
    return NextResponse.json({ ok: true, runId: run.id });
  } catch {
    return NextResponse.json({ error: "Payload inválido ou execução inexistente" }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  const guard = await requireCatalogSync(req); if (guard) return guard;
  const runs = await prisma.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 25 });
  return NextResponse.json({ runs });
}
