import { notFound } from "next/navigation";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { mediaMetadata } from "@/lib/seo";

// generateMetadata e o layout precisam do mesmo genero. O cache do React
// resolve as duas chamadas com uma consulta so por request.
const buscarGenero = cache(async (id: number) => {
  if (!Number.isInteger(id)) return null;
  return prisma.genero.findUnique({ where: { id }, select: { nome: true } });
});

export async function generateMetadata({ params }: { params: { id: string } }) {
  const genero = await buscarGenero(Number(params.id));
  if (!genero) return { title: "Gênero não encontrado", robots: { index: false, follow: false } };

  return mediaMetadata({
    title: `${genero.nome}: filmes e séries`,
    description: `Explore filmes, séries, animes e desenhos do gênero ${genero.nome} no catálogo Obaflix.`,
    path: `/genero/${params.id}`,
  });
}

export default async function Layout({
  params,
  children,
}: {
  params: { id: string };
  children: React.ReactNode;
}) {
  // Sem isto /genero/999999 responde 200 com lista vazia: um soft 404 que da ao
  // crawler um espaco infinito de URLs validas e sem conteudo.
  const genero = await buscarGenero(Number(params.id));
  if (!genero) notFound();

  return children;
}
