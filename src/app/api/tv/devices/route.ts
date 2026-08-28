export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { listarDispositivos } from "@/lib/tvPairing";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/**
 * Televisões pareadas na conta.
 *
 * Serve à tela "meus dispositivos", no site e na própria TV. Devolve o que o
 * usuário precisa para reconhecer cada aparelho e decidir se algum sobra —
 * nome, quando foi pareado, quando foi usado por último e a faixa de rede.
 *
 * Não devolve fingerprint nem token: são o material de autenticação do
 * aparelho, e a lista é só de leitura.
 */
export async function GET(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) {
    return NextResponse.json({ erro: "nao_autenticado" }, { status: 401, headers: NO_STORE });
  }

  const dispositivos = await listarDispositivos(usuario.userId);

  return NextResponse.json(
    {
      dispositivos: dispositivos.map((d) => ({
        id: d.id,
        nome: d.nome,
        rede: d.ultimaRede,
        criadoEm: d.criadoEm,
        ultimoUso: d.ultimoUso,
        // Deixa a TV destacar "este aparelho" na própria lista.
        atual: d.id === usuario.deviceId,
      })),
    },
    { headers: NO_STORE },
  );
}
