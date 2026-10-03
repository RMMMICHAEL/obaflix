"use client";

import { useEffect } from "react";
import { registrarErroNavegacao } from "@/lib/playerNavegacaoDiag";

export default function ErroEpisodio({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { registrarErroNavegacao("episode:boundary", error); }, [error]);
  return <div className="fixed inset-0 bg-black text-white flex flex-col items-center justify-center gap-4">
    <p>Não foi possível abrir este episódio.</p>
    <button type="button" onClick={reset}>Tentar novamente</button>
  </div>;
}
