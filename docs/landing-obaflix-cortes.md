# Landing page Obaflix Cortes

## Escopo

Rota pública `/cortes` com identidade Obaflix, layout responsivo, fluxo estático em quatro etapas e espaço reservado para gravação real. Todo o conteúdo da landing é server component. Nenhuma dependência adicionada. A navbar existente é ocultada pelo marcador `data-obaflix-landing`, já usado nas outras landings. Nenhuma alteração em layout, autenticação, cobrança, assinaturas ou aplicativos.

O roteamento público recebe `/cortes`, preservando os limites de prefixo da allowlist. O sitemap anuncia a página independentemente da flag de indexação do catálogo. Metadados, canonical, FAQ JSON-LD e imagem PNG original estática são específicos do Cortes.

## Fidelidade ao produto

Inspeção inicial no commit bd5e0c9, com a branch depois atualizada sobre a main 7fae35b:

- `src/components/player/CustomPlayer.tsx`: seleção de início/fim, alças na barra, duração, prévia que para no fim e `iniciarDownload("trecho")`.
- `desktop/electron/media-download.js`: preparação do arquivo, dependências de fonte/formato e necessidade de FFmpeg em alguns caminhos. Não prometer precisão universal ou exportação de qualquer fonte.
- `desktop/electron/main.js`: download com progresso e localização do arquivo salvo.
- Não foi encontrada seleção de vários intervalos, fila de cortes ou exportação em lote. A copy explica que vários arquivos são preparados repetindo exportações individuais.
- IA com roteiro e painel de cortes é visão futura, identificada como em desenvolvimento e indisponível, sem data.

A ilustração de montanhas e a simulação interativa foram removidas na revisão comercial. O hero reserva uma moldura estável para a gravação real, explicitamente indisponível hoje, sem botão de reprodução fictício. O fluxo descreve a montagem no editor externo; não existe integração automática com editores. Nenhum frame de filme, marca de terceiros, depoimento ou estatística inventada.

## Conversão e futuras integrações

Não foi encontrado mecanismo de captação de interessados no código existente. A página não cria formulário, coleta ou checkout. CTAs levam à explicação dos quatro passos e à apresentação das modalidades. Para ativar conversão comercial, ainda é necessário:

1. Definir e integrar um canal real de interessados, com consentimento, política de dados e tratamento de sucesso/erro.
2. Definir preços, franquias, direitos e diferenças entre Start, Pro e AI.
3. Criar checkout e distribuição específicos do Cortes, sem reutilizar implicitamente a assinatura tradicional.
4. Produzir demonstração gravada do app com material autorizado. Adicionar arquivo real, legenda/transcrição e poster autorizado ao espaço reservado; não usar autoplay nem carregar vídeo completo antes da interação.
5. Entregar e validar múltiplos cortes e IA antes de anunciá-los como disponíveis.

## Testes A/B e VSL

O elemento raiz contém `data-cortes-variant="demo"`. CTAs usam `data-cortes-cta="header|hero|footer"`. São pontos de integração, sem analytics, cookies, sorteio de variantes ou requisições adicionadas. Uma futura variante VSL pode substituir o bloco da demonstração, preservando seções e âncoras, após receber vídeo, legenda, transcrição e estratégia de consentimento/medição. Não existe vídeo ou variante B funcional neste PR.

## Segurança e consumo

Revisão explícita: nenhuma credencial, domínio de mídia, token ou URL interna introduzida. Nenhuma API, chamada externa, entrada de usuário, armazenamento ou coleta adicionada. JSON-LD reutiliza `JsonLd`, com escape de `<`. CTAs são âncoras internas. Não há mudanças nos gates de sessão ou autorização. Sem consulta adicional ao Supabase e sem polling. O layout raiz da main força renderização dinâmica, preservada neste PR; o PNG de compartilhamento é servido como arquivo estático.

A configuração `git.deploymentEnabled` desliga deploy automático somente para `codex/obaflix-cortes`, conforme https://vercel.com/docs/project-configuration/git-configuration. Nenhuma alteração às regras de outras branches, nenhum merge ou deploy manual.

## Validação inicial (18/10/2026, anterior à revisão)

Validação local: 21 testes de roteamento e SEO aprovados; lint completo sem erros, com avisos preexistentes fora dos arquivos novos; TypeScript sem erros. Navegador: HTTP 200, título e canonical específicos, um H1, CTAs internos, três etapas da demonstração, operação por Enter, FAQ expansível e console sem erros. Layout revisado em desktop, 390 px e 320 px, sem rolagem horizontal. `npm run build` aprovado, incluindo Prisma generate, compilação, checagem de tipos e pré-renderização. `/cortes` tem 3,9 kB de JavaScript específico e 91,3 kB de primeiro carregamento no relatório do build; permanece dinâmica por herdar `force-dynamic` do layout raiz.

O compartilhamento usa um PNG original estático de 1200 × 630, sem dependência de renderização dinâmica ou custo de geração em runtime.

## Arquivos do PR

- `src/app/cortes/page.tsx`: conteúdo, estrutura, metadados e FAQ JSON-LD.
- `src/app/cortes/CortesDemo.tsx`: removido na revisão comercial, junto com os estilos sem uso da simulação.
- `src/app/cortes/cortes.module.css`: estilos isolados e responsividade.
- `src/app/cortes/PRODUCT.md`: contexto de produto e direção visual desta rota.
- `public/cortes/social.png`: imagem original de compartilhamento.
- `src/config/site-mode.ts`: allowlist da apresentação pública.
- `src/app/sitemap/[shard]/route.ts`: URL da landing no sitemap.
- `src/lib/__tests__/siteModeCortes.test.ts`: regressão de roteamento.
- `vercel.json` e `ads-site/vercel.json`: deploy automático desativado somente para a branch de revisão, nos dois projetos conectados.
- `docs/landing-obaflix-cortes.md`: escopo, evidências e próximas integrações.

