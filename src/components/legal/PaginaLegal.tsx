import Link from "next/link";

/** Interface das informações legais por produto. Sem `produto`, é o Obaflix Cortes (as páginas /cortes/*). */
export function PaginaLegal({ titulo, children, produto = "Obaflix Cortes", voltar = "/cortes" }: {
  titulo: string;
  children: React.ReactNode;
  produto?: string;
  /** Destino do link de volta; `null` não mostra o link (páginas do aplicativo, que abrem fora dele). */
  voltar?: string | null;
}) {
  return (
    <article style={{ maxWidth: 800, margin: "0 auto", padding: "48px 20px 72px", color: "#e4e4e7", lineHeight: 1.75 }}>
      {voltar && <Link href={voltar} style={{ fontSize: 13, textDecoration: "underline" }}>← {produto}</Link>}
      <h1 style={{ fontSize: 30, fontWeight: 700, margin: "16px 0 24px" }}>{titulo}</h1>
      <div style={{ display: "grid", gap: 16 }}>{children}</div>
      <p style={{ marginTop: 34, paddingTop: 18, borderTop: "1px solid #3f3f46", fontSize: 13, color: "#a1a1aa" }}>
        {produto} · Atendimento: <a style={{ textDecoration: "underline", color: "#e4e4e7" }} href="mailto:obaflixsuporte@gmail.com">obaflixsuporte@gmail.com</a>
      </p>
    </article>
  );
}

export const EMAIL_SUPORTE = "obaflixsuporte@gmail.com";
export const emailSuporte = () => EMAIL_SUPORTE;
