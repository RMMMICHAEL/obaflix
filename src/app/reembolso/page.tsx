import type { Metadata } from "next";
import { PaginaLegal } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Política de Reembolso | Obaflix Cortes", robots: { index: false, follow: false } };

export default function Pagina() {
  return (
    <PaginaLegal titulo="Política de Reembolso e Arrependimento">
      <p>As assinaturas do Obaflix Cortes são contratadas online, com pagamento único por Pix e sem renovação automática. O preço total é informado antes da confirmação da compra.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Direito de arrependimento</h2>
      <p>Nas contratações feitas pela internet, o consumidor pode exercer o direito de arrependimento no prazo legal de 7 dias corridos, contado da contratação ou do recebimento do serviço, conforme o caso, nos termos do artigo 49 do Código de Defesa do Consumidor. O exercício desse direito não depende de justificativa e assegura a devolução dos valores pagos, conforme a legislação aplicável.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Como solicitar</h2>
      <p>Envie um e-mail para <a href="mailto:obaflixsuporte@gmail.com" style={{ textDecoration: "underline" }}>obaflixsuporte@gmail.com</a>, informando o e-mail da compra, o plano e, se disponível, o identificador do pedido. Não envie senha nem documentos sensíveis por e-mail. A equipe verificará a transação e orientará os próximos passos.</p>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>Outras situações</h2>
      <p>Para problemas de acesso, cobranças indevidas ou falhas na entrega do serviço, contate o suporte pelo mesmo e-mail. Nenhuma disposição desta página limita os direitos previstos no Código de Defesa do Consumidor.</p>
    </PaginaLegal>
  );
}
