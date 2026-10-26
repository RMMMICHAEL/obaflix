import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { comHostOficial } from "@/lib/authHost";

const handler = NextAuth(authOptions);
// Domínios oficiais: o NextAuth usa o host do próprio pedido (ver authHost.ts). Outros hosts: comportamento de sempre.
const comHost = comHostOficial(handler as unknown as (req: Request, ctx: unknown) => Promise<Response>);
export { comHost as GET, comHost as POST };
