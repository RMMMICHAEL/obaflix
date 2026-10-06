import { notFound } from "next/navigation";
import { buscarGeneroPorParam } from "./genero-data";

/**
 * Sem isto `/genero/999999` responderia 200 com lista vazia: um soft 404 que da
 * ao crawler um espaco infinito de URLs validas e sem conteudo. A metadata e o
 * redirect canonico vivem na pagina (precisam de searchParams).
 */
export default async function Layout({
  params,
  children,
}: {
  params: { id: string };
  children: React.ReactNode;
}) {
  const genero = await buscarGeneroPorParam(params.id);
  if (!genero) notFound();
  return children;
}
