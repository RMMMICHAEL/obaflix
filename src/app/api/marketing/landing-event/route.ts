export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { handleLandingEvent } from "@/lib/marketing/landing-event-ingest";

/** POST /api/marketing/landing-event — ver `src/lib/marketing/landing-event-ingest.ts`. */
export function POST(req: NextRequest): Promise<Response> {
  return handleLandingEvent(req);
}
