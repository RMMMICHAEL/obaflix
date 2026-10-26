# Obaflix para Android

Aplicativo Android nativo do Obaflix (https://obaflixbr.com), construído em Kotlin Multiplatform e
Compose Multiplatform.

Baseado no [Nuvio Mobile](https://github.com/NuvioMedia/NuvioMobile) (NuvioMedia), com modificações
do Obaflix descritas em [NOTICE.md](./NOTICE.md). O Obaflix não é afiliado nem endossado pela NuvioMedia.

## Build

Requer Android Studio, Android SDK e JDK 17.

```bash
./gradlew :androidApp:assembleFullDebug        # APK de desenvolvimento
./gradlew :androidApp:bundlePlaystoreRelease   # AAB da Google Play
```

Código-fonte correspondente, propriedades de build e binários herdados: [docs/obaflix/CODIGO-FONTE.md](./docs/obaflix/CODIGO-FONTE.md).

## Licença

[GNU General Public License v3.0](./LICENSE). A licença cobre o código; a marca Obaflix não é licenciada.
