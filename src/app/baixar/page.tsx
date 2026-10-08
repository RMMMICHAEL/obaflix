import type { Viewport } from "next";
import Image from "next/image";
import { Download, Smartphone, ShieldCheck, ArrowDown, Monitor, Tv } from "lucide-react";
import { INSTALADORES } from "@/config/downloads";
import { ANDROID_DOWNLOAD_PATH, validatedDownloadUrl } from "@/config/public-download";
import { verifiedAndroidMetadata } from "@/config/verified-android";
import { publicDownloadMetadata } from "@/lib/seo";
import { DownloadFooter } from "@/components/landing/DownloadFooter";
import { AndroidDownloadCta } from "@/components/landing/AndroidDownloadCta";
import styles from "./baixar.module.css";

export const dynamic = "force-static";
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#171415" };
export const metadata = publicDownloadMetadata("Obaflix no seu Android", "/baixar",
  "Baixe o aplicativo oficial do Obaflix e leve sua experiência para o celular.");

const androidMetadata = verifiedAndroidMetadata(INSTALADORES.android);
const androidTvUrl = validatedDownloadUrl(INSTALADORES.androidTv.url);
const windowsUrl = validatedDownloadUrl(INSTALADORES.windows.url, "exe");
const steps = [
  ["Baixe o APK.", "Toque em Baixar para Android para obter o instalador."],
  ["Abra o arquivo baixado.", "Encontre o APK nos downloads do seu navegador."],
  ["Autorize este navegador, se solicitado.", "Se o Android pedir autorização, permita a instalação deste navegador."],
  ["Instale e abra o Obaflix.", "Conclua a instalação e encontre o aplicativo no seu celular."],
];

export default function DownloadPage() {
  return <div className={styles.page} data-obaflix-landing>
    <header className={styles.header}>
      <a href="/baixar" className={styles.brand} aria-label="Obaflix">OBAFLIX</a>
      <a href="#como-instalar" className={styles.help}>Como instalar <ArrowDown size={16} aria-hidden="true" /></a>
    </header>
    <section className={styles.hero} aria-labelledby="download-title">
      <div className={styles.heroCopy}>
        <p className={styles.eyebrow}><Smartphone size={17} aria-hidden="true" /> SEU CELULAR. SUA EXPERIÊNCIA.</p>
        <h1 id="download-title">Obaflix no<br />seu <span>Android</span></h1>
        <p className={styles.intro}>Baixe o aplicativo oficial do Obaflix e leve sua experiência para o celular.</p>
        <AndroidDownloadCta downloadPath={ANDROID_DOWNLOAD_PATH} variant="hero" />
        <p className={styles.caption}>Download direto do APK · sem download automático</p>
        {androidMetadata && <p className={styles.caption}>{androidMetadata.label} · {androidMetadata.minimumAndroid}</p>}
      </div>
      <div className={styles.art}>
        <div className={styles.phone}>
          <Image src="/app-mockup.webp" alt="Tela inicial do aplicativo Obaflix" width={560} height={1152} className={styles.appScreen} />
        </div>
      </div>
    </section>
    <section id="como-instalar" className={styles.install} aria-labelledby="install-title">
      <div className={styles.sectionIntro}><p className={styles.eyebrow}>DO DOWNLOAD À PRIMEIRA ABERTURA</p><h2 id="install-title">Como instalar</h2><p>Quatro passos, no seu celular.</p></div>
      <ol className={styles.steps}>{steps.map(([title, text], i) => <li key={title}><span className={styles.number} aria-hidden="true">0{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol>
      <p className={styles.note}>O Android pode solicitar autorização para instalar aplicativos obtidos fora da Play Store. A permissão é concedida ao navegador que você está utilizando.</p>
    </section>
    <section className={styles.trust} aria-labelledby="trust-title">
      <ShieldCheck size={30} aria-hidden="true" />
      <div><h2 id="trust-title">Download seguro e direto</h2><ul>
        <li>O download só começa quando você toca no botão.</li>
        <li>Você não precisa informar senha, CPF ou cartão para baixar o aplicativo.</li>
        <li>O arquivo é hospedado na infraestrutura de downloads do Obaflix.</li>
      </ul><p>Versão e tamanho, quando exibidos, vêm da configuração do instalador verificada para esta página.</p></div>
    </section>
    <section className={styles.devices} aria-labelledby="devices-title">
      <div><p className={styles.eyebrow}>OUTRAS TELAS</p><h2 id="devices-title">Também disponível para</h2></div>
      <div className={styles.deviceLinks}>
        <a href={androidTvUrl ?? undefined} aria-disabled={!androidTvUrl}><Tv size={23} aria-hidden="true" /><span>Android TV / TV Box<small>{androidTvUrl ? "Baixar aplicativo para TV" : "Download temporariamente indisponível"}</small></span><Download size={19} aria-hidden="true" /></a>
        <a href={windowsUrl ?? undefined} aria-disabled={!windowsUrl}><Monitor size={23} aria-hidden="true" /><span>Windows<small>{windowsUrl ? "Baixar aplicativo para computador" : "Download temporariamente indisponível"}</small></span><Download size={19} aria-hidden="true" /></a>
      </div>
    </section>
    <section className={styles.final} aria-labelledby="final-title"><Smartphone size={26} aria-hidden="true" /><h2 id="final-title">Sua próxima tela<br />já está na sua mão.</h2><AndroidDownloadCta downloadPath={ANDROID_DOWNLOAD_PATH} /><p className={styles.caption}>Você decide quando baixar.</p></section>
    <DownloadFooter />
    <aside className={styles.mobileBar} aria-label="Download para Android"><div className={styles.miniIcon} aria-hidden="true">O</div><div className={styles.barText}>Obaflix para Android<small>{androidMetadata?.label ?? "Download direto do APK"}</small></div><AndroidDownloadCta downloadPath={ANDROID_DOWNLOAD_PATH} variant="bar" /></aside>
  </div>;
}
