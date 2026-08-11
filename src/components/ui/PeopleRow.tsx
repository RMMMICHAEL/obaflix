import Image from "next/image";
import Link from "next/link";
import { User } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

export interface PeopleRowItem {
  id: number;
  name: string;
  profile_path?: string | null;
  role?: string | null;
}

export function PeopleRow({ title, people }: { title: string; people: PeopleRowItem[] }) {
  if (!people.length) return null;

  return (
    <section className="mt-10" aria-labelledby={`people-${title.replace(/\s+/g, "-").toLowerCase()}`}>
      <h2 id={`people-${title.replace(/\s+/g, "-").toLowerCase()}`} className="mb-4 text-lg font-semibold text-white">
        {title}
      </h2>
      <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-hide">
        {people.map((person) => (
          <Link
            key={person.id}
            href={`/pessoa/${person.id}`}
            aria-label={`Ver títulos com ${person.name}`}
            className="group flex w-24 flex-none flex-col text-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-500"
          >
            <div className="mx-auto mb-2 h-24 w-24 overflow-hidden rounded-full bg-zinc-800 ring-2 ring-zinc-700 transition duration-200 ease-out group-hover:ring-zinc-400 group-focus-visible:ring-zinc-300">
              {person.profile_path ? (
                <Image
                  src={imgUrl(person.profile_path, "w185")}
                  alt={person.name}
                  width={96}
                  height={96}
                  className="h-full w-full object-cover transition duration-200 ease-out group-hover:scale-105"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-zinc-600">
                  <User size={32} aria-hidden="true" />
                </div>
              )}
            </div>
            <span className="line-clamp-2 text-xs font-semibold leading-tight text-white group-hover:text-zinc-200">
              {person.name}
            </span>
            {person.role && <span className="mt-1 line-clamp-2 text-[10px] leading-tight text-zinc-500">{person.role}</span>}
          </Link>
        ))}
      </div>
    </section>
  );
}
