import type { Metadata } from "next";
import { PaginaLegal } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Termos de Uso | Obaflix Cortes", robots: { index: false, follow: false } };

export default function Pagina() {
  return (
    <PaginaLegal titulo="Termos de Uso">
      <p>O Obaflix Cortes oferece funcionalidades de seleção e preparação de trechos no aplicativo para Windows. Ao contratar, o usuário concorda com as condições apresentadas nesta página e no checkout.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Planos e acesso</h2>
      <p>Start oferece seleção e exportação individual de trechos. Pro acrescenta organização e exportação de múltiplos trechos. AI acrescenta sugestões de cenas e horários a partir do tema ou roteiro, sujeitas a limites de uso. Cada plano anunciado dá acesso por 30 dias, mediante pagamento único por Pix, sem renovação automática.</p>
      <p>Os preços e eventuais taxas são exibidos antes da geração do Pix. A liberação do acesso ocorre após a confirmação do pagamento pelo servidor, por meio do e-mail informado ou da conta existente. O uso requer computador Windows compatível.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Uso permitido</h2>
      <p>O usuário é responsável por utilizar somente conteúdos para os quais tenha autorização. O serviço não concede licença sobre filmes, séries ou outros materiais de terceiros. Não é permitido contornar proteções de acesso, distribuir conteúdos sem autorização ou utilizar o aplicativo para atividades ilícitas.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Limites técnicos e suporte</h2>
      <p>A disponibilidade da seleção, prévia e exportação depende da fonte, do formato e dos componentes instalados. Determinados formatos podem exigir FFmpeg. A inteligência artificial oferece sugestões para revisão humana, e não garante que todos os títulos tenham resultados.</p>
      <p>Para suporte, contestações ou solicitações sobre a compra, escreva para <a href="mailto:obaflixsuporte@gmail.com" style={{ textDecoration: "underline" }}>obaflixsuporte@gmail.com</a>. Os direitos assegurados pela legislação de defesa do consumidor permanecem aplicáveis.</p>
    </PaginaLegal>
  );
}
