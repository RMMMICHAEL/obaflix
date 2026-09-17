# Obaflix Android TV

> Ponto de entrada para desenvolvedores do modulo `android/tv`.

Handoff principal:

[`../../docs/android-tv-final.md`](../../docs/android-tv-final.md)

Arquitetura de foco:

[`../../docs/tv-navegacao-foco.md`](../../docs/tv-navegacao-foco.md)

## Baseline homologada

- branch: `feat/tv-planos-promocao`;
- PR: `#27`;
- commit de codigo: `a6bdff5`;
- versionName base: `0.7.26`;
- versionCode: `42`;
- homologacao: `0.7.26-homologacao`;
- package: `com.obaflix.tv.homologacao`;
- Activity: `com.obaflix.tv.MainActivity`.

APK homologado:

`build/outputs/apk/homologacao/tv-homologacao.apk`

SHA-256 daquele binario:

`27E084134B4EE51F505F4D3D5AECB5B6293C8BECD45288AECAA6661DEF1D3C3A`

Esse SHA identifica apenas aquele build. Homologado em TV fisica (anuncio,
QR direto ao checkout e `CONTINUAR GRÁTIS` aprovados, sem crash). Baseline
historica anterior: `b9a58e0`. Ver `docs/android-tv-final.md`.

## Foco

- Home em `LazyColumn`;
- fileiras em `LazyRow`;
- `Modifier.focusGroup()`;
- busca 2D padrao do Compose.

Nao reintroduzir workaround de entrada forcada no primeiro card sem regressao reproduzivel.

D-pad vertical mantendo a posicao horizontal entre fileiras e observacao de UX
aceita, nao bloqueante. Nao reintroduzir `focusProperties.enter` (congelou o
D-pad em TV fisica na 0.7.27).

## Build de homologacao

`gradlew :tv:assembleHomologacao -Pobaflix.urlTeste=https://<ambiente-isolado>`

A assinatura usa `android/key.properties`, fora do Git.

Nunca commitar credenciais ou secrets.

## Regra de retomada

Se houver duvida sobre a referencia correta, compare primeiro com:

`a6bdff5`

e leia `docs/android-tv-final.md`.
