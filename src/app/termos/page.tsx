import type { Metadata } from "next";
import { PaginaLegal } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Termos de Uso | Obaflix", robots: { index: false, follow: false } };

const H2 = { fontSize: 20, fontWeight: 700 } as const;
const LINK = { textDecoration: "underline" } as const;

/**
 * Termos de Uso do Obaflix — Filmes e Séries. Descreve só o funcionamento já existente (conta, anúncios, uso permitido,
 * contato). Direitos sobre conteúdos, limitação de responsabilidade, foro e idade mínima dependem do responsável e não
 * foram inventados aqui. O Obaflix Cortes tem termos próprios.
 */
export default function Pagina() {
  return (
    <PaginaLegal titulo="Termos de Uso" produto="Obaflix — Filmes e Séries" voltar={null}>
      <p>Estes termos valem para o uso do Obaflix — Filmes e Séries (aplicativo para Android e site). O aplicativo Obaflix Cortes, para Windows, tem termos próprios: <a href="/cortes/termos" style={LINK}>Termos de Uso do Obaflix Cortes</a>.</p>

      <h2 style={H2}>O serviço</h2>
      <p>O Obaflix permite pesquisar títulos e assistir a filmes e séries a partir de servidores e provedores externos. A disponibilidade de cada título e de cada servidor depende desses provedores e pode mudar ou ser interrompida a qualquer momento. O Obaflix não concede licença sobre filmes, séries ou outros materiais de terceiros.</p>

      <h2 style={H2}>Conta</h2>
      <p>É preciso ter uma conta, criada com e-mail e senha ou com o Google. Você é responsável por manter a senha em segurança e pelo uso da sua conta. Você pode excluí-la a qualquer momento em <a href="/excluir-conta" style={LINK}>Excluir conta</a>. O tratamento dos seus dados está descrito na <a href="/privacidade" style={LINK}>Política de Privacidade</a>.</p>

      <h2 style={H2}>Anúncios</h2>
      <p>Contas do plano gratuito veem anúncios. Para liberar a reprodução, o download ou a transmissão de um título, o aplicativo pode pedir que você assista a um anúncio. O servidor confere o anúncio antes de liberar o acesso: fechar ou abandonar o anúncio não libera o conteúdo.</p>

      <h2 style={H2}>Planos</h2>
      <p>A versão do aplicativo distribuída pela Google Play não oferece compra de planos.</p>

      <h2 style={H2}>Uso permitido</h2>
      <p>Use o Obaflix somente para assistir a conteúdos para os quais você tenha autorização. Não é permitido contornar proteções de acesso ou os anúncios, automatizar o uso do serviço, distribuir conteúdos sem autorização nem usar o Obaflix para atividades ilícitas.</p>

      <h2 style={H2}>Suporte</h2>
      <p>Para dúvidas, contestações ou solicitações, escreva para <a href="mailto:obaflixsuporte@gmail.com" style={LINK}>obaflixsuporte@gmail.com</a>. Os direitos assegurados pela legislação de defesa do consumidor permanecem aplicáveis.</p>

      <h2 style={H2}>Alterações</h2>
      <p>Podemos atualizar estes termos. A versão em vigor é sempre a publicada nesta página.</p>
    </PaginaLegal>
  );
}
