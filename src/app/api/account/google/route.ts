import { NextRequest } from "next/server";
import { googleAccountState } from "@/lib/googleAccount";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) { return googleAccountState(req); }