O projeto separado obaflix-ads disparou um preview automaticamente no primeiro push, pois usa ads-site/vercel.json. A mesma restrição de branch foi aplicada também ali. O preview dpl_5wY5ceMTEAabbppRGcyZrdFGMcTC foi removido, com confirmação da CLI. Nenhuma alteração de produção foi promovida.


## Revisão comercial de 19/10/2026

Método: Vibe Coding Toolkit, revisão local `790a895304e0c08b70a5b215c9d334f1c86b816c`, com plano limitado à landing, inspeção do produto, gates existentes e revisão independente somente leitura. Usados guias de desempenho Next.js e adaptação nativa de avaliação do harness, sem instalar o framework Harness2, alterar modelo ou adicionar dependências. A aplicação permanece Next.js 14; não foi migrada para usar ferramentas que exigem versões novas. Impeccable orientou clareza, redução e preservação da identidade.

Aceite: headline solicitada; CTA visível no mobile; nenhuma captura/vídeo inventado; quatro etapas explícitas; exportação individual; IA secundária/futura; nenhuma compra simulada; sem mudança em runtime comercial, pagamentos, autenticação ou apps. Hero, espaçamento e seções condensados, removendo a explicação duplicada de problema/solução e o componente interativo. CSS sem uso da simulação também removido. Preservados cores, fontes, FAQ, recursos e modalidades previstas.

Revisão independente: fontes atuais inspecionadas por agente separado, sem achados acionáveis sobre comportamento, alegações ou segurança. O revisor não conseguiu comparar Git no sandbox dele; o diff e a integração são verificados pelo coordenador. Nenhuma medição de custo/economia de tokens inferida.

Segurança: links e conteúdo público revisados; nenhuma nova entrada, API, dado pessoal, mídia de terceiros ou credencial. Nenhum risco novo encontrado, sem mitigação adicional necessária. Zero consultas adicionais ao banco/Redis e nenhum polling.

A execução inicial do build encontrou EPERM na DLL do Prisma por causa do servidor local aberto; o servidor desta landing foi parado antes de repetir. A primeira checagem de tipos coincidiu com a remoção do componente e foi repetida após o diff estabilizar. A tentativa inicial de Lighthouse antes da revisão falhou com NO_NAVSTART: seus números de desempenho não são usados como baseline válido.


### Refinamento: assista e faça cortes ao mesmo tempo

Headline e metadados agora destacam a seleção durante a reprodução. A narração continua como ponto de partida do fluxo, sem repetir a proposta em várias seções. CTA principal explica como preparar um corte; CTA final leva ao mesmo fluxo, sem promessa de contratação. Catálogo apresentado como em constante atualização, sem garantia de periodicidade ou disponibilidade de títulos específicos. A frequência efetiva não foi medida em produção; a existência de rotinas de sincronização não comprova execução diária.

A alegação de não exigir download prévio do episódio completo foi conferida em `desktop/electron/media-download.js`: `selecionarSegmentos` filtra o intervalo, e o caminho FFmpeg usa `-ss`/`-to` antes da entrada. MP4 sem FFmpeg falha explicitamente em vez de baixar o arquivo inteiro como fallback. A FAQ preserva as condições de fonte, formato e FFmpeg; não se promete consumo exato de bytes nem compatibilidade universal. Nenhum comportamento do Electron foi alterado.

Demonstração: não há gravação real autorizada disponível no repositório. O espaço reservado tem dimensões estáveis e aviso visível; nenhuma captura ou vídeo foi fabricado. Antes de ativar a demonstração, adicionar uma gravação do fluxo real com material autorizado e acessibilidade (legendas/transcrição).

A revisão automática de aprovação interrompeu uma leitura final por limite de uso no turno anterior. O trabalho foi retomado a pedido do usuário; as mudanças estavam preservadas. Nenhuma política de acesso foi contornada.


### Validação final desta revisão

- 20 testes relevantes aprovados; `npm run lint`, `npx tsc --noEmit`, `npm run build` e `git diff --check` aprovados. Build inclui lint/tipos; avisos preexistentes fora da landing preservados.
- Revisão independente final, somente leitura: nenhum achado acionável sobre copy, fluxo, segurança, links ou acessibilidade estática. Limitação: frequência real do catálogo não consultada em produção.
- Navegador: CTA principal/final, FAQ por Enter, âncoras, H1 único, zero formulários/links externos dentro da landing e zero erros JS. 320/390/768/1440 px sem overflow. Capturas reais da página salvas em [evidências](landing-cortes-evidence/README.md).
- Lighthouse mobile: desempenho 90, acessibilidade 100, LCP 3,46 s, CLS 0, TBT 104 ms. Desktop: 100/100, LCP 0,73 s, CLS 0,00066, TBT 0 ms. Chrome 142 compatível; resultados com Chrome 155/NO_NAVSTART descartados.
- LCP mobile exige atenção; a principal oportunidade observada envolve CSS bloqueante da rota e compartilhado. Não houve mudança no layout global. INP de campo não medido; amostras locais de interação não substituem dados reais.
- JS específico / primeiro carregamento: 1,34 / 88,7 kB no build atual (anterior: 3,9 / 91,3 kB). Nenhuma biblioteca adicionada.

Apenas conteúdo/estilos/contexto desta landing, remoção da simulação e evidências foram alterados nesta revisão. Checkout, planos tradicionais, backend, autenticação, Electron e Android não foram modificados. PR existente para revisão, sem merge ou deploy. Página local: http://localhost:3218/cortes.
