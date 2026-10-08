import { DownloadFooter } from "./DownloadFooter";
import { getLegalConfig, LEGAL_UPDATED_AT } from "@/config/legal";
import styles from "@/app/baixar/baixar.module.css";

export function LegalIdentity() {
  const legal = getLegalConfig();
  return <section id="contato"><h2>Responsável e contato</h2>
    <p>{legal.name ? `Responsável pelo Obaflix: ${legal.name}.` : "A identificação legal do responsável pelo Obaflix está pendente de publicação."}</p>
    {legal.document && <p>Documento: {legal.document}</p>}
    {legal.address && <p>Endereço: {legal.address}</p>}
    {legal.dpo && <p>Encarregado de proteção de dados: {legal.dpo}</p>}
    <p>{legal.email ? <>Para suporte, questões sobre estes documentos ou pedidos relativos aos seus dados, escreva para <a href={`mailto:${legal.email}`}>{legal.email}</a>.</> : "O endereço de contato será publicado nesta seção assim que estiver configurado."}</p>
    <p>Para proteger sua conta, podemos solicitar informações proporcionais à confirmação da sua identidade. Não envie sua senha por e-mail.</p>
  </section>;
}

export function LegalDocument({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className={styles.page}>
    <header className={styles.header}><a href="/baixar" className={styles.brand} aria-label="Obaflix, página de download">OBAFLIX</a><a href="/baixar" className={styles.help}>Baixar aplicativo</a></header>
    <article className={styles.legal}><h1>{title}</h1><p><time dateTime="2026-10-08">Última atualização: {LEGAL_UPDATED_AT}</time></p>{children}<LegalIdentity /></article>
    <DownloadFooter />
  </div>;
}
