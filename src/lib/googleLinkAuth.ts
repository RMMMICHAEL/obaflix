import type { NextAuthOptions } from "next-auth";
import type { NextRequest } from "next/server";
import GoogleProvider from "next-auth/providers/google";
import { authOptions } from "./auth";
import { accountActor, configuredAuthOrigin } from "./googleAccount";
import { completeGoogleLink } from "./oauthGoogleStore";
import { hashOpaque, LINK_COOKIE, validatedGoogleIdentity } from "./oauthGoogle";
import { prisma } from "./prisma";

/** Request-scoped callbacks, fixed NEXTAUTH_URL; never mutate shared options. */
export function googleLinkAuthOptions(req: NextRequest): NextAuthOptions {
  const providers = [...authOptions.providers];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.push(GoogleProvider({
      id: "google-link", name: "Vincular Google", clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET, checks: ["state", "pkce"],
      authorization: { params: { scope: "openid email profile", prompt: "select_account" } },
    }));
  }
  return {
    ...authOptions, providers,
    callbacks: {
      ...authOptions.callbacks,
      async signIn(params) {
        if (params.account?.provider !== "google-link") return authOptions.callbacks!.signIn!(params);
        const origin = configuredAuthOrigin();
        let ok = false;
        try {
          const identity = validatedGoogleIdentity(params.profile);
          const actor = await accountActor(req);
          const handle = req.cookies.get(LINK_COOKIE)?.value;
          if (identity && actor && handle) ok = await completeGoogleLink(actor, handle, identity);
        } catch { /* Reject: no exception metadata, claims or query in logs. */ }
        console.info(ok ? "GOOGLE_LINK_OK" : "GOOGLE_LINK_DENIED");
        // A signIn redirect cancels NextAuth login before jwt/session issuance.
        return `${origin ?? ""}/conta/seguranca?google=${ok ? "linked" : "denied"}`;
      },
    },
    events: {
      ...authOptions.events,
      async signOut(message) {
        if ("token" in message && typeof message.token?.id === "string" && typeof message.token.sid === "string") {
          await prisma.oAuthLinkIntent.updateMany({
            where: { userId: message.token.id, sessionBindingHash: hashOpaque(message.token.sid), consumedAt: null },
            data: { consumedAt: new Date() },
          });
        }
      },
    },
  };
}
