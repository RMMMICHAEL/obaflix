import type { Metadata } from "next";
import { PaginaLegal } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Termos de Uso | Obaflix", robots: { index: false, follow: false } };

export default function Pagina() {
  return (
    <PaginaLegal titulo="Termos de Uso">
      <p>Esta página reúne os termos de uso do Obaflix — Filmes e Séries (aplicativo para Android e site) e do Obaflix Cortes (aplicativo para Windows). A primeira parte vale para o Obaflix — Filmes e Séries; a parte &quot;Obaflix Cortes&quot; mantém as condições já existentes desse produto.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Obaflix — Filmes e Séries: o serviço</h2>
      <p>O Obaflix — Filmes e Séries permite pesquisar títulos, organizar listas e assistir a conteúdos reunidos de servidores e provedores externos. A disponibilidade de cada título e de cada servidor depende desses provedores e pode mudar ou ser interrompida a qualquer momento. O serviço não concede licença sobre filmes, séries ou outros materiais de terceiros.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Obaflix — Filmes e Séries: conta</h2>
      <p>É preciso ter uma conta, criada com e-mail e senha ou com o Google. Você é responsável por manter a senha em segurança e pelo uso da sua conta, e pode excluí-la a qualquer momento em <a href="/excluir-conta" style={{ textDecoration: "underline" }}>Excluir conta</a>. O tratamento dos seus dados está descrito na <a href="/privacidade" style={{ textDecoration: "underline" }}>Política de Privacidade</a>.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Obaflix — Filmes e Séries: anúncios e planos</h2>
      <p>Contas do plano gratuito veem anúncios. Para liberar a reprodução ou a transmissão de um título, o aplicativo pode pedir que você assista a um anúncio. O servidor confere o anúncio antes de liberar o acesso: fechar ou abandonar o anúncio não libera o conteúdo. A versão do aplicativo distribuída pela Google Play não oferece compra de planos.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Obaflix — Filmes e Séries: uso permitido e suporte</h2>
      <p>O usuário é responsável por assistir somente a conteúdos para os quais tenha autorização. Não é permitido contornar proteções de acesso ou os anúncios, automatizar o uso do serviço, distribuir conteúdos sem autorização nem usar o aplicativo para atividades ilícitas. Para dúvidas, contestações ou solicitações, escreva para <a href="mailto:obaflixsuporte@gmail.com" style={{ textDecoration: "underline" }}>obaflixsuporte@gmail.com</a>. Os direitos assegurados pela legislação de defesa do consumidor permanecem aplicáveis.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Obaflix Cortes</h2>
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
