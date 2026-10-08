import { decode } from "next-auth/jwt";

export function tokenAuthVersion(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function validateAuthVersion(
  token: Record<string, unknown> | null,
  loadVersion: (id: string) => Promise<number | null>,
): Promise<boolean> {
  if (!token || typeof token.id !== "string" || !token.id) return false;
  const version = tokenAuthVersion(token.authVersion);
  return version !== null && version === await loadVersion(token.id);
}

/** No cross-request cache: revocation must take effect on the next request. */
export async function decodeVersionedSession(params: Parameters<typeof decode>[0]) {
  const token = await decode(params);
  const { prisma } = await import("./prisma");
  return await validateAuthVersion(token, async id =>
    (await prisma.user.findUnique({ where: { id }, select: { authVersion: true } }))?.authVersion ?? null
  ) ? token : null;
}
