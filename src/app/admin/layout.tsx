import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
export const metadata: Metadata = { title: "Administração", robots: { index: false, follow: false, noarchive: true } };
export default async function Layout({ children }: { children: React.ReactNode }) {
  // Edge middleware is a routing precheck; revocation is enforced in Node.
  const session = await getServerSession(authOptions);
  if (!session?.user || (session.user as { role?: string }).role !== "admin") redirect("/login");
  return children;
}
