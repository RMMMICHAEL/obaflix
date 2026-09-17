# Android TV - baseline final

> Documento canonico para retomar qualquer trabalho na Android TV.
> Antes de alterar o modulo `android/tv`, leia tambem `docs/tv-navegacao-foco.md`.

## Status

Atualizado em 2026-09-16.

Isto define a baseline de codigo e comportamento para futuras comparacoes.
Isto nao significa publicacao em Production nem autorizacao automatica de merge.

- branch: `feat/tv-planos-promocao`;
- PR: `#27` (`https://github.com/RMMMICHAEL/obaflix/pull/27`), aberto;
- commit de codigo final: `a6bdff592b63f139b5b0c5274c2cd39fb622950c` (`a6bdff5`);
- versao: `0.7.26` (versionCode `42`);
- merge: nao realizado;
- Production: nao alterada.

Commits posteriores exclusivamente de documentacao podem mover o HEAD da branch.
Para identificar o codigo que gerou o APK final, use sempre `a6bdff5`.

### Situacao da validacao

| Baseline | Codigo | APK SHA-256 | Validacao |
|---|---|---|---|
| `0.7.25` (41) | `846d4bf0dee2` | `423795074125a1a308d418a53ccfcae71cb235f3d4aa51df95314c3b686e1035` | emulador; crash em Perfil — **substituida** |
| `0.7.25` (41) | `b9a58e0e34f1` | `BA86293F37D7788E8E6488EF58E51A0089B6A2CFC6FE0693492F4275D95B1996` | emulador e **TV fisica aprovadas** — **substituida** |
| **`0.7.26` (42)** | **`a6bdff5`** | **`27E084134B4EE51F505F4D3D5AECB5B6293C8BECD45288AECAA6661DEF1D3C3A`** | JVM e build OK; anuncio validado no emulador; **TV fisica deste APK pendente** |

`b9a58e0` foi a ultima baseline aprovada em TV fisica. `a6bdff5` a substitui com o
anuncio institucional e o checkout direto; o resto do comportamento e o mesmo.
O QR direto ao checkout e o APK `27E0…` ainda precisam do roteiro de TV fisica
abaixo antes de serem chamados de homologados em aparelho.

## Onde fica a Android TV

`android/tv/`

Pontos principais:

- configuracao e versao: `android/tv/build.gradle`;
- Activity: `android/tv/src/main/java/com/obaflix/tv/MainActivity.kt`;
- componentes da Home: `android/tv/src/main/java/com/obaflix/tv/ui/componentes/`;
- fileiras homologadas: `android/tv/src/main/java/com/obaflix/tv/ui/componentes/Fileiras.kt`;
- testes das fileiras: `android/tv/src/test/java/com/obaflix/tv/ui/componentes/FileirasTest.kt`;
- gate de reproducao: `android/tv/src/main/java/com/obaflix/tv/ui/PortaoDeReproducao.kt`;
- maquina de etapas: `android/tv/src/main/java/com/obaflix/tv/player/AutorizacaoTv.kt`;
- escolha final do anuncio: `player/EscolhaDoAnuncio.kt` e `ui/EscolhaFinalDoAnuncio.kt`;
- link do QR: `android/tv/src/main/java/com/obaflix/tv/assinatura/LinkDeAssinatura.kt`;
- arquitetura de foco: `docs/tv-navegacao-foco.md`;
- backlog posterior: `docs/backlog-produto.md`;
- indice geral: `docs/README.md`;
- versoes e artefatos: `docs/versoes.md`.

## Identidade da baseline final

- versionName base: `0.7.26`;
- versionCode: `42`;
- build type: `homologacao`;
- versionName efetivo: `0.7.26-homologacao`;
- pacote de homologacao: `com.obaflix.tv.homologacao`;
- pacote de release: `com.obaflix.tv`;
- Activity: `com.obaflix.tv.MainActivity`.

A baseline nao deve ser confundida com uma release publica.

## APK final

Saida do Gradle:

`android/tv/build/outputs/apk/homologacao/tv-homologacao.apk`

SHA-256:

`27E084134B4EE51F505F4D3D5AECB5B6293C8BECD45288AECAA6661DEF1D3C3A`

