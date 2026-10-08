import { NextRequest } from "next/server";
import { googleAccountMutation } from "@/lib/googleAccount";
export const dynamic = "force-dynamic";
export function POST(req: NextRequest) { return googleAccountMutation(req, "unlink"); }
