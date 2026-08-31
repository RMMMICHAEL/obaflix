import Link from "next/link";
import { Download, MonitorSmartphone, ShieldCheck, Tv, Zap } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { ANIME_HOME_EXCLUSIONS } from "@/lib/editorialCatalog";
import { INSTALADORES } from "@/config/downloads";
import { LandingHeader } from "./LandingHeader";
import { LandingHero } from "./LandingHero";
import { SecaoDownloads } from "./SecaoDownloads";
import { VitrineBackdrops, VitrinePosters, type ItemVitrine } from "./Vitrine";

/**
 * Landing pública do Obaflix.
 *
 * Custo por render: cinco `findMany` de 12 linhas com projeção mínima, e a
 * página inteira é estática por uma hora (`revalidate` na rota). Na prática o
 * Supabase vê ~120 linhas por hora, não por visita. As vitrines mostram o
 * catálogo mas não dão acesso a ele — não existe link em nenhum card.
 */

const CAMPOS = {
  titulo: true,
  poster: true,
  background: true,
  ano: true,
  nota: true,
} as const;

const POR_VITRINE = 12;

type Linha = {
  titulo: string;
  poster: string | null;
  background: string | null;
  ano: number | null;
  nota: number | null;
};

const paraItem = (r: Linha): ItemVitrine => ({
  titulo: r.titulo,
  poster: r.poster,
  background: r.background,
  ano: r.ano,
  nota: r.nota,
});

async function carregarCatalogo() {
  const porPopularidade = { popularidade: { sort: "desc", nulls: "last" } } as const;

  const [filmesAlta, filmesTop, seriesAlta, seriesTop, animesAlta] = await Promise.all([
    prisma.filme.findMany({
      where: { poster: { not: null } },
      orderBy: porPopularidade,
      take: POR_VITRINE,
      select: CAMPOS,
    }),
    // "Top" = bem avaliado entre os populares. Ordenar só por nota traria
    // títulos obscuros com nota alta e três votos.
    prisma.filme.findMany({
      where: { poster: { not: null }, nota: { gte: 7 } },
      orderBy: porPopularidade,
      skip: POR_VITRINE,
      take: POR_VITRINE,
      select: CAMPOS,
    }),
    prisma.serie.findMany({
      where: { tipo: "serie", poster: { not: null } },
      orderBy: porPopularidade,
      take: POR_VITRINE,
      select: CAMPOS,
    }),
    prisma.serie.findMany({
      where: { tipo: "serie", poster: { not: null }, nota: { gte: 7.5 } },
      orderBy: porPopularidade,
      skip: POR_VITRINE,
      take: POR_VITRINE,
      select: CAMPOS,
    }),
    prisma.serie.findMany({
      where: {
        tipo: "anime",
        poster: { not: null },
        titulo: { notIn: [...ANIME_HOME_EXCLUSIONS] },
      },
      orderBy: porPopularidade,
      take: POR_VITRINE,
      select: CAMPOS,
    }),
  ]);

  return {
    filmesAlta: filmesAlta.map(paraItem),
    filmesTop: filmesTop.map(paraItem),
    seriesAlta: seriesAlta.map(paraItem),
    seriesTop: seriesTop.map(paraItem),
    animesAlta: animesAlta.map(paraItem),
  };
}

const VANTAGENS = [
  {
    icone: <Zap size={20} />,
    titulo: "Abre rápido",
    texto: "O app carrega direto no catálogo, sem propaganda no caminho.",
  },
  {
    icone: <MonitorSmartphone size={20} />,
    titulo: "Todos os aparelhos",
    texto: "Android, Android TV, TV Box e Windows com a mesma conta.",
  },
  {
    icone: <Tv size={20} />,
    titulo: "Feito para a TV",
    texto: "Navegação por controle remoto, com foco visível em cada item.",
  },
  {
    icone: <ShieldCheck size={20} />,
    titulo: "Seu progresso salvo",
    texto: "Favoritos e continue assistindo acompanham você em qualquer tela.",
  },
];

