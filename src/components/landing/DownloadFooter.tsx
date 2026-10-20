import { getLegalConfig } from "@/config/legal";
import styles from "@/app/baixar/baixar.module.css";

export function DownloadFooter() {
  const { email } = getLegalConfig();
  return <footer className={styles.footer}>
    <a className={styles.brand} href="/baixar" aria-label="Obaflix, página de download">OBAFLIX</a>
    <nav aria-label="Informações legais">
      <a href="/termos">Termos de Uso</a>
      <a href="/privacidade">Política de Privacidade</a>
      <a href={email ? `mailto:${email}` : "/privacidade#contato"}>Contato</a>
    </nav>
    <small>© 2026 Obaflix</small>
  </footer>;
}
