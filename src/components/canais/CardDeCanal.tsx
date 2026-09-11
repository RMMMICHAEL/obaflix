"use client";

import { useState } from "react";
import { Tv } from "lucide-react";
import type { ItemDeCanal } from "@/lib/canais/catalogo";

/**
 * Um canal na grade.
 *
 * ## Não há cadeado, porque não há canal bloqueado na lista
 *
 * `GET /api/canais` devolve **só o que esta conta pode abrir** — o filtro é por
 * entitlement, na consulta. Então todo card aqui é abrível, e não existe estado
 * de "bloqueado" para desenhar.
 *
 * Isso não dispensa a checagem no Play: `POST /api/canais/[id]/play` decide do
 * zero a cada vez, porque um id pode chegar por outro caminho e um plano pode
 * cair entre a listagem e o toque.
 *
 * ## Sem EPG
 *
 * Não existe fonte confiável de programação nesta fase, então não há "agora",
 * "a seguir", horário nem barra de progresso. O selo `AO VIVO` é o que se sabe
 * de verdade. Um EPG inventado seria pior do que nenhum: erra na cara do
 * usuário e ninguém confia no resto da tela depois.
 */
export function CardDeCanal({
  canal,
  onAbrir,
}: {
  canal: ItemDeCanal;
  onAbrir: (canal: ItemDeCanal) => void;
}) {
  const [logoFalhou, setLogoFalhou] = useState(false);
  const mostrarLogo = Boolean(canal.logoUrl) && !logoFalhou;

  return (
    <button
      type="button"
      onClick={() => onAbrir(canal)}
      // `min-h` em vez de altura fixa: o nome de canal longo cresce para baixo
      // em vez de ser cortado, e o alvo de toque continua confortável no retrato.
      className="group relative flex min-h-[8.5rem] w-full flex-col items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-center transition hover:border-zinc-600 hover:bg-zinc-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
      aria-label={`Assistir ${canal.nome}, ao vivo`}
    >
      <span className="absolute left-2 top-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
        AO VIVO
      </span>

      <span className="flex h-14 w-full items-center justify-center">
        {mostrarLogo ? (
          // Logo de terceiro, tamanho imprevisível e sem otimização possível:
          // `<img>` com `object-contain` em vez de `next/image`, que exigiria
          // allowlist de domínio para cada provedor de logo.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={canal.logoUrl ?? ""}
            alt=""
            loading="lazy"
            onError={() => setLogoFalhou(true)}
            className="max-h-14 max-w-full object-contain"
          />
        ) : (
          // Fallback de logo ausente ou quebrada: ícone, nunca um espaço vazio
          // que faça a grade parecer meio carregada.
          <Tv className="h-9 w-9 text-zinc-600" aria-hidden />
        )}
      </span>

      <span className="line-clamp-2 text-xs font-medium leading-tight text-zinc-200 group-hover:text-white">
        {canal.nome}
      </span>
    </button>
  );
}
