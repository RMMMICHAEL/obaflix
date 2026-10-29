import Link from "next/link";

/** Interface das informações comerciais e legais do Obaflix Cortes. */
export function PaginaLegal({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <article style={{ maxWidth: 800, margin: "0 auto", padding: "48px 20px 72px", color: "#e4e4e7", lineHeight: 1.75 }}>
      <Link href="/cortes" style={{ fontSize: 13, textDecoration: "underline" }}>← Obaflix Cortes</Link>
      <h1 style={{ fontSize: 30, fontWeight: 700, margin: "16px 0 24px" }}>{titulo}</h1>
      <div style={{ display: "grid", gap: 16 }}>{children}</div>
      <p style={{ marginTop: 34, paddingTop: 18, borderTop: "1px solid #3f3f46", fontSize: 13, color: "#a1a1aa" }}>
        Obaflix Cortes · Atendimento: <a style={{ textDecoration: "underline", color: "#e4e4e7" }} href="mailto:obaflixsuporte@gmail.com">obaflixsuporte@gmail.com</a>
      </p>
    </article>
  );
}

export const EMAIL_SUPORTE = "obaflixsuporte@gmail.com";
export const emailSuporte = () => EMAIL_SUPORTE;
