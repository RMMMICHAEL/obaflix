# Código-fonte correspondente (GPLv3, seção 6)

Toda versão distribuída (APK direto, AAB da Google Play) precisa ter o **código-fonte correspondente**
disponível a quem recebeu o binário, sob GPLv3. Este documento define o que compõe esse pacote.
Nada aqui publica repositório: a forma de disponibilização (repositório público ou oferta escrita
válida por 3 anos, seção 6b) é decisão pendente.

## O que entra

1. Este repositório no commit exato que gerou o binário (registrar o hash na nota da versão).
2. `LICENSE` (GPLv3, idêntico ao upstream: blob `e72bfddabc15be5718a7cc061ac10e47741d8219`) e `NOTICE.md`.
3. Scripts e configurações de build: `build.gradle.kts`, `settings.gradle.kts`, `gradle/`, `gradlew*`,
   `androidApp/`, `composeApp/`, `obaflix-core-extractor/`.
4. Instruções de build (abaixo) e os nomes das propriedades exigidas — **nunca os valores**.

## O que não entra (segredos e artefatos)

- `local.properties` (já em `.gitignore`), keystores, senhas de assinatura, tokens de CI.
- `lab-evidence/` (logs locais versionados no laboratório: excluir do pacote público).
- Chaves de serviços: Trakt/Simkl/MDBList/Premiumize e Supabase do Nuvio estão vazias neste fork;
  o Game ID do Unity Ads é identificador público do painel, não segredo.

## Build

```bash
# Android, distribuição direta (APK)
./gradlew :androidApp:assembleFullRelease
# Google Play (AAB)
./gradlew :androidApp:bundlePlaystoreRelease
```

Assinatura de release: propriedades de keystore lidas em `androidApp/build.gradle.kts`
(`signingConfigs.release`), fornecidas fora do repositório.

## Base upstream

NuvioMobile `cmp-rewrite` @ `c78756d0cbda3337cfff36a95d8b6708f48c0d72`. A cópia do laboratório
não trouxe do upstream: `Docs/`, `docs/`, `scripts/`, `vendor/` (`quickjs-kt`, `TorrServer`) e os
submódulos `MPVKit` (`bfeb6fcf…`, iOS) e `libass-android` (`c10b71ab…`). O pacote de fonte deve
apontar para esses caminhos no commit upstream acima ou incluí-los.

## Binários pré-compilados herdados do upstream (`composeApp/libs/`)

Origens verificadas em 2026-10-22 por inspeção dos binários (pacote no manifesto, classes e
símbolos nativos) e comparação com os artefatos oficiais. Nenhum AAR traz arquivo de licença embutido.

| Arquivo | SHA-256 (início) | Origem comprovada | Licença | Fonte |
|---|---|---|---|---|
| lib-common-release.aar | a01729509ff920e2 | Fork do AndroidX Media3 1.8.0: +6 classes (`NuvioEngineConfig`, `ByteBufferDataReader`…) | Apache-2.0 | Fork **não publicado** (pedir à NuvioMedia) |
| lib-datasource-release.aar | 5375c0ff43784d21 | Fork Media3 1.8.0: +1 classe (`LocalhostZeroCopyDataSource`), 16 alteradas | Apache-2.0 | idem |
| lib-datasource-okhttp-release.aar | ba71ce4326b6bab3 | Fork Media3 1.8.0: 1 classe alterada (`OkHttpDataSource`) | Apache-2.0 | idem |
| lib-exoplayer-release.aar | d8c5a4357c4672c2 | Fork Media3 1.8.0: +4 classes (`SampleDataQueueNative`…), 8 alteradas; `libmedia3_exoplayer_jni.so` | Apache-2.0 | idem |
| lib-exoplayer-hls-release.aar | 826cbaddd86d9ff5 | Fork Media3 1.8.0: 1 classe alterada (`Aes128DataSource`) | Apache-2.0 | idem |
| lib-extractor-release.aar | d611a11f7bc6cef1 | Fork Media3 1.8.0: +1 classe, 3 alteradas | Apache-2.0 | idem |
| lib-ui-release.aar | 3ffdb5b0d11f2a1c | Fork Media3 1.8.0: +2 classes, 28 alteradas | Apache-2.0 | idem |
| lib-decoder-ffmpeg-release.aar | f85c2fb93afb3977 | Extensão Media3 + FFmpeg 6.0 (`Lavc60.3.100`), `libffmpegJNI.so` | Apache-2.0 + LGPL-2.1+ ou GPL (configuração do build desconhecida) | FFmpeg 6.0 público; flags do build: pedir à NuvioMedia |
| lib-decoder-av1-release.aar | e4f929a8132fdd2e | Extensão Media3 + libgav1, `libgav1JNI.so` | Apache-2.0 | Media3 1.8.0 e libgav1 públicos; modificação não verificável (sem AAR oficial) |
| lib-decoder-mpegh-release.aar | e21884ef2f0e88b9 | Extensão Media3 + Fraunhofer mpeghdec (`mpeghdecoder_*`), `libmpeghJNI.so` | Software License for The Fraunhofer FDK MPEG-H Software (sem licença de patente) | Público: github.com/Fraunhofer-IIS/mpeghdec. Compatibilidade com GPLv3: parecer jurídico |
| lib-nuvio-engine-android-0.1.5.aar | 2b33feabfa7ae7cd | NuvioMedia/nuvio-engine, tag `v0.1.5` (libtorrent 2.0.12 + patches) | GPL-3.0 | Público: github.com/NuvioMedia/nuvio-engine @ v0.1.5 |
| quickjs-kt-android-1.0.5-nuvio.aar | 7bbafcaf3c94feac | dokar3/quickjs-kt modificado (QuickJS) | Apache-2.0 / MIT | Upstream `vendor/quickjs-kt` @ c78756d |

Diferenças do Media3 medidas contra `androidx.media3:*:1.8.0` do Google Maven. O app depende do fork
(`NuvioEngineConfig` em `NuvioExoPlayerPerformanceHelper.kt`); trocar pelo oficial altera buffer/memória.

## Dependências proprietárias acrescentadas pelo Obaflix

`com.unity3d.ads:unity-ads:4.21.0` e `com.unity3d.ads-mediation:adquality-sdk:9.9.0` (traz
`play-services-cronet`), licença "Unity Ads License" (termos de serviço da Unity), compilados no mesmo
módulo GPL. O upstream não tem exceção GPLv3 nem CLA. Situação e pedido: `docs/obaflix/SOLICITACAO-NUVIOMEDIA.md`.
