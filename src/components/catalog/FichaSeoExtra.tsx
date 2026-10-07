import Link from "next/link";
import { INSTALADORES, type Instalador } from "@/config/downloads";
import { genrePath } from "@/lib/catalog-url";

/**
 * Bloco de conteúdo SEO visível no fim da ficha. Não há texto escondido: tudo
 * aqui é mostrado ao usuário e é verdadeiro.
 *
 *   - "Onde assistir <Título>": a copy real — o conteúdo está no aplicativo, não
 *     há reprodução no navegador. `extra` é uma frase opcional derivada SÓ de
 *     dados reais (ano, duração, nº de temporadas/episódios);
 *   - CTA de aquisição: links diretos para os instaladores (R2), `nofollow`;
 *   - Gêneros reais como links HTML para as páginas de gênero canônicas.
 *
 * Server component: nenhuma URL de mídia, nenhum estado de sessão.
 */

const PLATAFORMAS: { nome: string; instalador: Instalador }[] = [
  { nome: "Android", instalador: INSTALADORES.android },
  { nome: "Android TV", instalador: INSTALADORES.androidTv },
  { nome: "Windows", instalador: INSTALADORES.windows },
];

export function FichaSeoExtra({
  titulo,
  tipo,
  generos,
  extra,
  dub = false,
  leg = false,
}: {
  titulo: string;
  tipo: "filme" | "serie";
  generos: { id: number; nome: string }[];
  extra?: string | null;
  /** Disponibilidade de áudio — só os booleanos chegam aqui, nunca a URL. */
  dub?: boolean;
  leg?: boolean;
}) {
  const copy =
    tipo === "filme"
      ? `Para assistir ${titulo} online, use o aplicativo Obaflix disponível para Android, Android TV e Windows. Nesta página você encontra sinopse, elenco, gêneros e informações do título.`
      : `Para assistir ${titulo} online e acompanhar seus episódios, use o aplicativo Obaflix para Android, Android TV ou Windows. Nesta página você encontra temporadas, episódios, elenco e gêneros.`;

  // Frase de disponibilidade: derivada só de booleanos, visível, sem URL.
  const disponibilidade =
    dub && leg
      ? "Disponível no aplicativo com opções dublada e legendada."
      : dub
        ? "Disponível no aplicativo com opção dublada."
        : leg
          ? "Disponível no aplicativo com opção legendada."
          : null;

  return (
    <section aria-labelledby="onde-assistir" className="px-4 pb-16 pt-4 md:px-14">
      <h2 id="onde-assistir" className="text-lg font-bold text-white md:text-xl">
        Onde assistir {titulo} online
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-300 md:text-[15px]">{copy}</p>
      {disponibilidade ? (
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-300 md:text-[15px]">
          {disponibilidade}
        </p>
      ) : null}
      {extra ? (
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400 md:text-[15px]">{extra}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {PLATAFORMAS.map(({ nome, instalador }) =>
          instalador.url.length > 0 ? (
            <a
              key={nome}
              href={instalador.url}
              rel="noopener nofollow"
              className="rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-zinc-950 transition-colors hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
            >
              Baixar para {nome}
            </a>
          ) : null,
        )}
      </div>

      {generos.length > 0 ? (
        <nav aria-label="Gêneros" className="mt-6">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">Gêneros</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {generos.map((g) => (
              <Link
                key={g.id}
                href={genrePath(g.id, g.nome)}
                className="rounded-full border border-white/10 bg-white/[0.07] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-white/30 hover:bg-white/15 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
              >
                {g.nome}
              </Link>
            ))}
          </div>
        </nav>
      ) : null}
    </section>
  );
}
