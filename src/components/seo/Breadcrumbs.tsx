import Link from "next/link";
import { ChevronRight } from "lucide-react";

export type BreadcrumbItem = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Navegação estrutural" className="mb-5">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-zinc-400">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-center gap-1">
            {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
            {item.href ? (
              <Link href={item.href} className="rounded px-1 py-1 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="px-1 py-1 text-zinc-200">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
