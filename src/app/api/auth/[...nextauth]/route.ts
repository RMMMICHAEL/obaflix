import NextAuth from "next-auth";
import { googleLinkAuthOptions } from "@/lib/googleLinkAuth";
import type { NextRequest } from "next/server";

const handler = (req: NextRequest, context: { params: { nextauth: string[] } }) =>
  NextAuth(req, context, googleLinkAuthOptions(req));
export { handler as GET, handler as POST };
