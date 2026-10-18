# Landing page Obaflix Cortes

## Escopo

Rota pública `/cortes` com identidade Obaflix, layout responsivo e demonstração interativa. O HTML comercial é server component; apenas a demonstração usa estado no cliente. Nenhuma dependência adicionada. A navbar existente é ocultada pelo marcador `data-obaflix-landing`, já usado nas outras landings. Nenhuma alteração em layout, autenticação, cobrança, assinaturas ou aplicativos.

O roteamento público recebe `/cortes`, preservando os limites de prefixo da allowlist. O sitemap anuncia a página independentemente da flag de indexação do catálogo. Metadados, canonical, FAQ JSON-LD e imagem PNG original estática são específicos do Cortes.

## Fidelidade ao produto

Inspeção inicial no commit bd5e0c9, com a branch depois atualizada sobre a main 7fae35b:

- `src/components/player/CustomPlayer.tsx`: seleção de início/fim, alças na barra, duração, prévia que para no fim e `iniciarDownload("trecho")`.
- `desktop/electron/media-download.js`: preparação do arquivo, dependências de fonte/formato e necessidade de FFmpeg em alguns caminhos. Não prometer precisão universal ou exportação de qualquer fonte.
- `desktop/electron/main.js`: download com progresso e localização do arquivo salvo.
- Não foi encontrada seleção de vários intervalos, fila de cortes ou exportação em lote. A copy explica que vários arquivos são preparados repetindo exportações individuais.
- IA com roteiro e painel de cortes é visão futura, identificada como em desenvolvimento e indisponível, sem data.

A cena de montanhas é uma ilustração vetorial original, não captura do aplicativo. A demonstração é explicitamente ilustrativa. A timeline representa um editor externo; não existe integração automática com editores. Nenhum frame de filme, marca de terceiros, depoimento ou estatística inventada.

## Conversão e futuras integrações

Não foi encontrado mecanismo de captação de interessados no código existente. A página não cria formulário, coleta ou checkout. CTAs levam à demonstração e à apresentação das modalidades. Para ativar conversão comercial, ainda é necessário:

1. Definir e integrar um canal real de interessados, com consentimento, política de dados e tratamento de sucesso/erro.
2. Definir preços, franquias, direitos e diferenças entre Start, Pro e AI.
3. Criar checkout e distribuição específicos do Cortes, sem reutilizar implicitamente a assinatura tradicional.
4. Produzir demonstração gravada do app com material autorizado. A ilustração atual explica o fluxo sem simular processamento real.
5. Entregar e validar múltiplos cortes e IA antes de anunciá-los como disponíveis.

## Testes A/B e VSL

O elemento raiz contém `data-cortes-variant="demo"`. CTAs usam `data-cortes-cta="header|hero|footer"`. São pontos de integração, sem analytics, cookies, sorteio de variantes ou requisições adicionadas. Uma futura variante VSL pode substituir o bloco da demonstração, preservando seções e âncoras, após receber vídeo, legenda, transcrição e estratégia de consentimento/medição. Não existe vídeo ou variante B funcional neste PR.

## Segurança e consumo

Revisão explícita: nenhuma credencial, domínio de mídia, token ou URL interna introduzida. Nenhuma API, chamada externa, entrada de usuário, armazenamento ou coleta adicionada. JSON-LD reutiliza `JsonLd`, com escape de `<`. CTAs são âncoras internas. Não há mudanças nos gates de sessão ou autorização. Sem consulta adicional ao Supabase e sem polling. O layout raiz da main força renderização dinâmica, preservada neste PR; o PNG de compartilhamento é servido como arquivo estático.

A configuração `git.deploymentEnabled` desliga deploy automático somente para `codex/obaflix-cortes`, conforme https://vercel.com/docs/project-configuration/git-configuration. Nenhuma alteração às regras de outras branches, nenhum merge ou deploy manual.

## Validação

Validação local: 21 testes de roteamento e SEO aprovados; lint completo sem erros, com avisos preexistentes fora dos arquivos novos; TypeScript sem erros. Navegador: HTTP 200, título e canonical específicos, um H1, CTAs internos, três etapas da demonstração, operação por Enter, FAQ expansível e console sem erros. Layout revisado em desktop, 390 px e 320 px, sem rolagem horizontal. `npm run build` aprovado, incluindo Prisma generate, compilação, checagem de tipos e pré-renderização. `/cortes` tem 3,9 kB de JavaScript específico e 91,3 kB de primeiro carregamento no relatório do build; permanece dinâmica por herdar `force-dynamic` do layout raiz.

O compartilhamento usa um PNG original estático de 1200 × 630, sem dependência de renderização dinâmica ou custo de geração em runtime.

## Arquivos do PR

- `src/app/cortes/page.tsx`: conteúdo, estrutura, metadados e FAQ JSON-LD.
- `src/app/cortes/CortesDemo.tsx`: demonstração interativa em três etapas.
- `src/app/cortes/cortes.module.css`: estilos isolados e responsividade.
- `src/app/cortes/PRODUCT.md`: contexto de produto e direção visual desta rota.
- `public/cortes/social.png`: imagem original de compartilhamento.
- `src/config/site-mode.ts`: allowlist da apresentação pública.
- `src/app/sitemap/[shard]/route.ts`: URL da landing no sitemap.
- `src/lib/__tests__/siteModeCortes.test.ts`: regressão de roteamento.
- `vercel.json` e `ads-site/vercel.json`: deploy automático desativado somente para a branch de revisão, nos dois projetos conectados.
- `docs/landing-obaflix-cortes.md`: escopo, evidências e próximas integrações.

O projeto separado obaflix-ads disparou um preview automaticamente no primeiro push, pois usa ads-site/vercel.json. A mesma restrição de branch foi aplicada também ali. Nenhuma alteração de produção foi promovida.