export async function LandingPage() {
  const catalogo = await carregarCatalogo();

  // O "Em alta" mistura filmes e séries reaproveitando o que já foi consultado —
  // nenhuma query a mais só para montar esta faixa.
  const emAlta: ItemVitrine[] = [];
  for (let i = 0; i < 6; i++) {
    if (catalogo.filmesAlta[i]) emAlta.push(catalogo.filmesAlta[i]);
    if (catalogo.seriesAlta[i]) emAlta.push(catalogo.seriesAlta[i]);
  }

  const fundosHero = emAlta.slice(0, 6).map((item) => item.background ?? item.poster);

  return (
    <div data-obaflix-landing className="min-h-screen bg-zinc-950 text-white">
      <LandingHeader />
      <LandingHero fundos={fundosHero} />

      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-red-950/20 to-transparent"
        />
        <div className="mx-auto max-w-[1800px] pt-4">
          <VitrineBackdrops
            titulo="Em alta agora"
            sub="O que mais estão assistindo esta semana"
            itens={emAlta.slice(0, 10)}
          />
          <VitrinePosters titulo="Filmes em alta" itens={catalogo.filmesAlta} />
          <VitrinePosters
            titulo="Top filmes"
            sub="Os mais bem avaliados"
            itens={catalogo.filmesTop}
          />
        </div>
      </div>

      {/* Reforço de download no meio das vitrines */}
      <section className="obaflix-reveal my-8 px-4 sm:my-12 sm:px-6 lg:px-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-r from-red-950/50 via-zinc-900/60 to-zinc-900/40 p-6 text-center sm:flex-row sm:p-8 sm:text-left">
          <div className="flex-1">
            <h2 className="text-xl font-black text-white sm:text-2xl">
              Tudo isso já está no aplicativo
            </h2>
            <p className="mt-1.5 text-sm text-white/55">
              Milhares de títulos e novos episódios toda semana. Baixe e comece a assistir.
            </p>
          </div>
          <a
            href="#baixar"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-bold text-zinc-950 transition hover:bg-white/90 active:scale-95"
          >
            <Download size={17} />
            Baixar agora
          </a>
        </div>
      </section>

      <div className="mx-auto max-w-[1800px]">
        <VitrinePosters titulo="Séries em alta" itens={catalogo.seriesAlta} />
        <VitrinePosters titulo="Top séries" sub="As mais bem avaliadas" itens={catalogo.seriesTop} />
        <VitrineBackdrops titulo="Animes em alta" itens={catalogo.animesAlta.slice(0, 10)} />
      </div>

      <SecaoDownloads
        android={INSTALADORES.android}
        androidTv={INSTALADORES.androidTv}
        windows={INSTALADORES.windows}
      />

      <section className="border-t border-white/[0.06] bg-black/40 px-4 py-14 sm:px-6 sm:py-20 lg:px-10">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-black tracking-tight text-white sm:text-3xl">
              O Obaflix agora vive nos aplicativos
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-white/55 sm:text-base">
              O site está em manutenção e a experiência completa passou para os apps: mais rápidos,
              feitos para cada tela e com o catálogo inteiro. Baixe no seu aparelho, entre com a sua
              conta e continue de onde parou. Para liberar a televisão, use{" "}
              <Link
                href="/parear"
                className="font-semibold text-red-400 underline-offset-4 hover:underline"
              >
                Parear TV
              </Link>
              .
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {VANTAGENS.map((v) => (
              <div
                key={v.titulo}
                className="obaflix-reveal rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition hover:border-white/20 hover:bg-white/[0.06]"
              >
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-red-600/15 text-red-400">
                  {v.icone}
                </span>
                <h3 className="mt-3 text-base font-bold text-white">{v.titulo}</h3>
                <p className="mt-1 text-sm leading-relaxed text-white/50">{v.texto}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden px-4 py-16 text-center sm:px-6 sm:py-24 lg:px-10">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_100%_at_50%_100%,rgba(229,9,20,0.28),transparent_70%)]"
        />
        <div className="relative">
        <h2 className="mx-auto max-w-3xl text-3xl font-black leading-tight tracking-tight text-white sm:text-5xl">
          Comece a assistir hoje
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-sm text-white/55 sm:text-base">
          Instale o Obaflix no celular, na TV ou no computador. Leva menos de um minuto.
        </p>
        <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row">
          <a
            href="#baixar"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-8 py-4 text-base font-bold text-white shadow-xl shadow-red-950/50 transition hover:bg-red-500 active:scale-[0.98]"
          >
            <Download size={19} />
            Baixar agora
          </a>
          <Link
            href="/parear"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 px-8 py-4 text-base font-bold text-white transition hover:border-white/40 hover:bg-white/5 active:scale-[0.98]"
          >
            <Tv size={19} />
            Parear TV
          </Link>
        </div>
        </div>
      </section>

      <footer className="border-t border-white/[0.06] px-4 py-8 sm:px-6 lg:px-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 text-center sm:flex-row sm:text-left">
          <span className="text-lg font-black tracking-[-0.055em] text-red-600">
            OBA<span className="text-white">FLIX</span>
          </span>
          <p className="text-xs text-white/35">
            © {new Date().getFullYear()} Obaflix. Todos os direitos reservados.
          </p>
        </div>
      </footer>
    </div>
  );
}
