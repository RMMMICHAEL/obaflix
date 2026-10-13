# Proposta de transparência legal dos downloads (fase 3A)

Base: `719115cd478d7adbfbfdf3bd0e282f143030f70f`, main atualizado.
Branch: `fix/seo-download-terms-transparency`.

## Estado jurídico e publicação

**IDENTIDADE_LEGAL_PENDENTE** e **REVISÃO_JURÍDICA_PENDENTE**.

Proposta técnica para revisão, sem aprovação jurídica ou autorização de publicação
em produção. Não representa conformidade concluída com Google Safe Browsing.
O alerta de páginas enganosas permanece sem causa comprovada.

Campos que dependem de informação pública validada pelo responsável:

- Identificação do responsável pelo serviço e pelo software.
- Canal oficial de contato autorizado para publicação.
- Condições de licença de uso do software e demais disposições jurídicas.
- Confirmação jurídica das condições comerciais que vierem a integrar o documento.

Nenhuma razão social, CNPJ, endereço, pessoa responsável, e-mail, licença de obras,
garantia, política de reembolso ou prática de dados foi inventada. Configuração de
contato existente não foi lida, alterada nem transferida da PR #65.

O texto da PR #65 foi consultado como referência. Não foram incorporados sua landing,
CSS, helper jurídico, variáveis, licença proposta, disposições de reembolso ou
procedimentos relativos a dados. `/privacidade` não foi criada, porque suas
afirmações exigem validação própria. `/baixar` continua fora deste trabalho.

## Mudanças e fundamento verificável

- `src/app/termos/page.tsx`: documento em português com status de proposta visível,
  sem banco, autenticação, formulário, scripts ou serviços adicionais. Canonical
  próprio e `noindex, follow` enquanto rascunho. Herda o layout existente sem mudá-lo.
- `src/config/site-mode.ts`: somente `/termos` e `/termos/` na lista exata pública;
  subrotas e prefixos parecidos não são liberados para o navegador.
- `SecaoDownloads.tsx`: um link HTML visível atende home, TikTok e catálogo público.
- `FichaSeoExtra.tsx`: link junto aos instaladores das fichas públicas.
- `CatalogAppModal.tsx`: link no próprio convite de instalação, na mesma aba.
- `downloadTerms.test.ts`: acesso sem sessão, limite da allowlist, isolamento admin,
  regressão de navegação, renderização do documento e links/destinos dos instaladores.

Fontes dos fatos do documento: `site-mode.ts` (navegador/apps), `downloads.ts`
(domínio de instaladores), página de login e fluxo de aquisição já auditados.
As diferenças de recursos por versão e ambiente foram confirmadas nas fases
anteriores; a proposta não promete download offline em todas as versões.

## Segurança e consumo

Não altera middleware, shell, autenticação, APIs, players, anúncios, pagamentos,
instaladores, configuração de downloads, sitemap ou robots. Nenhuma nova consulta
ao banco ou chamada de API é implementada. `/termos` herda o shell e o render
dinâmico existentes; não houve refactor de layout para torná-la estática.
Os links não contêm parâmetros, destinos externos, eventos, prefetch ou dados pessoais.

## Lacunas do software, fora do escopo

A busca direcionada na tela de perfil Android TV (`TelaPerfil.kt`) e na
configuração de empacotamento Electron não identificou acesso a Termos/EULA.
Isso não prova ausência em todas as telas ou versões instaladas. Android e
Electron usam também as fichas web compartilhadas; os novos links dessas fichas
não foram homologados em aplicativos instalados. Verificar o acesso no software
é tarefa posterior, sem alterar código nativo ou gerar instaladores nesta fase.

A assinatura Windows e a diferença de versões TV permanecem tarefas separadas.
Referência: https://www.google.com/about/unwanted-software-policy.html

## Validação e rollback

Validação local concluída:

- 30 testes direcionados aprovados, incluindo os oito testes novos.
- TypeScript: `tsc --noEmit --incremental false` aprovado.
- ESLint dos seis arquivos de código/teste alterados: aprovado, sem warnings.
- `next build`: aprovado; nove warnings preexistentes fora do diff.
- Smoke HTTP do build: `/termos` 200 sem sessão com UA desktop, mobile, Android
  e Electron; canonical `https://obaflixbr.com/termos`, title próprio e noindex.
- `/termos/` 308 apenas para `/termos`; prefixos/subrotas falsos voltam à landing.
  `/baixar`, `/privacidade` e rotas fechadas dos apps permanecem como antes.
- `/tiktok` responde 200 e contém o link HTML. Clique real em viewport 320px
  chega a `/termos`; documento sem overflow horizontal, com um h1 e seções rotuladas.
- Banco fictício local foi usado no build/smoke, sem credenciais de produção.
  Dependências existentes foram reutilizadas, sem regenerar Prisma.

O rollback é reverter apenas o commit desta proposta. Antes de merge/publicação,
obter os dados essenciais e a aprovação jurídica explícita, sem reaproveitar
automaticamente a PR #65.
