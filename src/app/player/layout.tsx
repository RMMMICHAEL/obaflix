import type { Metadata } from "next";
export const metadata: Metadata = { title: "Player", robots: { index: false, follow: false, noarchive: true } };
export default function Layout({ children }: { children: React.ReactNode }) { return children; }
