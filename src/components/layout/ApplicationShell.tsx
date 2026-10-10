"use client";

import { Providers } from "@/app/providers";
import { AppModeProvider } from "./AppMode";
import { AndroidShell } from "./AndroidShell";
import { Navbar } from "./Navbar";
import { PlayerWakeLock } from "@/components/player/PlayerWakeLock";
import { DesktopVersionGate } from "@/components/ui/DesktopVersionGate";
import { DesktopUpdateBanner } from "@/components/ui/DesktopUpdateBanner";
import { CliqueDesktop } from "@/components/ads/CliqueDesktop";

export default function ApplicationShell({ children, admin }: { children: React.ReactNode; admin: boolean }) {
  return <Providers>{admin ? <main>{children}</main> : <AppModeProvider>
    <PlayerWakeLock />
    <AndroidShell />
    <Navbar />
    <main>{children}</main>
    <DesktopVersionGate />
    <DesktopUpdateBanner />
    <CliqueDesktop />
  </AppModeProvider>}</Providers>;
}
