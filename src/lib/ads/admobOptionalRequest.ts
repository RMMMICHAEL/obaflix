import { NextRequest } from "next/server";
import { getUserFromRequest } from "../authSession";
import { entitlementsDoUsuario } from "../entitlements";
import { exigeAnuncio } from "./politica";
import { checkRateLimit, headerMatchesHost } from "../requestSecurity";
import type { Distribution } from "./admobSsv";

/** Existing auth/entitlement implementations are reused, never replaced. */
export async function optionalRequestScope(req: NextRequest, deps = {
  user: getUserFromRequest,
  eligible: async (id: string) => exigeAnuncio((await entitlementsDoUsuario(id)).direitos),
  limit: checkRateLimit,
}) {
  if (!headerMatchesHost(req.headers.get("origin") ?? "", req.headers.get("host") ?? "")) return null;
  const distribution = req.headers.get("x-obaflix-distribution");
  if (distribution !== "play" && distribution !== "direct") return null;
  // This is a routing contract, not APK attestation. Signed ad_unit binds SSV scope.
  const user = await deps.user(req);
  if (!user) return null;
  if (!await deps.eligible(user.userId)) return null;
  if (!(await deps.limit(`ads:admob:optional:${user.userId}`, 30, 60)).allowed) return null;
  return { accountId: user.userId, distribution: distribution as Distribution };
}
