ALTER TABLE "User" ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "OAuthIdentity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "OAuthIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OAuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OAuthIdentity_issuer_subject_key" ON "OAuthIdentity"("issuer", "subject");
CREATE INDEX "OAuthIdentity_userId_idx" ON "OAuthIdentity"("userId");
-- Prisma 5 does not express partial indexes. Revoked identities remain reserved
-- by issuer_subject_key; only the same owner may reactivate them.
CREATE UNIQUE INDEX "OAuthIdentity_active_google_user_key" ON "OAuthIdentity"("userId")
WHERE "issuer" = 'https://accounts.google.com' AND "revokedAt" IS NULL;

CREATE TABLE "OAuthLinkIntent" (
  "id" TEXT NOT NULL,
  "handleHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionBindingHash" TEXT NOT NULL,
  "authVersion" INTEGER NOT NULL,
  "origin" TEXT NOT NULL,
  "reauthenticatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "OAuthLinkIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OAuthLinkIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OAuthLinkIntent_handleHash_key" ON "OAuthLinkIntent"("handleHash");
CREATE INDEX "OAuthLinkIntent_expiresAt_idx" ON "OAuthLinkIntent"("expiresAt");
