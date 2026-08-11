import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, Clapperboard, MapPin, User } from "lucide-react";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { JsonLd } from "@/components/seo/JsonLd";
import { ContentCard } from "@/components/ui/ContentCard";
import { getPersonCatalog, type PersonCatalogItem } from "@/lib/person-catalog";
import { getPerson, imgUrl } from "@/lib/tmdb";
import { absoluteUrl, mediaMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

const DEPARTMENT_LABELS: Record<string, string> = {
  Acting: "Atuação",
  Directing: "Direção",
  Production: "Produção",
  Writing: "Roteiro",
  Camera: "Fotografia",
  Editing: "Montagem",
  Sound: "Som",
};

function formatDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function CatalogSection({ title, items }: { title: string; items: PersonCatalogItem[] }) {
  if (!items.length) return null;

  return (
    <section className="mt-12" aria-labelledby={`catalog-${title.toLowerCase()}`}>
      <div className="mb-5 flex items-baseline gap-3 border-b border-zinc-800 pb-3">
        <h2 id={`catalog-${title.toLowerCase()}`} className="text-xl font-bold text-white md:text-2xl">{title}</h2>
        <span className="text-sm text-zinc-500">{items.length}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
        {items.map((item) => (
          <div key={`${item.tipo}-${item.id}`} className="min-w-0">
            <ContentCard
              id={item.id}
              tipo={item.tipo}
              titulo={item.titulo}
              poster={item.poster}
              ano={item.ano}
              nota={item.nota}
              urlDub={item.audioDub ? "disponível" : null}
              urlLeg={item.audioLeg ? "disponível" : null}
            />
            <h3 className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-zinc-100">{item.titulo}</h3>
            {item.papeis.length > 0 && (
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-500">{item.papeis.join(" · ")}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export async function generateMetadata({ params }: { params: { id: string } }) {
  const personId = Number(params.id);
  if (!Number.isInteger(personId) || personId <= 0) return { title: "Pessoa não encontrada" };
  const person = await getPerson(personId);
  if (!person) return { title: "Pessoa não encontrada", robots: { index: false, follow: false } };

  return mediaMetadata({
    title: person.name,
    description: person.biography,
    path: `/pessoa/${person.id}`,
    image: person.profile_path ? imgUrl(person.profile_path, "w500") : null,
  });
}

export default async function PessoaPage({ params }: { params: { id: string } }) {
  const personId = Number(params.id);
  if (!Number.isInteger(personId) || personId <= 0) notFound();

  const catalog = await getPersonCatalog(personId);
  if (!catalog) notFound();

  const { pessoa, filmes, series, total } = catalog;
  const birthDate = formatDate(pessoa.nascimento);
  const deathDate = formatDate(pessoa.falecimento);
  const area = pessoa.areaConhecida ? (DEPARTMENT_LABELS[pessoa.areaConhecida] ?? pessoa.areaConhecida) : null;
  const personSchema = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: pessoa.nome,
    image: pessoa.foto ? imgUrl(pessoa.foto, "w500") : undefined,
    description: pessoa.biografia || undefined,
    birthDate: pessoa.nascimento || undefined,
    deathDate: pessoa.falecimento || undefined,
    birthPlace: pessoa.localNascimento || undefined,
    url: absoluteUrl(`/pessoa/${pessoa.id}`),
  };

  return (
    <main className="min-h-screen px-4 pb-20 pt-24 md:px-16 md:pt-28">
      <JsonLd data={personSchema} />
      <Breadcrumbs items={[{ label: "Início", href: "/" }, { label: pessoa.nome }]} />

      <section className="grid items-start gap-7 border-b border-zinc-800 pb-10 md:grid-cols-[220px_minmax(0,1fr)] md:gap-10">
        <div className="w-40 overflow-hidden rounded-xl bg-zinc-900 shadow-2xl ring-1 ring-white/10 md:w-[220px]">
          {pessoa.foto ? (
            <Image
              src={imgUrl(pessoa.foto, "w342")}
              alt={pessoa.nome}
              width={220}
              height={330}
              priority
              className="aspect-[2/3] w-full object-cover"
            />
          ) : (
            <div className="flex aspect-[2/3] items-center justify-center text-zinc-600">
              <User size={56} aria-hidden="true" />
            </div>
          )}
        </div>

        <div className="max-w-3xl md:pt-4">
          {area && <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-red-400">{area}</p>}
          <h1 className="text-3xl font-black leading-tight text-white md:text-5xl">{pessoa.nome}</h1>

          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-400">
            {birthDate && (
              <span className="flex items-center gap-2"><CalendarDays size={15} aria-hidden="true" />{birthDate}{deathDate ? ` a ${deathDate}` : ""}</span>
            )}
            {pessoa.localNascimento && (
              <span className="flex items-center gap-2"><MapPin size={15} aria-hidden="true" />{pessoa.localNascimento}</span>
            )}
            <span className="flex items-center gap-2"><Clapperboard size={15} aria-hidden="true" />{total} {total === 1 ? "título disponível" : "títulos disponíveis"}</span>
          </div>

          {pessoa.biografia && <p className="mt-6 max-w-[72ch] text-sm leading-relaxed text-zinc-300 md:text-base">{pessoa.biografia}</p>}
        </div>
      </section>

      {total > 0 ? (
        <>
          <CatalogSection title="Filmes" items={filmes} />
          <CatalogSection title="Séries" items={series} />
        </>
      ) : (
        <section className="py-20 text-center">
          <Clapperboard className="mx-auto text-zinc-700" size={42} aria-hidden="true" />
          <h2 className="mt-4 text-xl font-semibold text-white">Nenhum título disponível no momento</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-zinc-500">
            A filmografia foi encontrada, mas ainda não há filmes ou séries dessa pessoa no catálogo Obaflix.
          </p>
          <Link href="/" className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-zinc-100 px-5 text-sm font-bold text-zinc-950 transition hover:bg-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
            Explorar o catálogo
          </Link>
        </section>
      )}
    </main>
  );
}
