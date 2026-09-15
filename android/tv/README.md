# Obaflix Android TV

> Ponto de entrada para desenvolvedores do modulo `android/tv`.

Handoff principal:

[`../../docs/android-tv-final.md`](../../docs/android-tv-final.md)

Arquitetura de foco:

[`../../docs/tv-navegacao-foco.md`](../../docs/tv-navegacao-foco.md)

## Baseline homologada

- branch: `feat/tv-planos-promocao`;
- PR: `#27`;
- commit de codigo: `846d4bf0dee2`;
- versionName base: `0.7.25`;
- versionCode: `41`;
- homologacao: `0.7.25-homologacao`;
- package: `com.obaflix.tv.homologacao`;
- Activity: `com.obaflix.tv.MainActivity`.

APK homologado:

`build/outputs/apk/homologacao/tv-homologacao.apk`

SHA-256 daquele binario:

`423795074125a1a308d418a53ccfcae71cb235f3d4aa51df95314c3b686e1035`

Esse SHA identifica apenas aquele build.

## Foco

- Home em `LazyColumn`;
- fileiras em `LazyRow`;
- `Modifier.focusGroup()`;
- busca 2D padrao do Compose.

Nao reintroduzir workaround de entrada forcada no primeiro card sem regressao reproduzivel.

## Build de homologacao

`gradlew :tv:assembleHomologacao -Pobaflix.urlTeste=https://<ambiente-isolado>`

A assinatura usa `android/key.properties`, fora do Git.

Nunca commitar credenciais ou secrets.

## Regra de retomada

Se houver duvida sobre a referencia correta, compare primeiro com:

`846d4bf0dee2`

e leia `docs/android-tv-final.md`.
