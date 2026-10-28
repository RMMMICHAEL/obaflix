import type { Metadata } from "next";
import { Suspense } from "react";
import { INSTALADORES } from "@/config/downloads";
import { audit } from "@/lib/auditLog";
import { CheckoutCortes } from "./CheckoutCortes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { absolute: "Checkout | Obaflix Cortes" },
  robots: { index: false, follow: false, noarchive: true },
};

export default function PaginaCheckoutCortes() {
  // Contagem agregada. Não se registra query, e-mail, CPF, telefone ou IP.
  audit("cortes_checkout_view", { detail: "checkout" });
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#101014] p-8 text-white">Preparando checkout…</main>}>
      <CheckoutCortes
        vendasPublicas={process.env.CAKTO_VENDAS_PUBLICAS === "true"}
        instaladorUrl={INSTALADORES.windowsCortes.url}
      />
    </Suspense>
  );
}
