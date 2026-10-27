# OBAFLIX — CONTRATO DE HOMOLOGAÇÃO E PREVENÇÃO DE REGRESSÕES

**Registro inicial:** 27/10/2026\
**Escopo:** Obaflix Cortes para Windows, player web/Electron, legendas automáticas, Gemini, assinatura e distribuição.\
**Objetivo:** manter decisões, riscos, evidências e testes vinculados ao código; permitir que Claude, Codex, Gemini e outras IAs continuem o trabalho sem refazer, apagar ou desabilitar funcionalidades homologadas.

## 1. Regras obrigatórias para toda IA ou programador

1. **Antes de alterar:** ler `AGENTS.md`, `CLAUDE.md`, `docs/CONTRATOS_CRITICOS.md`, este arquivo e os testes relacionados aos arquivos que pretende tocar. A implementação da `main` e o estado real de Production prevalecem sobre documentos históricos desatualizados.
2. **Não presumir que funcionalidade não visível foi removida.** Conferir plano/entitlements, feature flags, sessão, API, disponibilidade de serviço, cache, legenda e UI separadamente.
3. **Nunca remover, reescrever, desativar ou alterar silenciosamente uma funcionalidade homologada.** Se a mudança inevitavelmente impactar outra área, informar: arquivo, fluxo afetado, impacto provável, teste de regressão e plano de reversão **antes** da alteração.
4. **Menor mudança possível.** Preservar componentes, integrações e contratos existentes; não reconstruir Electron, APK/AAB ou infraestrutura sem necessidade comprovada. Testes proporcionais à mudança e `npm run test:web` quando afetar contratos críticos.
5. **Não fazer push na `main`, merge, deploy, edição de variáveis Production, alterações no banco ou pagamentos reais sem autorização explícita do proprietário.** Branch/PR isolada para alterações. Nunca usar `git add -A` sem conferir a árvore.
6. **Sem secrets em código, documentação, diffs, logs ou respostas.** Registrar nomes das variáveis e evidências não sensíveis, jamais seus valores. Rever autorização, SSRF, custos e limites.
7. **Cada PR que mudar fluxo homologado deve atualizar o registro de alterações e indicar:** funcionalidade, antes/depois, arquivos impactados, riscos para outras plataformas/planos, testes, estado da publicação e rollback. Não declarar PASS apenas porque o código compila ou o botão aparece.
8. **Prioridade comercial:** concluir lançamento de Start e Pro antes de iniciar funcionalidades secundárias. AI continua reservado para testes privados até validação técnica, custos e direitos de uso das legendas.

## 2. Baseline homologada — Windows Cortes

- Instalador Windows **1.0.16** publicado; FFmpeg 6.1.1 empacotado. Cortes individuais e vários trechos já homologados no Windows. A interface Electron consome o app web, portanto mudanças web não exigem automaticamente um novo EXE.
- **PR #89** integrado à `main` em 27/10/2026; merge `8d8ef19c9d8c3bb3666eb82d7df40b676c886c78`.
- **Evidência funcional do proprietário:** campo Cortes AI passou a aparecer corretamente para conta com assinatura apropriada no Windows 1.0.16. **Esta validação é da exibição/permissão, NÃO de uma análise real de legendas pelo Gemini.**
- Controle comercial global de cortes não deve ser ligado de forma indiscriminada; isso alteraria o comportamento de contas e cortes legados.
- A mesma conta de teste tinha assinatura tradicional `interno-maximo` e cortesia válida `cortes-ai`, sem alterar direitos de outras contas. Não criar nova cortesia automaticamente.

### Contrato de autorização/UI

- `src/components/player/CustomPlayer.tsx`: tela Vários trechos mostra campo AI e só habilita a operação para quem tem direito. Usa `nivelCortes === "ia"` **ou** assinatura Cortes AI retornada de `/api/billing/me` (consulta autenticada quando o editor de Vários trechos está aberto).
- `src/app/api/billing/me/route.ts`: informa assinatura Cortes vigente independentemente da assinatura tradicional. Não trocar identificação por nome público, role ou qualquer campo de cliente.
- `src/lib/entitlements.ts`: até uma assinatura vigente por família (tradicional e Cortes); coexistência soma `cortesNivel` sem apagar direitos tradicionais; cache e expiração permanecem válidos.
- `src/app/api/cortes/ia/route.ts`: API revalida sessão e direito efetivo `ia` **no servidor**; uma UI habilitada jamais substitui esse controle. Serviço e legendas podem recusar a análise separadamente.
- Testes de referência: `src/lib/__tests__/cortesAiInterface.test.ts`, `src/lib/__tests__/cortesAi.test.ts` e testes de entitlements/billing.

## 3. Contrato de legendas e IA — integração presente, não homologada ponta a ponta

**Estado em 27/10/2026:** backend contém a integração automática aprovada com addon OpenSubtitles PRO; manifesto do addon consultado externamente e disponível. Não foi possível demonstrar em sessão autenticada de Production a busca, leitura e análise de uma legenda real. Não declarar a feature 100% aprovada até esse teste.

