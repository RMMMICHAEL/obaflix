import type { Metadata } from "next";
import { PaginaLegal } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Política de Privacidade | Obaflix", robots: { index: false, follow: false } };

const H2 = { fontSize: 20, fontWeight: 700 } as const;
const LINK = { textDecoration: "underline" } as const;

/**
 * Política de Privacidade do Obaflix — Filmes e Séries (aplicativo Android e site). O texto descreve o que o código e o
 * backend realmente fazem; o que ainda depende de confirmação do responsável (prazos de retenção, identificação legal,
 * público infantil, diagnóstico) foi deixado de fora de propósito, não preenchido. O Obaflix Cortes tem documento próprio.
 */
export default function Pagina() {
  return (
    <PaginaLegal titulo="Política de Privacidade" produto="Obaflix — Filmes e Séries" voltar={null}>
      <p>Esta política explica como o Obaflix — Filmes e Séries (aplicativo para Android e site) trata dados pessoais. O aplicativo Obaflix Cortes, para Windows, tem política própria: <a href="/cortes/privacidade" style={LINK}>Política de Privacidade do Obaflix Cortes</a>.</p>

      <h2 style={H2}>Dados da conta</h2>
      <p>Para usar o Obaflix é preciso ter uma conta. Tratamos o seu e-mail e a sua senha, que fica guardada apenas na forma de um código irreversível (hash). Se você informar, também guardamos nome e data de nascimento. Ao entrar com o Google, recebemos do Google o seu e-mail, nome, foto e um identificador da conta Google, e os usamos para criar ou acessar a sua conta Obaflix.</p>

      <h2 style={H2}>Uso do serviço</h2>
      <p>Guardamos na sua conta o histórico de reprodução e o ponto em que você parou, a sua lista de títulos, as curtidas e os dispositivos de TV que você vinculou, para continuar de onde parou e fazer recomendações. Preferências do aplicativo, perfis, PIN e downloads ficam no seu aparelho.</p>
      <p>Para segurança e prevenção de abuso, o servidor usa o endereço IP e o tipo de navegador ou aparelho para limitar tentativas e manter registros de segurança.</p>
      <p>Os vídeos são obtidos de servidores e provedores externos. Ao reproduzir, esses servidores recebem o seu endereço IP e dados técnicos da conexão, como em qualquer acesso à internet.</p>

      <h2 style={H2}>Publicidade</h2>
      <p>Contas do plano gratuito veem anúncios. Para exibi-los usamos o Unity Ads e o LevelPlay (Unity), e, quando habilitado, o Google AdMob. Esses serviços tratam identificadores do aparelho, incluindo o identificador de publicidade, e dados técnicos para entregar anúncios, medir resultados e prevenir fraude, conforme as políticas de cada empresa. O aplicativo declara a permissão de identificador de publicidade por causa desses serviços.</p>
      <p>No Unity Ads e no LevelPlay, o Obaflix configura anúncios contextuais: não consente com personalização e recusa a venda ou o compartilhamento de dados para esse fim. No AdMob, usamos a plataforma de mensagens do usuário (UMP) do Google: quando a lei exige, ela pede o seu consentimento antes de qualquer anúncio e você pode rever a escolha no aplicativo, em Configurações &gt; Privacidade e termos &gt; Privacidade de anúncios, quando essa opção aparecer.</p>
      <p>Para confirmar que um anúncio com recompensa foi assistido, associamos o evento a um identificador aleatório da sua conta, sem o seu e-mail.</p>

      <h2 style={H2}>Prestadores de serviço</h2>
      <p>A operação do Obaflix depende de prestadores que tratam dados na medida necessária à sua função: Google (login, AdMob, UMP e Google Play), Unity (Unity Ads e LevelPlay), hospedagem do site e da API, banco de dados, armazenamento temporário de sessões e limites de uso, e envio de e-mails transacionais, como a recuperação de senha.</p>

      <h2 style={H2}>Compras</h2>
      <p>A versão do aplicativo distribuída pela Google Play não oferece compra de planos. Dados de pagamento, quando existirem em outros canais, são tratados pelo provedor de pagamento correspondente.</p>

      <h2 style={H2}>Exclusão da conta e seus direitos</h2>
      <p>Você pode excluir a sua conta a qualquer momento, sem precisar do aplicativo, em <a href="/excluir-conta" style={LINK}>Excluir conta</a>. A exclusão apaga a conta e os dados ligados a ela: histórico de reprodução, lista, curtidas, dispositivos de TV vinculados e registros de assinaturas e pedidos. Registros de segurança e de auditoria e dados mantidos por prestadores de serviço, como os de publicidade, seguem as regras próprias desses registros e prestadores.</p>
      <p>Você também pode pedir informações, correção ou exclusão dos seus dados, conforme a legislação aplicável, escrevendo para <a href="mailto:obaflixsuporte@gmail.com" style={LINK}>obaflixsuporte@gmail.com</a>.</p>

      <h2 style={H2}>Alterações</h2>
      <p>Podemos atualizar esta política. A versão em vigor é sempre a publicada nesta página.</p>
    </PaginaLegal>
  );
}
