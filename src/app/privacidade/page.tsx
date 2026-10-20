import { LegalDocument } from "@/components/landing/LegalDocument";
import { publicDownloadMetadata } from "@/lib/seo";

export const dynamic = "force-static";
export const metadata = publicDownloadMetadata("Política de Privacidade do Obaflix", "/privacidade");

export default function PrivacyPage() {
  return <LegalDocument title="Política de Privacidade do Obaflix">
    <p>Esta política descreve o tratamento de dados nos sites e aplicativos Obaflix para Android, Android TV e Windows. O tratamento depende dos recursos que você utiliza. O responsável e o canal de contato estão ao final desta página.</p>
    <h2>1. Dados de cadastro e acesso</h2>
    <p>No cadastro, tratamos e-mail, nome quando informado e senha. A senha é armazenada como hash, não em texto puro. No login com Google, quando disponível, recebemos e-mail, nome e imagem de perfil disponíveis para autenticar e vincular a conta.</p>
    <p>Identificadores de sessão e cookies de autenticação mantêm o acesso. Endereços IP são utilizados em controles de segurança e limite de requisições. Registros técnicos auxiliam a prevenção de abuso, a investigação de falhas e o diagnóstico.</p>
    <h2>2. Uso da conta e dados no dispositivo</h2>
    <p>Histórico, progresso de reprodução, favoritos/lista e preferências relacionadas à conta permitem continuar assistindo e organizar sua experiência. Recursos como downloads offline, quando disponíveis, também utilizam armazenamento local no dispositivo. Aplicativos podem manter dados técnicos e preferências locais necessários ao funcionamento.</p>
    <h2>3. Pagamentos</h2>
    <p>Na contratação por PIX, podem ser solicitados nome, e-mail da conta, telefone e CPF ou CNPJ. Telefone e documento são encaminhados ao provedor de pagamento quando necessários para criar a cobrança. O fluxo de cobrança não prevê armazenar esses dois campos no banco da conta Obaflix.</p>
    <p>Registros de pedido, valor, situação do pagamento, identificadores da transação e vínculo com a conta são usados para confirmar a contratação, liberar o plano, prestar suporte e cumprir obrigações aplicáveis. O provedor de pagamento tem suas próprias obrigações de tratamento e retenção.</p>
    <h2>4. Finalidades e bases legais</h2>
    <p>Tratamos dados para criar e autenticar contas, oferecer os recursos solicitados, processar contratações, prestar suporte, proteger o serviço e cumprir obrigações legais. Conforme a atividade, as bases legais podem incluir execução de contrato ou procedimentos solicitados por você, obrigação legal, exercício regular de direitos e legítimo interesse para segurança, com avaliação de necessidade e dos seus direitos.</p>
    <p>Quando uma atividade depender de consentimento, ele deve ser específico e pode ser revogado. Não tratamos o simples acesso a esta política como consentimento geral para qualquer finalidade.</p>
    <h2>5. Infraestrutura e compartilhamento</h2>
    <p>Utilizamos serviços técnicos conforme necessários à operação: Vercel para hospedagem, Supabase/PostgreSQL para dados da aplicação, Google OAuth para login quando escolhido, Cloudflare R2 para arquivos e instaladores e provedor de pagamento PIX para cobranças.</p>
    <p>Há publicidade por Unity Ads no Android e por serviços de anúncios no Windows, incluindo Monetag. Conforme o aplicativo e a exibição de anúncios, esses serviços podem tratar informações do dispositivo, identificadores publicitários, IP e dados de interação para entrega, medição e prevenção de fraude. As práticas também estão descritas nas políticas dos respectivos fornecedores: <a href="https://unity.com/legal/game-player-and-app-user-privacy-policy">Unity</a> e <a href="https://monetag.com/privacy/">Monetag</a>.</p>
    <p>O compartilhamento deve se limitar ao necessário para essas finalidades. Dados também podem ser fornecidos para cumprimento de obrigação legal ou atendimento a ordem válida de autoridade competente.</p>
    <h2>6. Cookies e esta página de download</h2>
    <p>Áreas autenticadas utilizam cookies necessários ao login e à segurança. Os aplicativos também podem utilizar armazenamento local para preferências e funcionamento. Esta landing de download não adiciona pixels de terceiros — não há TikTok Pixel, Meta Pixel ou Google Analytics/Ads nesta fase — nem cookie de marketing ou identificador persistente de visitante.</p>
    <p>Para avaliar o próprio desempenho da landing, mantemos uma medição first-party: registramos contagens agregadas de eventos da página (visualizações da página de download e cliques nos botões “Abrir no navegador” e “Baixar para Android”). Essas contagens podem considerar os parâmetros de campanha <code>utm_source</code>, <code>utm_medium</code>, <code>utm_campaign</code> e <code>utm_content</code> presentes no link de acesso. São contagens agregadas, sem identificador de conta ou de visitante: não vinculamos a métrica à sua conta Obaflix e não armazenamos IP nem User-Agent na base dessas contagens. Um clique em baixar indica apenas o toque no botão — não confirma que o download foi concluído nem que o aplicativo foi instalado. A hospedagem ainda pode tratar registros técnicos da requisição conforme já descrito nesta Política. A introdução de novas tecnologias de marketing deverá ser acompanhada de informação e mecanismos de consentimento quando exigidos.</p>
    <p>Você pode gerenciar cookies e armazenamento nas configurações do navegador ou dispositivo. A restrição de cookies necessários pode impedir o login ou outros recursos da conta. A hospedagem pode processar dados técnicos da requisição mesmo quando você apenas visita uma página pública.</p>
    <h2>7. Transferências internacionais</h2>
    <p>Os fornecedores de infraestrutura, autenticação, pagamento e publicidade podem processar dados fora do Brasil. Quando houver transferência internacional, devem ser observados os mecanismos e as garantias exigidos pela LGPD e pela regulamentação aplicável.</p>
    <h2>8. Segurança e retenção</h2>
    <p>O código utiliza hash de senha, controles de sessão, verificação de acesso e limites de requisições. Essas medidas reduzem riscos, mas não eliminam toda possibilidade de incidente. Proteja suas credenciais e comunique suspeitas pelo canal abaixo.</p>
    <p>Os dados devem ser mantidos pelo período necessário à finalidade, à segurança, ao suporte e às obrigações legais ou ao exercício de direitos. Não há um único prazo para todas as categorias. Pedidos de exclusão podem ser encaminhados pelo contato abaixo; registros cuja conservação seja legalmente necessária podem permanecer durante o período aplicável. Dados de terceiros seguem também as obrigações desses fornecedores.</p>
    <h2>9. Seus direitos</h2>
    <p>Você pode solicitar confirmação e acesso, correção, informações sobre compartilhamento, portabilidade nos termos aplicáveis, anonimização, bloqueio ou eliminação de dados desnecessários ou tratados irregularmente. Também pode solicitar eliminação quando cabível, opor-se ao tratamento nas hipóteses legais, revogar consentimento e receber informação sobre as consequências de não consentir.</p>
    <p>Use o canal abaixo para exercer esses direitos ou pedir esclarecimentos. Algumas solicitações dependem da confirmação de identidade e das exceções legais de retenção. Você também pode apresentar reclamação à Autoridade Nacional de Proteção de Dados e aos órgãos competentes.</p>
    <h2>10. Atualizações</h2>
    <p>Esta política pode mudar conforme os recursos e o tratamento de dados evoluam. A versão vigente e sua data estarão nesta página. Mudanças relevantes devem ser informadas de forma adequada.</p>
    <p>Referência legal: <a href="https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm">Lei Geral de Proteção de Dados Pessoais</a>.</p>
  </LegalDocument>;
}
