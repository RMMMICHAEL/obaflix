import type { Metadata } from "next";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Monitor,
  Scissors,
  Sparkles,
} from "lucide-react";
import { JsonLd } from "@/components/seo/JsonLd";
import styles from "./cortes.module.css";

const description =
  "Assista a filmes e séries e selecione cenas diretamente no player do Obaflix Cortes para Windows, sem baixar o episódio completo antes de preparar seus trechos.";
export const metadata: Metadata = {
  title: { absolute: "Obaflix Cortes | Assista e faça cortes ao mesmo tempo" },
  description,
  alternates: { canonical: "/cortes" },
  category: "technology",
  keywords: [
    "Obaflix Cortes",
    "selecionar trechos de vídeo",
    "cortes para criadores",
    "edição de vídeo Windows",
  ],
  openGraph: {
    title: "Obaflix Cortes | Assista e faça cortes ao mesmo tempo",
    description,
    url: "/cortes",
    type: "website",
    locale: "pt_BR",
    images: [
      {
        url: "/cortes/social.png",
        width: 1200,
        height: 630,
        alt: "Obaflix Cortes: do momento ao trecho, pronto para editar",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Obaflix Cortes",
    description,
    images: ["/cortes/social.png"],
  },
};

const faqs = [
  [
    "Preciso baixar o filme ou episódio inteiro?",
    "Não é necessário baixar o vídeo completo antes de selecionar o corte. Enquanto assiste no aplicativo Windows, marque início e fim, confira a prévia e baixe o trecho. O recorte depende de uma fonte e de um formato compatíveis; alguns caminhos exigem FFmpeg.",
  ],
  [
    "Funciona no Windows? Preciso instalar?",
    "O fluxo de recorte apresentado existe no aplicativo desktop Electron para Windows e exige instalação. Esta página pode ser consultada no celular, mas não é um editor online. Os requisitos e a distribuição comercial do Cortes serão informados no lançamento.",
  ],
  [
    "Posso preparar vários cortes?",
    "Você pode repetir o processo para preparar vários trechos, um de cada vez. Seleção de múltiplos intervalos, fila de cortes e exportação em lote não estão disponíveis no fluxo atual.",
  ],
  [
    "Ele substitui meu editor de vídeo?",
    "Não. O Obaflix prepara os trechos. Montagem, sincronização com a narração, legendas e finalização continuam no editor que você já usa.",
  ],
  [
    "Todo conteúdo pode ser exportado?",
    "A disponibilidade e o resultado dependem da fonte, do formato e das condições de reprodução. Alguns formatos precisam de FFmpeg no aplicativo. Confira o trecho antes de levá-lo à edição e utilize apenas conteúdo para o qual você tenha autorização de uso.",
  ],
  [
    "Qual a diferença entre Start, Pro e AI?",
    "São nomes previstos para futuras modalidades. Preços, limites, recursos incluídos e critérios de acesso ainda não foram definidos. As assinaturas tradicionais do Obaflix não representam uma oferta comercial do Cortes.",
  ],
  [
    "A inteligência artificial já está disponível?",
    "Ainda não. Receber um roteiro, sugerir momentos e preencher um painel de cortes é uma visão em desenvolvimento. Não há data de lançamento confirmada nem contratação da IA nesta página.",
  ],
  [
    "Já posso contratar ou entrar em uma lista de espera?",
    "O checkout e a lista de interessados do Cortes ainda não estão disponíveis. Por enquanto, esta página apresenta o produto e seu fluxo, sem coletar dados ou realizar cobranças.",
  ],
];

export default function CortesPage() {
  return (
    <div
      data-obaflix-landing
      data-cortes-variant="demo"
      className={styles.page}
      id="inicio"
    >
      <a className={styles.skip} href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className={styles.header}>
        <a
          href="#inicio"
          className={styles.brand}
        >
          <span>
            OBA<span>FLIX</span>
          </span>
          <i />
          <b>CORTES</b>
        </a>
        <nav aria-label="Obaflix Cortes">
          <a href="#fluxo">Como funciona</a>
          <a href="#recursos">Recursos</a>
          <a href="#duvidas">Dúvidas</a>
        </nav>
        <a
          href="#demonstracao"
          className={styles.headerCta}
          data-cortes-cta="header"
        >
          Como funciona <ArrowUpRight size={16} aria-hidden />
        </a>
      </header>

      <section className={styles.hero} id="conteudo" aria-labelledby="titulo">
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>
            <Scissors size={15} aria-hidden /> Para quem cria com filmes e séries
          </p>
          <h1 id="titulo">
            Assista e faça cortes <span>ao mesmo tempo.</span>
          </h1>
          <p className={styles.lead}>
            Achou uma cena enquanto assiste? Selecione o trecho direto no player
            e prepare seu vídeo, sem baixar o episódio completo antes.
          </p>
          <div className={styles.actions}>
            <a
              href="#demonstracao"
              className={styles.primary}
              data-cortes-cta="hero"
            >
              Veja como preparar um corte <ArrowDown size={18} aria-hidden />
            </a>
            <a href="#recursos" className={styles.textLink}>
              Explore os recursos <ArrowUpRight size={17} aria-hidden />
            </a>
          </div>
          <p className={styles.availability}>
            <Monitor size={15} aria-hidden /> Fluxo para Windows <span>·</span>{" "}
            Oferta comercial em preparação
          </p>
        </div>
        <aside className={styles.recording} aria-labelledby="gravacao-titulo">
          <div className={styles.recordingScreen}>
            <Monitor size={36} aria-hidden />
            <span>APLICATIVO WINDOWS</span>
            <h2 id="gravacao-titulo">Veja o corte acontecer.</h2>
            <p>Uma gravação real mostrará a cena em reprodução, a seleção no player e o trecho exportado.</p>
            <small>Gravação ainda não disponível.</small>
          </div>
          <p className={styles.recordingCaption}>Demonstração real do aplicativo, sem simulação de telas.</p>
        </aside>
      </section>
      <div className={styles.audience}>
        <span>Para quem transforma cenas em histórias</span>
        <p>
          YouTube <i /> Shorts <i /> Reels <i /> TikTok <i /> Análises e resumos
        </p>
      </div>

      <section className={`${styles.section} ${styles.demoSection}`} id="demonstracao" aria-labelledby="demo-titulo">
        <div id="fluxo" className={styles.sectionIntro}>
          <div>
            <p className={styles.overline}>A narração está pronta. A faixa de vídeo, vazia.</p>
            <h2 id="demo-titulo">Da voz às cenas, em quatro passos.</h2>
          </div>
          <p>Seu roteiro está pronto. Agora encontre as cenas: assista no Obaflix, prepare os trechos e leve os arquivos para a montagem.</p>
        </div>
        <ol className={styles.flowSteps}>
          <li><span>01 / NO SEU EDITOR</span><h3>Comece pela narração.</h3><p>Use o roteiro e a voz para saber quais imagens sua história precisa.</p></li>
          <li><span>02 / NO OBAFLIX</span><h3>Encontre a cena.</h3><p>Assista a filmes e séries. Ao encontrar uma cena para seu roteiro, selecione o trecho no próprio player.</p></li>
          <li><span>03 / PREPARE O TRECHO</span><h3>Marque, confira e baixe.</h3><p>Ajuste início e fim, veja a prévia e exporte. Repita para cada novo intervalo.</p></li>
          <li><span>04 / DE VOLTA AO EDITOR</span><h3>Monte sua história.</h3><p>Importe os arquivos e alinhe as cenas à narração. A edição continua com você.</p></li>
        </ol>
      </section>

      <section
        className={styles.section}
        id="recursos"
        aria-labelledby="recursos-titulo"
      >
        <div className={styles.sectionIntro}>
          <div>
            <p className={styles.overline}>
              O que já existe no aplicativo Windows
            </p>
            <h2 id="recursos-titulo">
              Controle do primeiro
              <br />
              ao último segundo.
            </h2>
          </div>
          <span className={styles.status}>
            <Check size={15} aria-hidden /> Capacidades do fluxo atual
          </span>
        </div>
        <div className={styles.features}>
          <article>
            <Scissors size={30} aria-hidden />
            <h3>Seu trecho, seus limites.</h3>
            <p>
              Defina início e fim pelos campos de tempo ou ajuste a seleção na
              barra do player. A precisão final pode variar conforme a fonte e o
              formato.
            </p>
          </article>
          <div>
            <article>
              <h3>Confira antes de exportar.</h3>
              <p>
                A prévia reproduz a seleção e para no fim do intervalo para você
                conferir o momento escolhido.
              </p>
            </article>
            <article>
              <h3>Um corte. Depois, o próximo.</h3>
              <p>
                Baixe o trecho e repita o processo. Vários arquivos podem compor
                seu projeto, com exportação individual.
              </p>
            </article>
            <article>
              <h3>Mais histórias para descobrir.</h3>
              <p>
                Explore filmes e séries em um catálogo em constante atualização.
                Encontre referências para suas análises, resumos e próximos vídeos.
              </p>
            </article>
          </div>
        </div>
        <p className={styles.note}>
          Seleção em lote e painel com múltiplos cortes ainda não fazem parte
          deste fluxo. A exportação depende da fonte e dos componentes
          disponíveis no aplicativo.
        </p>
      </section>

      <aside className={`${styles.section} ${styles.futureNote}`} aria-labelledby="ai-titulo">
        <span className={styles.future}><Sparkles size={14} aria-hidden /> Em desenvolvimento · indisponível hoje</span>
        <h2 id="ai-titulo">Mais adiante: Obaflix Cortes AI.</h2>
        <p>A visão futura é receber seu roteiro no player, sugerir momentos e preencher um painel de cortes para revisão. Essas funções ainda não existem no fluxo atual e não têm data confirmada.</p>
      </aside>

      <section
        className={styles.section}
        id="lancamento"
        aria-labelledby="planos-titulo"
      >
        <div className={styles.sectionIntro}>
          <div>
            <p className={styles.overline}>Um produto com próximos capítulos</p>
            <h2 id="planos-titulo">Uma oferta própria, em preparação.</h2>
          </div>
          <p>
            Modalidades em preparação. Os detalhes serão apresentados quando a
            oferta comercial estiver pronta.
          </p>
        </div>
        <div className={styles.planList}>
          {["Start", "Pro", "AI"].map((plan, i) => (
            <article key={plan}>
              <span>OBAFLIX CORTES</span>
              <h3>{plan}</h3>
              <p>
                {i === 2
                  ? "Visão de uma modalidade com inteligência artificial, ainda em desenvolvimento."
                  : "Modalidade prevista. Recursos incluídos e limites ainda serão definidos."}
              </p>
              <small>
                {i === 2
                  ? "IA indisponível atualmente"
                  : "Detalhes em preparação"}
              </small>
            </article>
          ))}
        </div>
        <p className={styles.note}>
          Sem valores ou contratação por enquanto. O Cortes terá uma oferta
          própria; esta página não vende os planos tradicionais do Obaflix.
        </p>
      </section>

      <section
        className={`${styles.section} ${styles.faq}`}
        id="duvidas"
        aria-labelledby="faq-titulo"
      >
        <div>
          <p className={styles.overline}>Antes do próximo corte</p>
          <h2 id="faq-titulo">Ficou alguma dúvida?</h2>
        </div>
        <div>
          {faqs.map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <span aria-hidden>+</span>
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
      <section className={styles.final} aria-labelledby="final-titulo">
        <Scissors size={34} aria-hidden />
        <h2 id="final-titulo">
          Encontrou a cena?
          <br />
          <span>Transforme em parte da sua história.</span>
        </h2>
        <p>
          Assista, selecione e prepare o trecho. Depois, dê o seu olhar
          à montagem no editor que você já usa.
        </p>
        <a
          href="#demonstracao"
          className={styles.primary}
          data-cortes-cta="footer"
        >
          Conheça o fluxo de cortes <ArrowUpRight size={18} aria-hidden />
        </a>
        <small>
          O checkout e a lista de interessados do Cortes ainda não estão
          disponíveis.
        </small>
      </section>
      <footer className={styles.footer}>
        <a href="#inicio" className={styles.brand}>
          <span>
            OBA<span>FLIX</span>
          </span>
          <i />
          <b>CORTES</b>
        </a>
        <p>Menos procura. Mais edição.</p>
        <a href="#duvidas">
          Dúvidas sobre o produto <ArrowUpRight size={14} aria-hidden />
        </a>
      </footer>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqs.map(([name, text]) => ({
            "@type": "Question",
            name,
            acceptedAnswer: { "@type": "Answer", text },
          })),
        }}
      />
    </div>
  );
}
