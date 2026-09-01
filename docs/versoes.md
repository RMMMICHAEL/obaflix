# Versões e onde ficam os artefatos

Os três aplicativos nativos têm ciclos de versão **independentes**. Este
arquivo diz qual é a versão corrente de cada um, onde o número é declarado,
onde o build sai e onde a cópia distribuível é guardada.

Atualizado em **2026-08-31**.

## Versão corrente

| Aplicativo | Versão | Pacote / AppId | Onde o número é declarado |
|---|---|---|---|
| **Android TV** | `0.7.12` (versionCode 28) | `com.obaflix.tv` | [`android/tv/build.gradle`](../android/tv/build.gradle) |
| **Android celular** | `1.0.9` (versionCode 9) | `com.obaflix` | [`android/app/build.gradle`](../android/app/build.gradle) |
| **Desktop (Windows)** | `1.0.5` | `com.obaflix.app` | [`desktop/package.json`](../desktop/package.json) |

Os dois APK são pacotes diferentes: **instalam lado a lado**, um não substitui
o outro.

## Onde ficam os arquivos

| Aplicativo | Saída do build | Cópia distribuível |
|---|---|---|
| Android TV | `android/tv/build/outputs/apk/release/tv-release.apk` | `releases/Obaflix-TV-<versão>.apk` |
| Android celular | `android/app/build/outputs/apk/release/app-release.apk` | `releases/Obaflix-<versão>.apk` |
| Desktop | `desktop/dist/Obaflix Setup <versão>.exe` | o próprio `desktop/dist/` |

A pasta `releases/` guarda o histórico dos APK; o `desktop/dist/` guarda o dos
instaladores. Nenhuma das duas é publicada sozinha — a distribuição pública é
feita por **GitHub Releases**, manualmente.

## Como gerar

```bash
# Android TV
cd android && ./gradlew :tv:assembleRelease

# Android celular
cd android && ./gradlew :app:assembleRelease

# Desktop (Windows)
cd desktop && npm run build:win
```

Os dois APK saem assinados com o certificado de produção
(`CN=Obaflix, O=Obaflix, C=BR`, SHA-256 `bdf64ebf…`), que é o mesmo que o
`AppIntegrity` do `:core-extractor` espera. As credenciais vêm de
`android/keystore.properties`, que **não está no Git**. Sem esse arquivo o
build de release falha — é o comportamento desejado.

Conferir a assinatura de um APK antes de distribuir:

```bash
"D:\Android\Sdk\build-tools\34.0.0\apksigner.bat" verify --print-certs caminho\do.apk
```

## Build de diagnóstico

`-PdiagLogs` liga o log verboso do `ObaLog`. Sem a flag, o R8 remove as
chamadas por inteiro e o aplicativo não escreve nada no logcat.

```bash
cd android && ./gradlew :tv:assembleRelease -PdiagLogs
```

**Build com diagnóstico não se distribui.** O log traz host, nome de provedor
e caminho de arquivo — informação que o usuário comum não deve ver. Por isso os
arquivos de diagnóstico em `releases/` levam o sufixo `-diag` no nome.

Para capturar: [`scripts/log-tv.ps1`](../scripts/log-tv.ps1). Ele filtra pela
tag `Obaflix`, que é a mesma nos dois APK, então serve para TV e celular.

## Duas armadilhas de numeração, abertas

**`0.7.6` ficou queimado.** Ele existe em dois binários diferentes — um com log
(`-diag`) e um sem —, porque só a flag de build mudou entre eles. Quem
relatasse "estou na 0.7.6" não diria qual dos dois. A TV pulou para `0.7.7` por
causa disso, e a regra daqui em diante é nunca reaproveitar um número entre
build de diagnóstico e build limpo.

**O celular está em `1.0.9` desde o primeiro commit do módulo.** O número nunca
subiu, e o conteúdo mudou muito: o `Obaflix-Android-1.0.9.apk` de 24/08 tem
2,4 MB e o `Obaflix-1.0.9.apk` de 31/08 tem 10,1 MB — o segundo já inclui o
Conscrypt e o `AppIntegrity`. São aplicativos bem diferentes com o mesmo
rótulo. Vale subir o `versionCode` e o `versionName` no próximo build.