Esse SHA identifica somente este binario e nao deve ser usado como constante futura.
Pacote e versao conferidos no proprio APK com `aapt dump badging`.

## Ambiente de homologacao

URL isolada usada nesta rodada:

`https://obaflix-git-feat-tv-planos-promocao-michaeltrader.vercel.app`

Essa URL nao e Production.

O build exige:

`-Pobaflix.urlTeste=https://<ambiente-isolado>`

O Gradle bloqueia URL ausente, URL sem HTTPS e uso da URL de Production.

Resultado detalhado do ambiente:

`docs/ambiente-teste-resultado.md`

### Configuracao de servidor para o anuncio

Sem estas variaveis o servidor responde `ANUNCIO_INDISPONIVEL` e a TV mostra
"Reproducao gratuita indisponivel agora" — o anuncio nao aparece:

- `PROMOCAO_TV_VIDEO_URL` = `https://app.obaflix.online/anuncio.mp4`;
- `PROMOCAO_TV_DURACAO_SEG` = `10` ou `11` (o video tem 11,24 s; o servidor
  aceita no minimo 10 e recusa a conclusao se a duracao configurada passar do video).

A URL do video mora so no servidor; o APK nao a contem.

## Assinatura

O modulo TV le `rootProject.file("key.properties")`.

Como o root Gradle e `android/`, isso corresponde a:

`android/key.properties`

Esse arquivo e sensivel e nao deve ser commitado.

Nunca documentar nem commitar senhas, conteudo da chave ou credenciais privadas.

O APK de homologacao deve sair com certificado permitido pelo `AppIntegrity`.

## Validacao JVM

Comando de referencia:

`gradlew :core-extractor:testDebugUnitTest :tv:testDebugUnitTest :tv:testHomologacaoUnitTest -Pobaflix.urlTeste=https://obaflix-git-feat-tv-planos-promocao-michaeltrader.vercel.app`

Resultado em `a6bdff5`:

- `core-extractor`: OK;
- `tv:testDebugUnitTest`: 126/126;
- `tv:testHomologacaoUnitTest`: 130/130.

## Build de homologacao

`gradlew :tv:assembleHomologacao -Pobaflix.urlTeste=https://obaflix-git-feat-tv-planos-promocao-michaeltrader.vercel.app`

Validado em `a6bdff5`:

- package `com.obaflix.tv.homologacao`;
- versionCode `42`;
- versionName `0.7.26-homologacao`;
- assinatura OK.

## Anuncio institucional (conta gratuita)

Commits `d7b989f` e `7841204`.

- todo inicio de filme ou episodio de conta gratuita (inclusive episodio
  iniciado manualmente) abre o video direto; assinante vai direto ao player;
- o convite anterior ao video ("Assistir gratuitamente") foi removido;
- video sem seek, sem avanco e sem controles;
- `STATE_ENDED` real nao libera: o ultimo quadro fica congelado (player parado
  + poster do mesmo quadro, `res/drawable-nodpi/anuncio_escolha_final.jpg`) e
  aparece a escolha final;
- quatro areas focaveis: Basico, Plus, Premium e `CONTINUAR GRÁTIS`;
- foco inicial em Basico; RIGHT/LEFT entre planos (param nas pontas); DOWN de
  qualquer plano para `CONTINUAR GRÁTIS`; UP volta ao ultimo plano focado ou
  Basico; destinos explicitos em `focusProperties` left/right/up/down, **sem `enter`**;
- OK num plano abre `TelaAssinarForaDaTv` do plano da vitrine de
  `/api/billing/plans`, com QR para
  `/checkout?planoId=<plano.id>&planoPrecoId=<plano.precoDeEntrada.id>`;
  sem catalogo ou sem preco ativo, abre a tela Planos com o card destacado;
- abrir o QR nao conclui o anuncio nem libera o conteudo; BACK do QR volta a
  escolha final do mesmo desafio, sem repetir o video;
- `CONTINUAR GRÁTIS` e o unico caminho que chama `/api/ads/complete`; so a
  concessao do servidor abre o player;
- BACK durante o video ou na escolha final cancela a tentativa e sai.

