import type { Metadata } from "next";
import { GradeDeCanais } from "@/components/canais/GradeDeCanais";

/**
 * `/canais` — a tela de canais ao vivo.
 *
 * Rota **interna dos aplicativos**: o app Android a abre na WebView e o
 * Electron a abre no renderer. Não existe produto para navegador comum nesta
 * fase, e esta página não é um lançamento de site.
 *
 * `noindex` por isso mesmo. E `force-dynamic` porque o conteúdo depende da
 * sessão: a grade é montada no cliente a partir de `/api/canais`, que já filtra
 * por entitlements, e uma página estática aqui seria uma casca cacheável na
 * frente de um corpo que nunca pode ser compartilhado entre contas.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Canais ao vivo",
  robots: { index: false, follow: false },
};

export default function CanaisPage() {
  return (
    <main className="min-h-screen bg-black">
      <GradeDeCanais />
    </main>
  );
}
