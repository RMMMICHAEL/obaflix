import type { Metadata } from "next";

const title = "Termos de Serviço";
const description = "Proposta de termos sobre o website, os aplicativos e os downloads do Obaflix, pendente de identificação do responsável e revisão jurídica.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/termos" },
  robots: { index: false, follow: true },
  openGraph: { title, description, url: "/termos", type: "website" },
};

export default function TermsPage() {
  return (
    <article aria-labelledby="termos-titulo" className="mx-auto max-w-3xl px-5 pb-16 pt-24 text-base leading-7 text-zinc-300 sm:px-8">
      <h1 id="termos-titulo" className="text-3xl font-bold leading-tight text-white sm:text-4xl">
        Termos de Serviço do Obaflix
      </h1>
      <p className="mt-3 text-sm text-zinc-400">
        Proposta atualizada em <time dateTime="2026-10-11">11 de outubro de 2026</time>.
      </p>

      <section aria-labelledby="termos-status" className="mt-8 rounded-lg border border-zinc-700 bg-zinc-900 p-5">
        <h2 id="termos-status" className="text-xl font-semibold text-white">Documento em preparação</h2>
        <p className="mt-3">
          Esta é uma proposta para revisão. A identificação legal do responsável pelo
          Obaflix e o canal público de contato estão pendentes de validação. O texto
          ainda não foi aprovado juridicamente e não constitui uma EULA definitiva.
          Sua publicação como documento jurídico depende de aprovação explícita.
        </p>
      </section>

      <section aria-labelledby="termos-funcionamento" className="mt-8">
        <h2 id="termos-funcionamento" className="text-xl font-semibold text-white">1. Website e aplicativos</h2>
        <p className="mt-3">
          O website público apresenta informações do catálogo e links para obter os
          aplicativos Obaflix. A experiência de reprodução está nos aplicativos para
          Android, Android TV e Windows. As páginas públicas de catálogo não oferecem
          reprodução de filmes ou episódios no navegador.
        </p>
        <p className="mt-3">
          Recursos como favoritos, progresso, reprodução e download offline dependem
          do aplicativo, da versão, do dispositivo e da disponibilidade apresentada
          em cada funcionalidade. Nem toda versão ou conteúdo oferece os mesmos recursos.
        </p>
      </section>

      <section aria-labelledby="termos-downloads" className="mt-8">
        <h2 id="termos-downloads" className="text-xl font-semibold text-white">2. Downloads e instalação</h2>
        <p className="mt-3">
          Os links de instaladores apresentados pelo website levam ao domínio de
          downloads app.obaflix.online. Escolha o arquivo destinado ao seu dispositivo
          e confira a versão e as informações exibidas antes de baixar.
        </p>
        <p className="mt-3">
          O download é iniciado pelo link que você escolhe. Baixar um arquivo não
          equivale a consentir com sua instalação. Leia as informações e permissões
          apresentadas pelo sistema e mantenha as proteções de segurança do dispositivo.
        </p>
      </section>

      <section aria-labelledby="termos-conta" className="mt-8">
        <h2 id="termos-conta" className="text-xl font-semibold text-white">3. Acesso e conta</h2>
        <p className="mt-3">
          As informações públicas de catálogo podem ser consultadas sem login.
          Recursos de conta e reprodução podem exigir autenticação. As telas de acesso
          oferecem e-mail e senha ou Google, conforme a experiência disponível.
          Proteja suas credenciais e não informe sua senha a terceiros.
        </p>
      </section>

      <section aria-labelledby="termos-condicoes" className="mt-8">
        <h2 id="termos-condicoes" className="text-xl font-semibold text-white">4. Recursos, planos e limitações</h2>
        <p className="mt-3">
          As experiências dos aplicativos podem incluir publicidade e opções de plano.
          Antes de contratar, confira os recursos, o preço e as condições apresentados
          na oferta e no checkout. Esta proposta não acrescenta condições de pagamento,
          cancelamento ou reembolso.
        </p>
        <p className="mt-3">
          Conexão, compatibilidade do dispositivo e disponibilidade das fontes podem
          afetar os recursos oferecidos. Este texto não promete disponibilidade de
          um título específico, funcionamento sem interrupções ou reprodução em
          ambientes que não oferecem essa funcionalidade.
        </p>
      </section>

      <section aria-labelledby="termos-pendencias" className="mt-8">
        <h2 id="termos-pendencias" className="text-xl font-semibold text-white">5. Identificação e condições jurídicas pendentes</h2>
        <p className="mt-3">
          A versão definitiva precisa identificar o responsável pelo serviço e um canal
          público de contato validado. As condições de licença de uso do software e
          demais disposições jurídicas precisam de revisão e aprovação do responsável.
        </p>
        <p className="mt-3">
          Esta proposta não declara direitos de distribuição sobre obras, licenças de
          conteúdos, identidade de titulares ou práticas de tratamento de dados não
          verificadas. Informações de privacidade deverão ser tratadas em documento
          próprio, após validação, sem presumir consentimento por download ou navegação.
        </p>
      </section>

      <p className="mt-10">
        <a href="/" className="rounded-sm underline underline-offset-4 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
          Voltar ao website Obaflix
        </a>
      </p>
    </article>
  );
}