O fluxo normal `Planos → plano → QR` continua em `/planos?plano=<id>`.

Observacao comercial: o poster embutido reproduz a arte do video, com os precos
desenhados. Trocar preco exige trocar video e poster e gerar APK novo.

## Arquitetura de foco aprovada

A Home usa busca de foco 2D padrao do Jetpack Compose.

- `LazyColumn` na Home;
- `LazyRow` nas fileiras;
- `Modifier.focusGroup()`;
- fileiras vazias ignoradas;
- sem override global de DOWN para conduzir a navegacao vertical.

Nao reintroduzir sem regressao real e reproduzivel:

- `focusProperties.enter`;
- `FocusRequester` especial para primeiro card;
- `scrollToItem(0)` ao sair da fileira;
- bridge global de UP/DOWN;
- troca da `LazyColumn` por workaround de foco.

Referencia historica conhecida como boa:

- TV `0.7.28`;
- commit `1ab5e48`.

Historico da regressao:

- `f8182b7`: introduziu entrada forcada pelo primeiro card;
- `543702d`: removeu `focusProperties.enter`.

### Observacao de UX aceita: D-pad vertical

Ao descer ou subir entre fileiras, o foco mantem aproximadamente a posicao
horizontal da fileira anterior, em vez de entrar no primeiro item. E o
comportamento da busca 2D padrao e foi aceito como **nao bloqueante**.

**Nao reintroduzir `focusProperties.enter`** para corrigir isso: a tentativa da
versao 0.7.27 congelava o D-pad de forma reproduzivel em TV fisica.

## Homologacao em TV fisica de `b9a58e0` (APK `BA86…1996`)

Aprovado, sem crash:

- atualizacao sobre instalacao existente preservou o login; Home autenticada;
- Perfil e Planos abriram;
- force stop + reabertura e reboot voltaram logados;
- perda temporaria de internet nao apagou credencial nem enviou ao pareamento;
  Home em cache visivel, dados de API indisponiveis; tudo voltou com a rede;
- logout foi ao pareamento e permaneceu la apos reabrir e reboot; novo login OK;
- detalhe abriu; Assistir mostrou "Reproducao gratuita indisponivel agora",
  conforme o ambiente de homologacao.

## Roteiro pendente para `a6bdff5` (APK `27E0…3C3A`)

1. instalar por cima de `b9a58e0` (versionCode 41 → 42) e confirmar login preservado;
2. repetir o roteiro de TV fisica acima;
3. com as variaveis do anuncio configuradas no ambiente isolado, conta gratuita:
   filme e episodio abrem o video; fim para na escolha final com foco em Basico;
4. conferir o alinhamento das bordas de foco sobre os tres cards;
5. OK em Basico, Plus e Premium: QR abre o checkout do plano certo no celular;
   BACK volta a escolha final sem repetir o video;
6. `CONTINUAR GRÁTIS` libera o conteudo;
7. conta assinante: sem anuncio.

## Commits finais de codigo

- `d7b989f` - `feat(tv): anuncio institucional com escolha final antes de filme e episodio`;
- `7841204` - `feat(tv): plano da escolha final do anuncio abre QR direto ao checkout`;
- `a6bdff5` - `chore(tv): versao 0.7.26 (versionCode 42)`.

Anteriores: `b9a58e0` (crash em Perfil), `846d4bf0dee2` (navegacao entre fileiras).

## Como retomar o desenvolvimento

1. ler `docs/android-tv-final.md`;
2. ler `docs/tv-navegacao-foco.md`;
3. conferir `android/tv/README.md`;
4. localizar a branch `feat/tv-planos-promocao`;
5. localizar o PR `#27`;
6. usar `a6bdff5` como baseline de codigo;
7. reproduzir o smoke antes de alterar foco;
8. repetir JVM, build, assinatura e smoke depois da mudanca.

## Este handoff nao autoriza

- merge;
- publicacao;
- Production;
- migration;
- alteracao de preco;
- alteracao de banco;
- alteracao de Redis;
- alteracao de flags comerciais;
- exposicao de secrets.

Essas decisoes continuam separadas da homologacao tecnica da Android TV.
