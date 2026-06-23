"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";

interface Props {
  urlDub: string | null;
  urlLeg: string | null;
  titulo: string;
  conteudoId: string;
  conteudoTipo: "filme" | "serie";
  episodioId?: string;
  temporada?: number;
  numeroEp?: number;
  prevUrl?: string;
  nextUrl?: string;
  duracaoSeg?: number;
}


export function CustomPlayer({
  urlDub, urlLeg, titulo, conteudoId, conteudoTipo,
  episodioId, temporada, numeroEp, prevUrl, nextUrl, duracaoSeg,
}: Props) {
  const router = useRouter();
  const [audio, setAudio] = useState<"dub" | "leg">(urlDub ? "dub" : "leg");
  const [fonteIdx, setFonteIdx] = useState(0);
  const progressoRef = useRef(0);

  const fontes = ((audio === "dub" ? urlDub : urlLeg) ?? urlDub ?? urlLeg ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  const embedUrl = fontes[fonteIdx] ?? "";

  const saveProgress = useCallback(async () => {
    if (!progressoRef.current) return;
    await fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conteudoId, conteudoTipo, episodioId,
        temporada, numeroEp,
        progressoSeg: progressoRef.current,
        duracaoSeg,
      }),
    });
  }, [conteudoId, conteudoTipo, episodioId, temporada, numeroEp, duracaoSeg]);

  useEffect(() => {
    const interval = setInterval(saveProgress, 10000);
    return () => clearInterval(interval);
  }, [saveProgress]);

  // Incrementa progresso a cada segundo
  useEffect(() => {
    const interval = setInterval(() => { progressoRef.current += 1; }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* top bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/80 z-10">
        <button onClick={() => router.back()} className="text-white hover:text-zinc-300 transition">
          <X size={24} />
        </button>
        <span className="text-white font-semibold truncate max-w-xs md:max-w-lg">
          {titulo}{temporada && numeroEp ? ` — T${temporada} EP${numeroEp}` : ""}
        </span>
        <div className="w-8" />
      </div>

      {/* iframe via proxy (sem anúncios) */}
      <div className="flex-1 relative">
        {embedUrl ? (
          <iframe
            key={embedUrl}
            src={embedUrl}
            className="w-full h-full border-0"
            allowFullScreen
            allow="autoplay; fullscreen; picture-in-picture"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
            Nenhuma fonte disponível
          </div>
        )}
      </div>

      {/* bottom controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-black/80 z-10">
        <div className="flex items-center gap-2">
          <span className="text-zinc-400 text-xs">Fonte:</span>
          {fontes.map((_, i) => (
            <button
              key={i}
              onClick={() => setFonteIdx(i)}
              className={`text-xs px-3 py-1 rounded transition ${
                fonteIdx === i
                  ? "bg-white text-black font-bold"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {i + 1}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {urlDub && (
            <button
              onClick={() => { setAudio("dub"); setFonteIdx(0); }}
              className={`text-xs px-3 py-1 rounded transition ${
                audio === "dub" ? "bg-blue-600 text-white font-bold" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              DUB
            </button>
          )}
          {urlLeg && (
            <button
              onClick={() => { setAudio("leg"); setFonteIdx(0); }}
              className={`text-xs px-3 py-1 rounded transition ${
                audio === "leg" ? "bg-zinc-200 text-black font-bold" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              LEG
            </button>
          )}
        </div>

        <div className="flex gap-2">
          {prevUrl && (
            <button onClick={() => router.push(prevUrl)} className="flex items-center gap-1 text-xs text-zinc-300 hover:text-white transition">
              <ChevronLeft size={16} /> Anterior
            </button>
          )}
          {nextUrl && (
            <button onClick={() => router.push(nextUrl)} className="flex items-center gap-1 text-xs text-white bg-white/10 hover:bg-white/20 px-3 py-1 rounded transition">
              Próximo <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
