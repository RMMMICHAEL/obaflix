"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

export function DesktopUpdateBanner() {
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);

  useEffect(() => {
    const desktop = (window as any).obaflixDesktop;
    if (!desktop) return;

    desktop.onUpdateReady((version: string) => {
      setPendingVersion(version || "nova versão");
    });
  }, []);

  if (!pendingVersion) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex items-center gap-3 bg-zinc-900 border border-white/10 rounded-xl px-4 py-3 shadow-2xl">
      <Download size={18} className="text-[#E50914] flex-shrink-0" />
      <div className="text-sm">
        <p className="text-white font-semibold">Atualização disponível</p>
        <p className="text-white/50 text-xs">{pendingVersion}</p>
      </div>
      <button
        onClick={() => (window as any).obaflixDesktop?.installUpdate()}
        className="ml-2 bg-[#E50914] hover:bg-[#f00] text-white text-xs font-bold px-3 py-1.5 rounded-lg transition"
      >
        Instalar
      </button>
      <button
        onClick={() => setPendingVersion(null)}
        className="text-white/30 hover:text-white/60 text-xs transition"
      >
        Depois
      </button>
    </div>
  );
}
