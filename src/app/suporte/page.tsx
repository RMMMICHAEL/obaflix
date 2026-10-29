import type { Metadata } from "next";
import { PaginaLegal } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Contato / Suporte | Obaflix Cortes", robots: { index: false, follow: false } };

export default function Pagina() {
  return (
    <PaginaLegal titulo="Contato / Suporte">
      <p>Precisa de ajuda com a compra, o Pix, a ativação, a instalação do aplicativo ou a assinatura? Escreva para <a href="mailto:obaflixsuporte@gmail.com" style={{ textDecoration: "underline" }}>obaflixsuporte@gmail.com</a>.</p>
      <p>Para facilitar o atendimento, informe o e-mail utilizado na compra, o plano adquirido e, quando possível, o identificador do pedido. Nunca compartilhe senhas, códigos de ativação ou dados bancários.</p>
      <p>Solicitações de cancelamento e arrependimento podem ser feitas pelo mesmo canal. Consulte também a <a href="/reembolso" style={{ textDecoration: "underline" }}>Política de Reembolso</a>.</p>
    </PaginaLegal>
  );
}
