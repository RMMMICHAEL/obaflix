"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { StreamPlayer } from "@/components/player/StreamPlayer";
import { X, Loader2, AlertCircle } from "lucide-react";

type ExtractResult = { stream: string; tipo: "hls" | "mp4" };

export function PlayerView() {
  const params = useSearchParams();
  const router = useRouter();
  const embedUrl = params.get("url") ?? "";

  const [result, setResult] = useState<ExtractResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!embedUrl) {
      setError("Nenhuma URL fornecida.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/player/extract?url=${encodeURIComponent(embedUrl)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.stream) setResult(data as ExtractResult);
        else setError(data.error ?? "Stream não encontrado.");
      })
      .catch(() => setError("Erro ao extrair stream."))
      .finally(() => setLoading(false));
  }, [embedUrl]);

  return (
    <div className="fixed inset-0 bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 bg-black/80 z-10">
        <button onClick={() => router.back()} className="text-white hover:text-zinc-300">
          <X size={22} />
        </button>
        <span className="text-zinc-400 text-xs truncate max-w-sm">{embedUrl}</span>
        <div className="w-6" />
      </div>

      <div className="flex-1 flex items-center justify-center">
        {loading && (
          <div className="flex flex-col items-center gap-3 text-white">
            <Loader2 className="animate-spin" size={36} />
            <span className="text-sm">Extraindo stream...</span>
          </div>
        )}
        {error && !loading && (
          <div className="flex flex-col items-center gap-4 text-white px-6">
            <AlertCircle size={36} className="text-red-400" />
            <p className="text-sm text-zinc-300">{error}</p>
            <a
              href={embedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded text-sm"
            >
              Abrir fonte original
            </a>
          </div>
        )}
        {result && !loading && (
          <StreamPlayer
            stream={result.stream}
            tipo={result.tipo}
            onError={() => setError("Erro ao reproduzir stream.")}
          />
        )}
      </div>
    </div>
  );
}
