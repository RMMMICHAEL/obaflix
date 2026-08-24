import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRecommendationsForUser } from "@/lib/recommendations";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  // Sem cache no 401: senão o navegador continuaria devolvendo "não autenticado"
  // por um minuto depois do login.
  if (!userId) {
    return NextResponse.json(
      { error: "Não autenticado" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const result = await getRecommendationsForUser(userId);

  // Cache curto no navegador do próprio usuário, em vez de cache no servidor.
  // Remontar a home ou voltar para ela dentro de um minuto passa a não gerar
  // requisição nenhuma — nem invocação na Vercel, nem query no Supabase.
  //
  // `private` é o que garante o isolamento: proíbe qualquer cache
  // compartilhado (CDN da Vercel, proxy no caminho) de guardar a resposta, que
  // fica restrita ao navegador de quem a pediu. Não existe chave a errar nem
  // entrada a vazar entre contas — coisa que um cache de resposta no servidor
  // exigiria acertar. O que é compartilhado entre usuários é só o pool de
  // catálogo, que não tem nada de pessoal.
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, max-age=60" },
  });
}
