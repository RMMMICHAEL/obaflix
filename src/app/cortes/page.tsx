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
import { INSTALADORES } from "@/config/downloads";
import { PlanosCortes } from "./PlanosCortes";
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
    "O fluxo de recorte existe no aplicativo desktop para Windows e exige instalação. Esta página pode ser consultada no celular, mas não é um editor online. Depois da compra, entre no aplicativo com o e-mail da compra e a senha criada pelo link de ativação.",
  ],
  [
    "Posso preparar vários cortes?",
    "No Start, você prepara um trecho de cada vez e repete o processo para os próximos. No Pro, também pode montar uma lista de cenas e baixar todas de uma vez (lote), na versão Windows com Cortes.",
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
    "O Start libera o trecho individual. O Pro libera o trecho individual e o lote. O AI está em desenvolvimento e não é vendido. O Cortes é uma assinatura própria: soma ao Básico, Plus ou Premium e não cancela o plano que você já tem.",
  ],
  [
    "A inteligência artificial já está disponível?",
    "Ainda não. Receber um roteiro, sugerir momentos e preencher um painel de cortes é uma visão em desenvolvimento. Não há data de lançamento confirmada nem contratação da IA nesta página.",
  ],
  [
    "Como contrato? Preciso criar conta antes?",
    "Escolha Start ou Pro nesta página e pague com Pix; não é preciso criar conta antes. Depois da confirmação do pagamento, você recebe por e-mail o link para criar sua senha. Se o e-mail já tem conta no Obaflix, o plano é adicionado a ela. Enquanto um plano não tiver preço publicado, ele aparece como “em breve”.",
  ],
  [
    "A renovação é automática?",
    "Não. O Pix paga o período escolhido. Para continuar, renove em Minha conta antes do fim do período.",
  ],
  [
    "O que acontece com o meu CPF?",
    "O CPF é exigido pelo meio de pagamento e usado só para gerar o Pix. O Obaflix não o guarda.",
  ],
];

const instalador = INSTALADORES.windowsCortes;

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
          <a href="#lancamento">Planos</a>
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
            Compra por Pix, sem cadastro prévio
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
          No Cortes Pro, também é possível montar uma lista de cenas e baixar
          todas de uma vez (lote), na versão Windows com Cortes. Sugestão de cenas por IA ainda não existe. A
          exportação depende da fonte e dos componentes disponíveis no
          aplicativo.
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
            <p className={styles.overline}>Uma assinatura própria</p>
            <h2 id="planos-titulo">Escolha seu plano Cortes.</h2>
          </div>
          <p>
            Pagamento por Pix. Depois da confirmação, o acesso chega por e-mail.
            O valor final é confirmado no checkout.
          </p>
        </div>
        <PlanosCortes />
        <p className={styles.note}>
          O Cortes soma ao seu plano Básico, Plus ou Premium e não o cancela.
          Esta página não vende os planos tradicionais do Obaflix. Sem renovação
          automática; compra a partir de 18 anos.
        </p>
      </section>

      <section
        className={styles.section}
        id="instalar"
        aria-labelledby="acesso-titulo"
      >
        <div className={styles.sectionIntro}>
          <div>
            <p className={styles.overline}>Depois da compra</p>
            <h2 id="acesso-titulo">Do Pix ao primeiro corte.</h2>
          </div>
          <p>
            O acesso é entregue por e-mail e usado no aplicativo para Windows.
          </p>
        </div>
        <ol className={styles.flowSteps}>
          <li><span>01 / PAGAMENTO</span><h3>Pague com Pix.</h3><p>Leia o QR Code ou use o Pix Copia e Cola. Não precisa ficar na página esperando.</p></li>
          <li><span>02 / E-MAIL</span><h3>Crie sua senha.</h3><p>Confirmado o pagamento, enviamos um link de uso único para criar a senha. Se o e-mail já tem conta, use a senha atual.</p></li>
          <li><span>03 / INSTALAÇÃO</span><h3>Instale o app Windows.</h3><p>Baixe o instalador, siga a instalação e abra o Obaflix.</p></li>
          <li><span>04 / NO PLAYER</span><h3>Entre e corte.</h3><p>Entre com o e-mail da compra. No download do filme ou episódio, escolha o trecho.</p></li>
        </ol>
        <div className={styles.actions}>
          {instalador.url ? (
            <a href={instalador.url} rel="noopener nofollow" className={styles.primary} data-cortes-cta="instalador">
              Baixar para Windows <ArrowDown size={18} aria-hidden />
            </a>
          ) : (
            <span className={styles.availability}>
              <Monitor size={15} aria-hidden /> Instalador com Cortes em preparação.
            </span>
          )}
        </div>
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
          href="#lancamento"
          className={styles.primary}
          data-cortes-cta="footer"
        >
          Ver os planos Cortes <ArrowUpRight size={18} aria-hidden />
        </a>
        <small>
          Compra por Pix. O acesso chega por e-mail após a confirmação.
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
