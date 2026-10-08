import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { GoogleIdentity, hashOpaque, LinkActor, LinkIntent, matchesLinkIntent } from "./oauthGoogle";

export const localGoogleUserSelect = {
  id: true, email: true, nome: true, avatar: true, role: true, authVersion: true,
} as const;

export async function findLinkedGoogleUser(identity: GoogleIdentity) {
  const row = await prisma.oAuthIdentity.findUnique({
    where: { issuer_subject: identity }, select: { revokedAt: true, user: { select: localGoogleUserSelect } },
  });
  return row && row.revokedAt === null ? row.user : null;
}

export async function saveLinkIntent(intent: LinkIntent) {
  await prisma.oAuthLinkIntent.create({ data: intent });
}

/** Same user-row lock serializes link/unlink and concurrent callbacks. */
async function lockActor(tx: Prisma.TransactionClient, actor: LinkActor) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: actor.userId }, select: { authVersion: true } });
  if (!user || user.authVersion !== actor.authVersion) throw new Error("GOOGLE_LINK_DENIED");
}

export async function completeGoogleLink(actor: LinkActor, handle: string, identity: GoogleIdentity, at?: Date) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) return false;
  try {
    return await prisma.$transaction(async tx => {
      await lockActor(tx, actor);
      const now = at ?? new Date();
      const intent = await tx.oAuthLinkIntent.findUnique({ where: { handleHash: hashOpaque(handle) } });
      if (!intent || !matchesLinkIntent(intent, actor, handle, now)) return false;
      const existing = await tx.oAuthIdentity.findUnique({ where: { issuer_subject: identity } });
      if (existing && existing.userId !== actor.userId) return false;
      const other = await tx.oAuthIdentity.findFirst({
        where: { userId: actor.userId, issuer: identity.issuer, revokedAt: null, subject: { not: identity.subject } },
      });
      if (other) return false;
      const consumed = await tx.oAuthLinkIntent.updateMany({
        where: { id: intent.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now },
      });
      if (consumed.count !== 1) return false;
      if (existing) await tx.oAuthIdentity.update({ where: { id: existing.id }, data: { revokedAt: null, linkedAt: now } });
      else await tx.oAuthIdentity.create({ data: { ...identity, userId: actor.userId, linkedAt: now } });
      return true;
    });
  } catch {
    // Includes uniqueness races; never log Prisma errors containing identities.
    return false;
  }
}

export async function revokeGoogleLink(actor: LinkActor, passwordHash: string, now = new Date()) {
  return prisma.$transaction(async tx => {
    await lockActor(tx, actor);
    const unchangedPassword = await tx.user.count({ where: { id: actor.userId, senhaHash: passwordHash } });
    if (unchangedPassword !== 1) throw new Error("GOOGLE_UNLINK_DENIED");
    await tx.oAuthIdentity.updateMany({ where: { userId: actor.userId, revokedAt: null }, data: { revokedAt: now } });
    await tx.oAuthLinkIntent.updateMany({ where: { userId: actor.userId, consumedAt: null }, data: { consumedAt: now } });
    await tx.user.update({ where: { id: actor.userId }, data: { authVersion: { increment: 1 } } });
  });
}
