import type { Metadata } from "next";
import { LandingCortes } from "@/components/cortes/LandingCortes";
import { INSTALADORES } from "@/config/downloads";

export const metadata: Metadata = {
  title: "Obaflix Cortes — baixe só a cena que você quer",
  description:
    "Escolha o início e o fim de uma cena de filme ou série e baixe só esse trecho no aplicativo do Obaflix para Windows. No Cortes Pro, baixe vários trechos de uma vez.",
  alternates: { canonical: "/cortes" },
};

/**
 * Página de vendas do Obaflix Cortes. Preços e disponibilidade vêm ao vivo de
 * `GET /api/billing/plans` (mesma fonte de /planos e do checkout); aqui não há
 * valor fixo. A compra é o checkout existente, sem login para Cortes.
 */
export default function CortesPage() {
  return <LandingCortes instalador={INSTALADORES.windowsCortes} />;
}
