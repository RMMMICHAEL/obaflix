# Android TV - baseline final homologada

> Documento canonico para retomar qualquer trabalho na Android TV.
> Antes de alterar o modulo `android/tv`, leia tambem `docs/tv-navegacao-foco.md`.

## Status

A Android TV foi fechada e congelada nesta rodada de desenvolvimento e homologacao em 2026-09-15.

Isto define uma baseline aprovada de codigo e comportamento para futuras comparacoes.

Isto nao significa publicacao em Production nem autorizacao automatica de merge.

- branch: `feat/tv-planos-promocao`;
- PR: `#27`;
- URL: `https://github.com/RMMMICHAEL/obaflix/pull/27`;
- commit de codigo homologado: `846d4bf0dee25f9ec03b2184e05db9058d171d54`;
- commit curto: `846d4bf0dee2`;
- merge: nao realizado neste fechamento;
- Production: nao alterada nesta validacao.

Commits posteriores exclusivamente de documentacao podem mover o HEAD da branch.
Para identificar o codigo que gerou o APK homologado, use sempre `846d4bf0dee2`.

## Onde fica a Android TV

`android/tv/`

Pontos principais:

- configuracao e versao: `android/tv/build.gradle`;
- Activity: `android/tv/src/main/java/com/obaflix/tv/MainActivity.kt`;
- componentes da Home: `android/tv/src/main/java/com/obaflix/tv/ui/componentes/`;
- fileiras homologadas: `android/tv/src/main/java/com/obaflix/tv/ui/componentes/Fileiras.kt`;
- testes das fileiras: `android/tv/src/test/java/com/obaflix/tv/ui/componentes/FileirasTest.kt`;
- arquitetura de foco: `docs/tv-navegacao-foco.md`;
- backlog posterior: `docs/backlog-produto.md`;
- indice geral: `docs/README.md`;
- versoes e artefatos: `docs/versoes.md`.

## Identidade da baseline homologada

- versionName base: `0.7.25`;
- versionCode: `41`;
- build type: `homologacao`;
- versionName efetivo: `0.7.25-homologacao`;
- pacote de homologacao: `com.obaflix.tv.homologacao`;
- pacote de release: `com.obaflix.tv`;
- Activity: `com.obaflix.tv.MainActivity`.

A baseline homologada nao deve ser confundida com uma release publica.

## APK homologado

Saida do Gradle:

`android/tv/build/outputs/apk/homologacao/tv-homologacao.apk`

SHA-256 validado:

`423795074125a1a308d418a53ccfcae71cb235f3d4aa51df95314c3b686e1035`

Esse SHA identifica somente este binario e nao deve ser usado como constante futura.

No smoke final, o SHA local era exatamente igual ao SHA de `base.apk` instalado no emulador.

## Ambiente de homologacao

URL isolada usada nesta rodada:

`https://obaflix-git-feat-tv-planos-promocao-michaeltrader.vercel.app`

Essa URL nao e Production.

O build exige:

`-Pobaflix.urlTeste=https://<ambiente-isolado>`

O Gradle bloqueia URL ausente, URL sem HTTPS e uso da URL de Production.

Resultado detalhado do ambiente:

`docs/ambiente-teste-resultado.md`

## Assinatura

O modulo TV le `rootProject.file("key.properties")`.

Como o root Gradle e `android/`, isso corresponde a:

`android/key.properties`

Esse arquivo e sensivel e nao deve ser commitado.

Nunca documentar nem commitar senhas, conteudo da chave ou credenciais privadas.

O APK de homologacao deve sair com certificado permitido pelo `AppIntegrity`.

## Validacao JVM

Comando de referencia:

`gradlew :core-extractor:testDebugUnitTest :tv:testHomologacaoUnitTest -Pobaflix.urlTeste=https://obaflix-git-feat-tv-planos-promocao-michaeltrader.vercel.app`

Resultado:

- `core-extractor`: OK;
- `tv:testHomologacaoUnitTest`: OK.

## Build de homologacao

`gradlew :tv:assembleHomologacao -Pobaflix.urlTeste=https://obaflix-git-feat-tv-planos-promocao-michaeltrader.vercel.app`

Validado:

- package correto;
- versionCode `41`;
- versionName `0.7.25-homologacao`;
- assinatura OK;
- certificado permitido.

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

## Smoke de D-pad

- serial: `emulator-5554`;
- modelo: `AOSP TV on x86`.

Sequencia validada:

1. Home;
2. DOWN para destaque;
3. DOWN para fileiras;
4. RIGHT;
5. RIGHT;
6. DOWN;
7. LEFT;
8. UP.

Resultado:

`STATUS_SMOKE_DPAD=OK`

Tambem confirmado:

- PID estavel;
- foco nao caiu no `android.widget.FrameLayout` raiz;
- nenhuma `FATAL EXCEPTION`;
- captura de foco disponivel durante o smoke.

## Smoke funcional final

`STATUS_HOMOLOGACAO_LOCAL=OK`

Validacoes aprovadas:

- detalhe abriu;
- BACK do detalhe funcionou;
- Planos foi localizado por D-pad;
- tela de Planos abriu;
- BACK de Planos funcionou;
- detalhe para reproducao abriu;
- botao de reproducao foi localizado;
- gate observado: `GATE_DE_PLANO_OU_ASSINATURA`;
- PID inicial e final permaneceram iguais;
- nenhuma `FATAL EXCEPTION`.

Nao houve desinstalacao, limpeza de dados nem reinstalacao desnecessaria.

## Commit final de codigo

`846d4bf0dee2` - `fix(tv): restaura navegacao estavel entre fileiras`

Arquivos alterados naquele commit:

1. `android/tv/src/main/java/com/obaflix/tv/ui/componentes/Fileiras.kt`;
2. `android/tv/src/test/java/com/obaflix/tv/ui/componentes/FileirasTest.kt`;
3. `docs/backlog-produto.md`;
4. `docs/tv-navegacao-foco.md`.

Estatistica:

- 4 arquivos;
- 138 insercoes;
- 93 remocoes.

Para inspecionar:

`git show 846d4bf0dee2`

## Como retomar o desenvolvimento

1. ler `docs/android-tv-final.md`;
2. ler `docs/tv-navegacao-foco.md`;
3. conferir `android/tv/README.md`;
4. localizar a branch `feat/tv-planos-promocao`;
5. localizar o PR `#27`;
6. usar `846d4bf0dee2` como baseline de codigo homologada;
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
