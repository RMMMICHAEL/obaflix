"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { ChevronDown, User, Users } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

export interface PeopleRowItem {
  id: number;
  name: string;
  profile_path?: string | null;
  role?: string | null;
}

export function PeopleRow({ title, people }: { title: string; people: PeopleRowItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!people.length) return null;

  const sectionId = `people-${title.replace(/\s+/g, "-").toLowerCase()}`;

  return (
    <section className="mt-7 border-t border-zinc-800/80 pt-2" aria-labelledby={`${sectionId}-heading`}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={sectionId}
        className="group flex min-h-12 w-full items-center justify-between gap-4 rounded-md px-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-400">
            <Users size={16} aria-hidden="true" />
          </span>
          <span>
            <span id={`${sectionId}-heading`} className="block text-sm font-semibold text-zinc-100">{title}</span>
            <span className="block text-xs text-zinc-500">{people.length} {people.length === 1 ? "pessoa" : "pessoas"}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs font-semibold text-zinc-400 group-hover:text-white">
          {expanded ? "Ocultar" : "Ver pessoas"}
          <ChevronDown size={17} aria-hidden="true" className={`transition-transform duration-200 ease-out ${expanded ? "rotate-180" : ""}`} />
        </span>
      </button>

      {expanded && (
        <div id={sectionId} className="flex gap-3 overflow-x-auto pb-2 pt-4 scrollbar-hide">
          {people.map((person) => (
            <Link
              key={person.id}
              href={`/pessoa/${person.id}`}
              aria-label={`Ver títulos com ${person.name}`}
              className="group flex w-20 flex-none flex-col text-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-500"
            >
              <div className="mx-auto mb-2 h-16 w-16 overflow-hidden rounded-full bg-zinc-800 ring-1 ring-zinc-700 transition duration-200 ease-out group-hover:ring-zinc-400 group-focus-visible:ring-zinc-300 sm:h-[72px] sm:w-[72px]">
                {person.profile_path ? (
                  <Image
                    src={imgUrl(person.profile_path, "w185")}
                    alt={person.name}
                    width={72}
                    height={72}
                    className="h-full w-full object-cover transition duration-200 ease-out group-hover:scale-105"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-zinc-600">
                    <User size={24} aria-hidden="true" />
                  </div>
                )}
              </div>
              <span className="line-clamp-2 text-[11px] font-semibold leading-tight text-zinc-100 group-hover:text-white">
                {person.name}
              </span>
              {person.role && <span className="mt-1 line-clamp-2 text-[10px] leading-tight text-zinc-500">{person.role}</span>}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
