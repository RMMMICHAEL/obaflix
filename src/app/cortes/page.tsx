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
import { CortesDemo } from "./CortesDemo";
import styles from "./cortes.module.css";

const description =
  "Encontre momentos, selecione trechos e prepare seu material para edição com o Obaflix Cortes para Windows. Conheça o fluxo e os próximos passos do produto.";
export const metadata: Metadata = {
  title: { absolute: "Obaflix Cortes | Menos procura. Mais edição." },
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
    title: "Obaflix Cortes | Menos procura. Mais edição.",
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
    "Como funciona o Obaflix Cortes?",
    "O fluxo parte do player: você navega até o momento desejado, marca início e fim, confere a prévia e baixa o trecho. Depois, leva o arquivo para o editor que já usa. A demonstração desta página é ilustrativa e não processa vídeos.",
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
    "Não. A proposta é ajudar na preparação do material. Montagem, sincronização com a narração, legendas e finalização continuam no seu editor. A timeline mostrada aqui representa essa etapa externa.",
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
          aria-label="Obaflix Cortes, início"
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
          Ver na prática <ArrowUpRight size={16} aria-hidden />
        </a>
      </header>

      <section className={styles.hero} id="conteudo" aria-labelledby="titulo">
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>
            <Scissors size={15} aria-hidden /> Seu próximo vídeo começa no
            trecho certo
          </p>
          <h1 id="titulo">
            Pare de perder horas <span>procurando cenas</span> para seus vídeos.
          </h1>
          <p className={styles.lead}>
            Encontre seus momentos favoritos, selecione os trechos que precisa e
            prepare tudo para sua edição em um só lugar.
          </p>
          <div className={styles.actions}>
            <a
              href="#demonstracao"
              className={styles.primary}
              data-cortes-cta="hero"
            >
              Veja como funciona <ArrowDown size={18} aria-hidden />
            </a>
            <a href="#lancamento" className={styles.textLink}>
              Conheça o Cortes <ArrowUpRight size={17} aria-hidden />
            </a>
          </div>
          <p className={styles.availability}>
            <Monitor size={15} aria-hidden /> Fluxo para Windows <span>·</span>{" "}
            Oferta comercial em preparação
          </p>
        </div>
        <div className={styles.heroVisual}>
          <div className={styles.windowTop}>
            <span>
              <Scissors size={14} aria-hidden /> Obaflix Cortes
            </span>
            <span aria-hidden>− &nbsp; □ &nbsp; ×</span>
          </div>
          <div
            className={styles.playerArt}
            role="img"
            aria-label="Cena vetorial original de montanhas ao pôr do sol, usada como exemplo de seleção de trecho"
          >
            <svg viewBox="0 0 700 420" aria-hidden>
              <defs>
                <linearGradient id="sky" x2="0" y2="1">
                  <stop stopColor="#c49373" />
                  <stop offset="1" stopColor="#443a4a" />
                </linearGradient>
              </defs>
              <path fill="url(#sky)" d="M0 0h700v420H0z" />
              <circle cx="463" cy="117" r="48" fill="#eed0a0" />
              <path
                fill="#63525a"
                d="M0 260 170 110 330 277 500 188 700 286V420H0z"
              />
              <path
                fill="#393c47"
                d="m0 325 261-173 220 241 118-139 101 74v92H0z"
              />
              <path
                fill="#202d35"
                d="m0 364 147-98 178 154H0zm360 56 207-142 133 71v71z"
              />
              <path fill="#a8a699" d="m286 420 77-132 20-13-22 74 66 71z" />
              <path fill="#d3b998" d="m306 420 57-132 9-5-34 93 38 44z" />
            </svg>
            <span className={styles.artLabel}>
              EXEMPLO VISUAL · CENA ORIGINAL
            </span>
            <span className={styles.timecode}>00:24:18</span>
          </div>
          <div className={styles.playerControls}>
            <span aria-hidden>Ⅱ</span>
            <span>
              24:18 <span>/ 01:32:00</span>
            </span>
            <Scissors size={16} aria-hidden />
          </div>
          <div className={styles.selection}>
            <span />
            <b />
          </div>
          <div className={styles.cutPanel}>
            <div>
              <small>INÍCIO</small>
              <strong>00:24:18</strong>
            </div>
            <span>→</span>
            <div>
              <small>FIM</small>
              <strong>00:24:30</strong>
            </div>
            <span className={styles.cutAction}>
              Trecho de 12s <Check size={14} aria-hidden />
            </span>
          </div>
          <p className={styles.visualCaption}>
            Encontre. Marque. Confira. Prepare para editar.
          </p>
          <span className={styles.annotation}>
            O momento que faltava
            <br />
            no seu roteiro. <Scissors size={23} aria-hidden />
          </span>
        </div>
      </section>
      <div className={styles.audience}>
        <span>Para quem transforma cenas em histórias</span>
        <p>
          YouTube <i /> Shorts <i /> Reels <i /> TikTok <i /> Análises e resumos
        </p>
      </div>

      <section
        className={`${styles.section} ${styles.problem}`}
        aria-labelledby="problema"
      >
        <div>
          <p className={styles.overline}>
            O roteiro está pronto. As cenas, ainda não.
          </p>
          <h2 id="problema">
            Sua criatividade não deveria ficar <span>presa na procura.</span>
          </h2>
        </div>
        <div className={styles.problemList}>
          <p>
            <span>01</span> Abrir várias abas atrás de um scene pack que talvez
            nem tenha o que você precisa.
          </p>
          <p>
            <span>02</span> Rever o vídeo, anotar horários e tentar lembrar onde
            estava aquela cena.
          </p>
          <p>
            <span>03</span> Chegar ao editor com a narração pronta e a faixa de
            vídeo vazia.
          </p>
        </div>
      </section>

      <section className={styles.section} id="fluxo" aria-labelledby="solucao">
        <div className={styles.sectionIntro}>
          <div>
            <p className={styles.overline}>Da ideia ao material de edição</p>
            <h2 id="solucao">
              Menos vai e volta.
              <br />
              Mais história na timeline.
            </h2>
          </div>
          <p>
            Reúna a busca pelo momento e a preparação do trecho no mesmo fluxo.
            Leve para o editor só o que você escolheu.
          </p>
        </div>
        <ol className={styles.workflow}>
          <li>
            <span>01 / ENCONTRE</span>
            <h3>Vá até o momento.</h3>
            <p>
              Navegue pelo conteúdo no player e encontre a cena que conversa com
              o seu roteiro.
            </p>
          </li>
          <li>
            <span>02 / SELECIONE</span>
            <h3>Fique com o que importa.</h3>
            <p>
              Ajuste o início e o fim. Veja a prévia para conferir o trecho
              antes de baixar.
            </p>
          </li>
          <li>
            <span>03 / PREPARE</span>
            <h3>Leve para a edição.</h3>
            <p>
              Exporte um trecho por vez e organize os arquivos no seu fluxo de
              trabalho.
            </p>
          </li>
        </ol>
      </section>

      <section
        className={`${styles.section} ${styles.demoSection}`}
        id="demonstracao"
        aria-labelledby="demo-titulo"
      >
        <div className={styles.sectionIntro}>
          <div>
            <p className={styles.overline}>
              Veja o caminho do seu próximo corte
            </p>
            <h2 id="demo-titulo">Da narração ao trecho certo.</h2>
          </div>
          <p>
            Explore as três etapas. Uma representação do processo, da procura no
            player à montagem no seu editor.
          </p>
        </div>
        <CortesDemo />
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
              <h3>Acompanhe a preparação.</h3>
              <p>
                Veja o progresso do download e localize o arquivo salvo.
                Organize os trechos nas suas pastas para levar ao editor.
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

      <section
        className={`${styles.section} ${styles.ai}`}
        aria-labelledby="ai-titulo"
      >
        <div>
          <span className={styles.future}>
            <Sparkles size={14} aria-hidden /> Em desenvolvimento · indisponível
            hoje
          </span>
          <h2 id="ai-titulo">
            Você traz o roteiro.
            <br />A IA ajuda a encontrar
            <br />
            <span>os momentos.</span>
          </h2>
          <p>
            A visão do Obaflix Cortes AI é receber seu roteiro dentro do player,
            sugerir cenas relacionadas e preencher um painel de cortes para sua
            revisão.
          </p>
          <p className={styles.note}>
            Uma próxima etapa do produto, sem data confirmada. As sugestões e o
            painel de cortes com IA ainda não estão disponíveis.
          </p>
        </div>
        <div
          className={styles.scriptPreview}
          aria-label="Conceito futuro da IA, ainda não funcional"
        >
          <span>VISÃO DO PRODUTO / CORTES AI</span>
          <p>
            “A viagem começa quando ele decide seguir um caminho diferente.”
          </p>
          <div>
            <Sparkles size={20} aria-hidden />
            <p>Roteiro → sugestões de momentos → sua revisão</p>
          </div>
          <small>
            Conceito ilustrativo. Nenhum roteiro é enviado ou processado aqui.
          </small>
        </div>
      </section>

      <section
        className={`${styles.section} ${styles.plans}`}
        id="lancamento"
        aria-labelledby="planos-titulo"
      >
        <div className={styles.sectionIntro}>
          <div>
            <p className={styles.overline}>Um produto com próximos capítulos</p>
            <h2 id="planos-titulo">Conheça o que vem pela frente.</h2>
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
          Seu tempo é para criar.
          <br />
          <span>Encontre o trecho. Conte a história.</span>
        </h2>
        <p>
          Conheça um fluxo mais direto para preparar o material do seu próximo
          vídeo.
        </p>
        <a
          href="#demonstracao"
          className={styles.primary}
          data-cortes-cta="footer"
        >
          Explorar a demonstração <ArrowUpRight size={18} aria-hidden />
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
