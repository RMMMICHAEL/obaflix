"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import { TrailerModal } from "./TrailerModal";

interface Props {
  videoKey: string;
  titulo: string;
}

export function TrailerButton({ videoKey, titulo }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 bg-zinc-700/80 text-white font-semibold px-6 py-2.5 rounded hover:bg-zinc-600 transition"
      >
        <Play size={16} /> Trailer
      </button>
      {open && <TrailerModal videoKey={videoKey} titulo={titulo} onClose={() => setOpen(false)} />}
    </>
  );
}
