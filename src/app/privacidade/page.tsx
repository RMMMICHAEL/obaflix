import type { Metadata } from "next";
import { PaginaLegal } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Política de Privacidade | Obaflix Cortes", robots: { index: false, follow: false } };

export default function Pagina() {
  return (
    <PaginaLegal titulo="Política de Privacidade">
      <p>O Obaflix Cortes utiliza os dados fornecidos durante a compra, como nome, e-mail, telefone, CPF e, quando solicitado, data de nascimento, para validar a contratação, processar o Pix, identificar o pedido, fornecer acesso e prestar suporte.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Prestadores e finalidades</h2>
      <p>O processamento de pagamentos utiliza a Cakto; o envio de mensagens transacionais utiliza serviço de e-mail; e a operação do produto depende de provedores de hospedagem e armazenamento. Cada prestador pode tratar dados necessários a sua função, conforme seus respectivos termos e a legislação aplicável.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Cookies e anúncios</h2>
      <p>Com o consentimento do visitante, podemos usar o Meta Pixel para medir acessos e eventos comerciais, incluindo visualização de página, início de checkout e compra confirmada. Nossos eventos de compra não enviam CPF, telefone ou e-mail. O Pixel e a Meta podem processar identificadores do navegador e dados técnicos relacionados a essas visitas. Você pode recusar ou alterar sua escolha no aviso ou nas preferências de cookies do site.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Armazenamento e direitos do titular</h2>
      <p>Os dados são tratados enquanto necessários à execução do serviço e ao atendimento das obrigações legais aplicáveis. Você pode solicitar informações, correção, acesso ou exclusão dos dados quando permitido por lei. Registros que precisem ser mantidos por obrigação legal podem não ser eliminados imediatamente.</p>
      <p>Para exercer seus direitos relacionados à privacidade, escreva para <a href="mailto:obaflixsuporte@gmail.com" style={{ textDecoration: "underline" }}>obaflixsuporte@gmail.com</a>. Para solicitar exclusão da conta, acesse também <a href="/excluir-conta" style={{ textDecoration: "underline" }}>Excluir conta</a>.</p>
    </PaginaLegal>
  );
}
