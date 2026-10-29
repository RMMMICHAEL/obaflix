import type { Metadata } from "next";
import { PaginaLegal, emailSuporte } from "@/components/legal/PaginaLegal";

export const metadata: Metadata = { title: "Contato / Suporte | Obaflix Cortes", robots: { index: false, follow: false } };

export default function Pagina() {
  const email = emailSuporte();
  return (
    <PaginaLegal titulo="Contato / Suporte" pendencias={["horário oficial de atendimento","CNPJ e endereço comercial, se desejado"]}>
      <p>Fale com o suporte pelo e-mail <a href={`mailto:${email}`} style={{ textDecoration: "underline" }}>{email}</a>.</p>
      <p>Informe o e-mail usado na compra para agilizar o atendimento. Nunca envie senhas.</p>
    </PaginaLegal>
  );
}
