import { LegalDocument } from "@/components/landing/LegalDocument";
import { publicDownloadMetadata } from "@/lib/seo";

export const dynamic = "force-static";
export const metadata = publicDownloadMetadata("Termos de Uso do Obaflix", "/termos");

export default function TermsPage() {
  return <LegalDocument title="Termos de Uso do Obaflix">
    <p>Estes termos descrevem o uso do software Obaflix e dos recursos oferecidos em seus aplicativos. Ao utilizar o serviço, observe estas condições e as informações apresentadas em cada funcionalidade. A <a href="/privacidade">Política de Privacidade</a> explica o tratamento de dados pessoais.</p>
    <h2>1. Serviço e aplicativos</h2>
    <p>O Obaflix oferece aplicativos para Android, Android TV / TV Box e Windows, com interface de navegação, reprodução e recursos de conta. O site público apresenta informações e instaladores. A disponibilidade de conteúdos e funcionalidades varia conforme dispositivo, versão, conexão, plano e fontes disponíveis.</p>
    <h2>2. Conta e credenciais</h2>
    <p>O acesso a recursos da conta pode exigir cadastro e login por e-mail e senha ou Google, quando disponível. Informe dados corretos, mantenha o e-mail acessível e proteja suas credenciais. Não compartilhe sua senha. Se identificar acesso indevido, altere a senha e entre em contato para receber suporte.</p>
    <h2>3. Licença de uso e conduta</h2>
    <p>Você recebe uma licença pessoal, limitada e não exclusiva de uso do software, conforme estes termos. A licença não transfere a propriedade do aplicativo. Não pratique fraude, exploração de vulnerabilidades, acesso não autorizado, abuso de recursos ou interferência na operação. Não faça engenharia reversa, modificação ou redistribuição não autorizada do software, ressalvadas as hipóteses permitidas pela legislação.</p>
    <h2>4. Recursos e disponibilidade</h2>
    <p>Histórico, progresso, continuar assistindo, favoritos e preferências podem estar vinculados à conta. Download offline, quando disponível, depende da versão, do dispositivo, do espaço local e do recurso apresentado no aplicativo. Nem todos os conteúdos ou dispositivos oferecem as mesmas funções.</p>
    <p>Podem ocorrer interrupções temporárias por manutenção, falhas técnicas, conectividade ou indisponibilidade de serviços utilizados na operação. Buscamos corrigir problemas identificados e comunicar mudanças relevantes. Estas condições não afastam responsabilidades nem garantias previstas em lei.</p>
    <h2>5. Versões e atualizações</h2>
    <p>Os instaladores são disponibilizados na infraestrutura de downloads do Obaflix. O download começa por uma ação sua. Atualizações podem corrigir falhas, alterar funções ou ser necessárias para manter a compatibilidade. Confira o dispositivo e as instruções antes de instalar.</p>
    <h2>6. Planos, anúncios e pagamento</h2>
    <p>Planos gratuitos e pagos podem ser oferecidos conforme disponibilidade. A experiência gratuita pode conter publicidade, incluindo Unity Ads no aplicativo Android e anúncios no aplicativo Windows. Os recursos e limites aplicáveis são apresentados na oferta.</p>
    <p>Quando houver contratação de plano pago por PIX, confira o preço, a duração, as condições e os dados apresentados no checkout antes de confirmar. O pagamento é processado por um provedor de pagamento. A liberação do plano depende da confirmação e das condições informadas na contratação.</p>
    <h2>7. Cancelamentos e reembolsos</h2>
    <p>Solicite orientação pelo canal de contato abaixo. Cancelamentos, reembolsos e o direito de arrependimento, quando aplicável à contratação, serão tratados conforme a legislação brasileira e as condições válidas apresentadas no checkout. Nenhuma disposição destes termos limita direitos assegurados pelo Código de Defesa do Consumidor.</p>
    <h2>8. Segurança e suspensão</h2>
    <p>Ações de prevenção podem restringir ou suspender acessos relacionados a abuso, fraude ou risco à segurança. As medidas devem ser proporcionais às circunstâncias. Entre em contato se considerar que uma restrição foi aplicada incorretamente.</p>
    <h2>9. Propriedade intelectual</h2>
    <p>A marca, a interface e o software próprios do Obaflix estão sujeitos aos direitos de seus titulares. Marcas, obras e conteúdos de terceiros continuam pertencendo aos respectivos titulares. Referências a terceiros não implicam parceria, patrocínio ou endosso. O uso do aplicativo não concede propriedade sobre obras ou conteúdos nem autorização para explorá-los fora dos direitos legalmente permitidos.</p>
    <h2>10. Alterações e legislação</h2>
    <p>Estes termos podem ser atualizados para refletir mudanças no produto ou na legislação. A data de atualização aparece no início da página. Aplicam-se as leis brasileiras, preservando os direitos do consumidor e os meios legais de solução de conflitos.</p>
    <p>Referência legal: <a href="https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm">Código de Defesa do Consumidor</a>.</p>
  </LegalDocument>;
}
