import type { Metadata } from "next";
import { PaginaLegal, emailSuporte } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Política de Reembolso | Obaflix Cortes", robots: { index: true } };

export default function Pagina() {
  const email = emailSuporte();
  return (
    <PaginaLegal titulo="Política de Reembolso" pendencias={["prazo e condições de reembolso/arrependimento","forma e prazo da devolução","regras após o uso do serviço"]}>
      <p>A compra é feita por Pix, sem renovação automática e sem nova cobrança.</p>
      <p>As condições de reembolso e arrependimento ainda não foram publicadas. Em caso de dúvida sobre uma compra, fale com o suporte.</p>
    </PaginaLegal>
  );
}
