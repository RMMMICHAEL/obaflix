import Link from "next/link";

const LINKS = [
  ["/termos", "Termos de Uso"],
  ["/privacidade", "Política de Privacidade"],
  ["/reembolso", "Política de Reembolso"],
  ["/suporte", "Contato / Suporte"],
] as const;

export function FooterLegalCortes() {
  return (
    <nav aria-label="Informações legais" style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", justifyContent: "center", padding: "0 5% 28px", fontSize: 12, color: "var(--muted)" }}>
      {LINKS.map(([href, rotulo]) => <Link key={href} href={href} style={{ textDecoration: "underline" }}>{rotulo}</Link>)}
    </nav>
  );
}
