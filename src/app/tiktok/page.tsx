import type { Metadata } from "next";
import Image from "next/image";
import { Download, Ellipsis, Gift, MapPin, Monitor, MonitorSmartphone, Play, Scissors, Search, Smartphone, Tv, Zap } from "lucide-react";
import { SecaoDownloads } from "@/components/landing/SecaoDownloads";
import { TikTokTrending } from "@/components/landing/TikTokTrending";
import { TIKTOK_CONTENT } from "@/components/landing/tiktok-content";
import { INSTALADORES } from "@/config/downloads";
import styles from "./tiktok.module.css";

export const metadata: Metadata = {
  title: "Conheça e baixe o Obaflix pelo TikTok",
  description: "Abra no navegador do celular, conheça o Obaflix e baixe para Android, Android TV ou Windows.",
  robots: { index: false, follow: true },
  alternates: { canonical: "/" },
};

const benefits = [
  { icon: MonitorSmartphone, title: "Assista no celular, computador e TV", text: "Tenha a melhor experiência em toda e qualquer tela." },
  { icon: Download, title: "Baixe filmes e séries para assistir offline", text: "Salve seus títulos favoritos e assista mesmo sem internet." },
  { icon: MapPin, title: "Assista onde quiser", text: "Continue de onde parou, no seu celular, tablet, computador ou TV." },
  { icon: Scissors, title: "Veja cortes dos conteúdos", text: "Acompanhe os melhores momentos, trailers, bastidores e muito mais." },
  { icon: Gift, title: "Conteúdos grátis sem custo adicional", text: "Aproveite uma seleção especial de filmes, séries e canais gratuitos." },
  { icon: Zap, title: "Interface simples e rápida", text: "Navegue com facilidade e encontre seus conteúdos preferidos em segundos." },
];

export default function TikTokPage() {
  return (
    <div data-obaflix-landing className={styles.page}>
      <section className={styles.warning} aria-labelledby="abrir-navegador">
        <div className={styles.warningIntro}>
          <p className={styles.eyebrow}>Veio pelo TikTok? Comece aqui</p>
          <h1 id="abrir-navegador">Para baixar o Obaflix, abra esta página no navegador do celular.</h1>
          <p>O navegador dentro do TikTok pode impedir o download.</p>
        </div>
        <ol className={styles.steps}>
          <li><span aria-hidden="true">1</span><p>Toque nos três pontinhos <Ellipsis size={22} aria-hidden="true" className={styles.dots} /> <span className="sr-only">⋯</span> no <strong>canto superior direito do TikTok</strong>.</p></li>
          <li><span aria-hidden="true">2</span><p>Toque em <strong>“Abrir no navegador”</strong>.</p></li>
          <li><span aria-hidden="true">3</span><p>Depois escolha <strong>Android, Android TV ou Windows</strong> e faça o download.</p></li>
        </ol>
        <p className={styles.warningNote}>O site não consegue forçar o TikTok a abrir outro navegador. Use o menu ⋯ do próprio TikTok.</p>
      </section>

      <div id="inicio" className={styles.promotion}>
        <header className={styles.navbar}>
          <a href="#inicio" className={styles.logo} aria-label="Obaflix, início">OBA<span>FLIX</span></a>
          <nav aria-label="Apresentação do Obaflix"><a href="#inicio" className={styles.active}>Início</a><a href="#filmes">Filmes</a><a href="#series">Séries</a><a href="#canais">Canais</a><a href="#infantil">Infantil</a><a href="#minha-lista">Minha Lista</a></nav>
          <span className={styles.language}>Português</span>
          <a href="#buscar-conteudos" className={styles.navSearch} aria-label="Buscar nesta seleção de conteúdos"><Search size={19} aria-hidden="true" /></a>
          <a href="#baixar" className={styles.navDownload}><Download size={16} aria-hidden="true" />Baixar aplicativo</a>
        </header>
        <section className={styles.hero} aria-labelledby="apresentacao">
          <div className={styles.mosaic} aria-hidden="true">{TIKTOK_CONTENT.map((item) => <Image key={item.titulo} src={item.poster} alt="" width={342} height={513} unoptimized loading="lazy" referrerPolicy="no-referrer" />)}</div>
          <div className={styles.heroContent}>
            <p className={styles.eyebrow}>Um aplicativo. Todas as suas telas.</p>
            <h2 id="apresentacao">Tudo para assistir,<span>em qualquer tela.</span></h2>
            <p className={styles.heroDescription}>Assista no celular, computador e TV. Baixe para ver offline, acompanhe cortes e aproveite conteúdos grátis sem custo adicional.</p>
            <div className={styles.heroActions}><a href="#baixar" className={styles.primary}><Download size={20} aria-hidden="true" />Baixar aplicativo</a><a href="#conteudos" className={styles.outline}><Play size={18} aria-hidden="true" />Ver conteúdos</a></div>
            <p className={styles.heroFootnote}>Android · Android TV e TV Box · Windows</p>
          </div>
        </section>
      </div>

      <section className={styles.categories} aria-label="Explore no aplicativo">
        <div id="filmes"><strong>Filmes</strong><span>Histórias para todos os momentos</span></div><div id="series"><strong>Séries</strong><span>Seu próximo episódio favorito</span></div><div id="canais"><strong>Canais</strong><span>Conteúdo ao vivo no aplicativo</span></div><div id="infantil"><strong>Infantil</strong><span>Diversão para os pequenos</span></div><div id="minha-lista"><strong>Minha Lista</strong><span>Salve favoritos na sua conta do app</span></div>
      </section>
      <TikTokTrending />
      <section className={styles.section} aria-labelledby="beneficios">
        <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Muito além do play</p><h2 id="beneficios">Benefícios do aplicativo</h2></div></div>
        <div className={styles.benefits}>{benefits.map(({ icon: Icon, title, text }) => <article key={title}><Icon size={26} aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}</div>
        <p className={styles.benefitsNote}>Disponibilidade de recursos e download offline varia conforme o conteúdo e o aparelho.</p>
      </section>
      <section className={styles.deviceCta} aria-labelledby="dispositivos">
        <div><h2 id="dispositivos"><span className={styles.logo}>OBA<span>FLIX</span></span> em todos os seus dispositivos</h2><p>Baixe agora e comece a assistir onde quiser.</p></div>
        <ul><li><Smartphone aria-hidden="true" /><strong>Android</strong><span>Smartphones e Tablets</span></li><li><Monitor aria-hidden="true" /><strong>Windows</strong><span>Computadores</span></li><li><Tv aria-hidden="true" /><strong>Smart TVs</strong><span>Android TV e TV Box</span></li></ul>
        <a href="#baixar" className={styles.primary}><Download size={18} aria-hidden="true" />Baixar aplicativo</a>
      </section>
      <div className={styles.downloads}>
        <p className={styles.ready}>Já abriu no Chrome ou Safari? Baixe abaixo.</p>
        <SecaoDownloads android={INSTALADORES.android} androidTv={INSTALADORES.androidTv} windows={INSTALADORES.windows} />
      </div>
      <footer className={styles.footer}><span className={styles.logo}>OBA<span>FLIX</span></span><p>Sua próxima história, na sua tela.</p><a href="#inicio">Voltar ao início ↑</a></footer>
    </div>
  );
}
