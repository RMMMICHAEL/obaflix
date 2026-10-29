import type { Metadata } from "next";
import { PaginaLegal, emailSuporte } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Termos de Uso | Obaflix Cortes", robots: { index: true } };

export default function Pagina() {
  const email = emailSuporte();
  return (
    <PaginaLegal titulo="Termos de Uso" pendencias={["razão social e CNPJ do responsável","regras de uso aceitável","limitação de responsabilidade","foro"]}>
      <p>O Obaflix Cortes é uma assinatura por período, paga por Pix, sem renovação automática, para maiores de 18 anos. O acesso é vinculado ao e-mail informado na compra e liberado após a confirmação do pagamento.</p>
      <p>O Cortes soma ao plano Obaflix da conta e não o cancela. A exportação depende da fonte e dos componentes disponíveis no aplicativo.</p>
    </PaginaLegal>
  );
}
