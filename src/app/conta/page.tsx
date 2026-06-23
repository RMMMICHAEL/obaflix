"use client";

import { useSession } from "next-auth/react";
import { redirect } from "next/navigation";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { imgUrl } from "@/lib/tmdb";

export default function ContaPage() {
  const { data: session, status } = useSession();
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [historico, setHistorico] = useState<any[]>([]);

  useEffect(() => {
    if (status === "unauthenticated") redirect("/login");
  }, [status]);

  useEffect(() => {
    if (!session) return;
    fetch("/api/user/watchlist").then((r) => r.json()).then(setWatchlist);
    fetch("/api/user/history").then((r) => r.json()).then(setHistorico);
  }, [session]);

  if (status === "loading") return <div className="min-h-screen flex items-center justify-center"><p className="text-zinc-400">Carregando...</p></div>;
  if (!session) return null;

  return (
    <div className="pt-20 px-4 md:px-8 pb-16 min-h-screen">
      <div className="flex items-center gap-4 mb-10">
        <div className="w-16 h-16 rounded-full bg-zinc-700 flex items-center justify-center text-2xl font-bold text-white">
          {session.user?.name?.charAt(0) ?? "U"}
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">{session.user?.name ?? "Usuário"}</h1>
          <p className="text-zinc-400 text-sm">{session.user?.email}</p>
        </div>
      </div>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-white mb-4">Minha Lista ({watchlist.length})</h2>
        <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9 gap-3">
          {watchlist.map((w) => {
            const item = w.filme ?? w.serie;
            if (!item) return null;
            const href = w.conteudoTipo === "filme" ? `/filme/${item.id}` : `/serie/${item.id}`;
            return (
              <Link key={`${w.userId}-${w.conteudoId}`} href={href} className="rounded overflow-hidden group">
                <div className="aspect-[2/3] relative bg-zinc-800">
                  <Image
                    src={item.poster ? imgUrl(item.poster, "w185") : "/placeholder.jpg"}
                    alt={item.titulo}
                    fill
                    className="object-cover group-hover:opacity-75 transition"
                  />
                </div>
                <p className="text-xs text-zinc-400 mt-1 truncate">{item.titulo}</p>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
