"use client";

import { useSession } from "next-auth/react";
import { redirect } from "next/navigation";
import { useEffect, useState } from "react";
import { Upload } from "lucide-react";

export default function AdminPage() {
  const { data: session, status } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [tipo, setTipo] = useState<"filmes" | "series">("filmes");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string>("");
  const [token, setToken] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") redirect("/login");
    if (status === "authenticated" && (session?.user as any)?.role !== "admin") redirect("/");
  }, [status, session]);

  const handleImport = async () => {
    if (!file || !token) return;
    setLoading(true);
    setResult("");
    try {
      const text = await file.text();
      const dados = JSON.parse(text);
      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ tipo, dados }),
      });
      const d = await res.json();
      setResult(res.ok ? `✓ ${d.ok} / ${d.total} importados` : `Erro: ${d.error}`);
    } catch (e) {
      setResult("Erro ao processar JSON.");
    }
    setLoading(false);
  };

  if (status === "loading") return null;

  return (
    <div className="pt-20 px-4 md:px-8 pb-16 min-h-screen">
      <h1 className="text-2xl font-bold text-white mb-8">Painel Admin</h1>

      <div className="max-w-lg bg-zinc-900 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-5">Importar Catálogo</h2>

        <div className="flex gap-2 mb-4">
          {(["filmes", "series"] as const).map((t) => (
            <button key={t} onClick={() => setTipo(t)}
              className={`text-sm px-4 py-1.5 rounded transition ${tipo === t ? "bg-red-600 text-white font-bold" : "bg-zinc-800 text-zinc-300"}`}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <input
          type="text" placeholder="Admin Secret Token"
          value={token} onChange={(e) => setToken(e.target.value)}
          className="w-full bg-zinc-800 text-white text-sm px-4 py-2.5 rounded outline-none mb-3"
        />

        <label className="flex items-center gap-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm px-4 py-3 rounded cursor-pointer mb-4 transition">
          <Upload size={16} />
          {file ? file.name : "Selecionar JSON"}
          <input type="file" accept=".json" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>

        <button
          onClick={handleImport} disabled={loading || !file || !token}
          className="w-full bg-red-600 text-white font-bold py-2.5 rounded hover:bg-red-700 transition disabled:opacity-50"
        >
          {loading ? "Importando..." : "Importar"}
        </button>

        {result && <p className={`mt-4 text-sm ${result.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>{result}</p>}
      </div>

      <p className="text-zinc-500 text-xs mt-6">
        Para importações grandes (15k+ filmes), use o script CLI:<br />
        <code className="text-zinc-400">npx tsx scripts/import.ts --filmes filmes_completo.json --series series_completo.json</code>
      </p>
    </div>
  );
}