- `src/lib/legendasAutomaticas.ts`: identificação do conteúdo pelo catálogo (IMDb/TMDB), busca da lista no addon, seleção de legendas com preferência por pt-BR/pt/en, até três tentativas de download, leitura e validação aproximada da duração. HTTPS, hosts restritos (`opensubtitlesv3-pro.dexter21767.com`, `opensubtitles.stremio.homes`), SSRF/redirecionamentos, teto de bytes e timeout protegidos.
- `src/lib/cortesAi.ts`: analisa **texto SRT/VTT**, não vídeo nem áudio; envia o texto permitido ao Gemini, valida falas, horários e duração, devolve sugestões ao editor. Não é serviço de transcrição de áudio ou garantia de geração de legendas inéditas. O addon pode fornecer legendas existentes ou versões traduzidas conforme sua disponibilidade/configuração.
- `src/app/api/cortes/ia/route.ts`: cliente envia conteúdo/episódio, duração e pedido; servidor procura legenda automaticamente se habilitado. Legenda fornecida pelo cliente só é aceita com hash autorizado; o modo automático também deve cumprir as condições de autorização de uso comercial e proteção de dados. Preservar controle diário/mensal de consumo.
- **Configuração de Production a conferir sem revelar valores:** `CORTES_AI_ATIVO=1`, `GEMINI_API_KEY` presente, `CORTES_AI_LEGENDAS_AUTOMATICAS=1`, `CORTES_AI_LEGENDAS_ADDON` com URL-base do addon (sem `/manifest.json`); também revisar `CORTES_AI_LIMITE_DIA` e `CORTES_AI_TETO_USD_MES`.
- A configuração do manifesto informado pelo proprietário prioriza `portuguese-br`, inclui a opção `aiTranslated=true` e `autoAdjustment=false`. Isto **não comprova** que o addon sempre fornecerá uma legenda nem que sincronizará com todas as versões de vídeo.
- Testes existentes: `src/lib/__tests__/legendasAutomaticas.test.ts`, `src/lib/__tests__/cortesAi.test.ts`; usam mocks e não substituem teste real do addon, configuração Vercel e Gemini.

### Teste de aceitação que falta (não usar conteúdo sem direitos)

Em uma conta interna Cortes AI, abrir filme/episódio de teste com legenda cujo uso esteja autorizado, acionar **Sugerir cortes**, verificar: busca de legenda real, formato SRT/VTT legível, resposta Gemini com cenas e horários, inserção no editor Vários trechos, possibilidade de revisar/exportar, custo/limites e ausência de impacto nos demais planos. Registrar resultado, data, fonte autorizada e erro categorizado sem salvar texto de legenda/segredos. Se não houver legendas para o título, registrar indisponibilidade, não atribuir automaticamente o erro ao Gemini.

## 4. Matriz mínima de impactos para revisão

| Mudança | Pode prejudicar | Conferir antes de aprovar |
|---|---|---|
| `CustomPlayer.tsx` | UI web/Electron, corte simples/lote/AI e permissões | Cortes individuais, lote, botão AI bloqueado/liberado corretamente |
| `playbackAuthorization.ts`, entitlements, planos, billing | Outras contas, anúncios, downloads, assinatura tradicional, Cortes | Cenários gratuito/Start/Pro/AI/interno; efeitos de flags globais |
| `legendasAutomaticas.ts`, `ssrf.ts` | Busca de legendas, redes permitidas, segurança, disponibilidade | IDs IMDb, temporadas, idiomas, redirects, limites e mocks existentes |
| `cortesAi.ts` e `/api/cortes/ia` | Custos Gemini, autorização, privacidade, qualidade do corte | Sessão, direitos, legenda autorizada, teto diário/mensal, falhas seguras |
| Flags/segredos Vercel | Usuários em Production, pagamentos, serviços externos | Ambiente exato, implantação, rollback; sem aplicar cegamente |
| `desktop/electron/` | Instalador homologado | Novo EXE somente quando comprovadamente necessário e autorizado |

## 5. Registro de mudanças / evidências

| Data | PR / commit | Área | O que foi validado | Estado / pendência |
|---|---|---|---|---|
| 27/10/2026 | PR #89 / `8d8ef19` | Cortes AI no Windows 1.0.16 | Proprietário confirma exibição do AI para conta com assinatura válida | **PASS somente UI/permissão; análise real pendente** |
| 27/10/2026 | Código da `main` | Addon/legendas | `legendasAutomaticas.ts`, rota IA e testes presentes; manifesto responde | **Integração em código confirmada; configuração Production e ponta a ponta não confirmados** |

**Modelo obrigatório para próximas entradas:** data, PR/commit/ambiente, funcionalidade, comportamento anterior e novo, arquivos, impactos/risco, evidências de teste, status (PASS PARCIAL/FALHA/PASS), rollback e autorização para Production.

## 6. Referências e documentação histórica

- `AGENTS.md` e `CLAUDE.md` — instruções a agentes. **A orientação antiga do `CLAUDE.md` para push automático em `main` e builds automáticas conflita com o gate de autorização do `AGENTS.md` e deve ser corrigida.**
- `docs/CONTRATOS_CRITICOS.md` — contratos críticos; adicionar referência a este documento na próxima alteração documental.
- `docs/cortes-lancamento.md`, `docs/cortes-planos-comerciais.md` — documentos históricos: algumas frases antigas de "não implementado" foram superadas pelo código atual. Nunca usá-los para concluir que a IA foi removida.

**Princípio de encerramento:** funcionalidade nova só muda para **PASS integral** depois de evidência real e testes; flags, contratos e usuários existentes devem permanecer protegidos. Todo trabalho deve preservar o caminho mais curto até a validação comercial do Obaflix Cortes.
