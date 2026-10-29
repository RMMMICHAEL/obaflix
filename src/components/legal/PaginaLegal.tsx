import Link from "next/link";

/** Página legal simples. `pendencias` lista o que depende de aprovação do responsável; nada aqui é dado oficial inventado. */
export function PaginaLegal({ titulo, children, pendencias }: { titulo: string; children: React.ReactNode; pendencias: string[] }) {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 20px", color: "#e4e4e7", lineHeight: 1.7 }}>
      <Link href="/cortes" style={{ fontSize: 13, textDecoration: "underline" }}>← Obaflix Cortes</Link>
      <h1 style={{ fontSize: 30, fontWeight: 700, margin: "16px 0 24px" }}>{titulo}</h1>
      <div style={{ display: "grid", gap: 14 }}>{children}</div>
      <aside style={{ marginTop: 32, padding: 14, border: "1px solid #78350f", borderRadius: 10, fontSize: 13, color: "#fcd34d" }}>
        <strong>Rascunho em revisão, sem validade como documento final.</strong> Dados oficiais ainda não informados: {pendencias.join("; ")}.
      </aside>
    </main>
  );
}

export const EMAIL_SUPORTE = "obaflixsuporte@gmail.com";
export const emailSuporte = () => EMAIL_SUPORTE;
