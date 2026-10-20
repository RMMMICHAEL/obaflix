import type { Metadata } from "next";
// Preserve the runtime behavior previously inherited from the root layout.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Administração", robots: { index: false, follow: false, noarchive: true } };
export default function Layout({ children }: { children: React.ReactNode }) { return children; }
