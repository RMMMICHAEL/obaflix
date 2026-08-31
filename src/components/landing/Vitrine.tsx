import { imgUrl } from "@/lib/tmdb";

/**
 * Item de vitrine da landing.
 *
 * Repare no que NÃO existe aqui: `id`, rota, link. A vitrine é apresentação do
 * catálogo, não navegação — nada nela leva ao player ou às páginas de streaming
 * fechadas. O card é um `<figure>` inerte de propósito.
 */
export type ItemVitrine = {
  titulo: string;
  poster: string | null;
  background: string | null;
  ano: number | null;
  nota: number | null;
};

function Nota({ nota }: { nota: number | null }) {
  if (!nota || nota <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
      <svg viewBox="0 0 24 24" className="h-3 w-3 fill-current" aria-hidden>
        <path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z" />
      </svg>
      {nota.toFixed(1)}
    </span>
  );
}

/** Trilho horizontal com scroll-snap. Sem JS: o navegador faz todo o trabalho. */
function Trilho({ children }: { children: React.ReactNode }) {
  return (
    <div className="obaflix-trilho scrollbar-hide flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:gap-4 sm:px-6 lg:px-10">
      {children}
    </div>
  );
}

function Cabecalho({ titulo, sub }: { titulo: string; sub?: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-3 px-4 sm:px-6 lg:px-10">
      <h2 className="text-lg font-extrabold tracking-tight text-white sm:text-xl lg:text-2xl">
        {titulo}
      </h2>
      {sub ? <p className="hidden text-sm text-white/40 sm:block">{sub}</p> : null}
    </div>
  );
}

/** Vitrine de pôsteres — a densa, para "muito conteúdo". */
export function VitrinePosters({
  titulo,
  sub,
  itens,
}: {
  titulo: string;
  sub?: string;
  itens: ItemVitrine[];
}) {
  if (!itens.length) return null;
  return (
    <section className="obaflix-reveal py-5 sm:py-7">
      <Cabecalho titulo={titulo} sub={sub} />
      <Trilho>
        {itens.map((item, i) => (
          <figure
            key={`${titulo}-${i}`}
            className="group relative w-[122px] shrink-0 snap-start sm:w-[150px] lg:w-[172px]"
          >
            <div className="relative overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10 transition duration-300 group-hover:ring-white/25 sm:rounded-2xl">
              <img
                src={imgUrl(item.poster, "w342")}
                alt={item.titulo}
                width={342}
                height={513}
                loading="lazy"
                decoding="async"
                className="aspect-[2/3] w-full object-cover transition duration-500 will-change-transform group-hover:scale-[1.06]"
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/85 to-transparent opacity-0 transition duration-300 group-hover:opacity-100" />
            </div>
            <figcaption className="mt-2 px-0.5">
              <p className="truncate text-[13px] font-semibold text-white/85">{item.titulo}</p>
              <p className="flex items-center gap-2 text-[11px] text-white/40">
                {item.ano ?? ""}
                <Nota nota={item.nota} />
              </p>
            </figcaption>
          </figure>
        ))}
      </Trilho>
    </section>
  );
}

/** Vitrine de backdrops — cards largos, para dar impacto logo abaixo do hero. */
export function VitrineBackdrops({
  titulo,
  sub,
  itens,
}: {
  titulo: string;
  sub?: string;
  itens: ItemVitrine[];
}) {
  if (!itens.length) return null;
  return (
    <section className="obaflix-reveal py-5 sm:py-7">
      <Cabecalho titulo={titulo} sub={sub} />
      <Trilho>
        {itens.map((item, i) => (
          <figure
            key={`${titulo}-${i}`}
            className="group relative w-[248px] shrink-0 snap-start sm:w-[320px] lg:w-[392px]"
          >
            <div className="relative overflow-hidden rounded-xl ring-1 ring-white/10 transition duration-300 group-hover:ring-red-500/40 sm:rounded-2xl">
              <img
                src={imgUrl(item.background ?? item.poster, "w780")}
                alt={item.titulo}
                width={780}
                height={439}
                loading={i < 2 ? "eager" : "lazy"}
                decoding="async"
                className="aspect-video w-full object-cover transition duration-500 will-change-transform group-hover:scale-[1.05]"
              />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black via-black/25 to-transparent" />
              <figcaption className="absolute inset-x-0 bottom-0 p-3 sm:p-4">
                <p className="truncate text-sm font-bold text-white drop-shadow sm:text-base">
                  {item.titulo}
                </p>
                <p className="flex items-center gap-2 text-[11px] text-white/55">
                  {item.ano ?? ""}
                  <Nota nota={item.nota} />
                </p>
              </figcaption>
            </div>
          </figure>
        ))}
      </Trilho>
    </section>
  );
}
