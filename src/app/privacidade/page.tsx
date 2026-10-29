import type { Metadata } from "next";
import { PaginaLegal, emailSuporte } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Política de Privacidade | Obaflix Cortes", robots: { index: false, follow: false } };

export default function Pagina() {
  const email = emailSuporte();
  return (
    <PaginaLegal titulo="Política de Privacidade" pendencias={["controlador e CNPJ","prazos de retenção","lista oficial de operadores","encarregado (DPO), se aplicável"]}>
      <p>Coletamos os dados informados na compra (nome, e-mail, telefone e documento) para processar o pagamento por Pix, criar o acesso e enviar o e-mail de entrega. O pagamento é processado pelo provedor de pagamento e o e-mail é enviado por serviço de envio transacional.</p>
      <p>Com o seu consentimento, usamos o Pixel da Meta para medir anúncios. Enviamos apenas o plano, o valor e o identificador do pedido, nunca CPF, telefone ou e-mail. Você pode recusar no aviso exibido no site.</p>
      <p>{email ? <>Para exercer seus direitos (LGPD), escreva para {email}.</> : "Canal de contato do titular em definição."}</p>
    </PaginaLegal>
  );
}
