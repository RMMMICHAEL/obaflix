import { Suspense } from "react";
import { PlayerView } from "./PlayerView";

export default function PlayerPage() {
  return (
    <Suspense fallback={<div className="fixed inset-0 bg-black flex items-center justify-center text-white">Carregando...</div>}>
      <PlayerView />
    </Suspense>
  );
}
