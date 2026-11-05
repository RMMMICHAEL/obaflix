# Pedido à NuvioMedia — fonte do fork Media3 e exceção GPLv3

Documento interno. Nada foi enviado. Canal sugerido: issue ou contato listado em
github.com/NuvioMedia/NuvioMobile (mantenedor principal: `tapframe`, 2114 commits; o repositório tem ~74 contribuidores).

## Dados técnicos

- Base: NuvioMobile `cmp-rewrite` @ `c78756d0cbda3337cfff36a95d8b6708f48c0d72` (2026-10-21).
- AARs do fork Media3 1.8.0 em `composeApp/libs/` (SHA-256 completos: `sha256sum composeApp/libs/*.aar`):
  `lib-common`, `lib-datasource`, `lib-datasource-okhttp`, `lib-exoplayer`, `lib-exoplayer-hls`,
  `lib-extractor`, `lib-ui` (classes acrescentadas, ex.: `androidx.media3.common.NuvioEngineConfig`,
  `androidx.media3.datasource.LocalhostZeroCopyDataSource`, `androidx.media3.exoplayer.source.SampleDataQueueNative`).
- Extensões: `lib-decoder-ffmpeg` (FFmpeg 6.0, `Lavc60.3.100`), `lib-decoder-av1` (libgav1),
  `lib-decoder-mpegh` (Fraunhofer mpeghdec).
- `github.com/NuvioMedia/media3` não existe; o fork não está em `nuvio-engine`.
- O `LICENSE` do upstream é a GPLv3 sem permissões adicionais; `CONTRIBUTING.md` não tem CLA.
- Obaflix acrescenta `com.unity3d.ads:unity-ads:4.21.0` + `adquality-sdk:9.9.0` (licença proprietária da Unity).

## Perguntas

1. Onde está o código-fonte (repositório e commit/tag) do fork Media3 usado nesses AARs, com os scripts de build?
2. Quais flags de configuração do FFmpeg foram usadas (LGPL ou GPL)? As extensões AV1/MPEG-H foram modificadas?
3. A NuvioMedia oferece, ou poderia conceder, uma permissão adicional (GPLv3, seção 7) para combinar o
   Nuvio Mobile com SDKs proprietários de anúncios (Unity Ads)? Ela teria direitos para conceder isso em
   nome dos demais contribuidores (há cessão de direitos/CLA)?
4. Há posição da NuvioMedia sobre o uso do decodificador MPEG-H da Fraunhofer em distribuições do app?

## Mensagem pronta (inglês)

> Hello NuvioMedia team,
>
> We maintain a modified version of Nuvio Mobile (based on `cmp-rewrite` @ `c78756d`) and want to
> distribute it in full compliance with the GPLv3, including the Corresponding Source.
>
> 1. The prebuilt AARs in `composeApp/libs/` (`lib-common`, `lib-datasource`, `lib-datasource-okhttp`,
>    `lib-exoplayer`, `lib-exoplayer-hls`, `lib-extractor`, `lib-ui`) are a modified Media3 1.8.0
>    (e.g. `NuvioEngineConfig`, `LocalhostZeroCopyDataSource`, `SampleDataQueueNative`). Could you point us
>    to the source repository and commit, and the build scripts, used to produce them?
> 2. For `lib-decoder-ffmpeg` (FFmpeg 6.0), `lib-decoder-av1` and `lib-decoder-mpegh`: which FFmpeg
>    configure flags were used, and were the decoder extensions modified?
> 3. Our build also includes a proprietary ad SDK (Unity Ads). Does NuvioMedia offer, or would it consider
>    granting, an additional permission under GPLv3 section 7 allowing Nuvio Mobile to be combined with
>    proprietary advertising SDKs? Do you hold the rights to grant it on behalf of contributors?
>
> Thank you for Nuvio Mobile. We credit the project and its license in the app.
