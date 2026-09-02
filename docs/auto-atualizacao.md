# Atualização automática — Android, Android TV e Electron

Três aplicativos nativos, três mecanismos — cada um o que já é idiomático na
própria plataforma. Nenhum reimplementa o outro.

| Ambiente | Mecanismo | Canal |
|---|---|---|
| **Electron (Windows)** | `electron-updater` (já existia, sem mudanças) | GitHub Releases |
| **Android (celular)** | `Atualizador` (novo, compartilhado com a TV) | Manifesto no R2 |
| **Android TV** | `Atualizador` (novo, compartilhado com o celular) | Manifesto no R2 |

## Electron: nada mudou

`desktop/electron/updater.js` já chama `autoUpdater.checkForUpdatesAndNotify()`
30s após abrir e depois a cada 4h, baixa em segundo plano
(`autoDownload = true`), nunca sugere downgrade (`allowDowngrade = false`) e só
avisa o site quando o download termina — via
`window.__obaflixShowUpdate(versao)`, que o `DesktopUpdateBanner.tsx` já
escuta. `desktop/package.json` já publica para
`github.com/contaobaanuncio4-dot/obaflix-releases`. Está configurado e
funcionando; a tarefa aqui era só confirmar isso, não substituir.

**Divergência que vale registrar, não corrigir agora:** o Electron busca
atualizações no GitHub Releases, não no R2. O R2 (`app.obaflix.online`) é de
onde vem o instalador da **primeira** instalação (o link que
`src/config/downloads.ts` publica no site); depois de instalado, quem decide
a próxima versão é o GitHub Release mais recente. São dois canais
independentes hoje — não é um bug introduzido por esta mudança, é o desenho
já existente.

## Android e Android TV: `Atualizador`

### Por que compartilhado

Os dois módulos (`:app`, `:tv`) já compartilham todo o resto da extração
através de `:core-extractor` — é a arquitetura estabelecida do projeto (ver
`CLAUDE.md`, "comportamento equivalente, não código idêntico" — mas aqui,
diferente do Website/Electron/Android, os dois lados SÃO Android, então o
código pode ser literalmente o mesmo). `Atualizador` e as classes que ele usa
vivem em `android/core-extractor/src/main/java/com/obaflix/update/`:

| Arquivo | Responsabilidade |
|---|---|
| `UpdateManifest.kt` | Modelos + parser do manifesto JSON |
| `UpdateChecker.kt` | Busca o manifesto, decide se há versão nova (por `versionCode`) |
| `UpdateDownloader.kt` | Baixa via `DownloadManager`, confere tamanho/sha256 |
| `UpdateInstaller.kt` | Abre o instalador do sistema |
| `Atualizador.kt` | Orquestra os três acima; publica `StateFlow<EstadoAtualizacao>` |

O que muda entre celular e TV é só a apresentação:

- **`:app`** (WebView) — chama `window.__obaflixShowUpdate(versao)` quando o
  estado vira `Pronta`, exatamente como o Electron já faz. O
  `DesktopUpdateBanner.tsx` do site aparece sozinho, **sem nenhuma mudança no
  site**: ele já lê `window.obaflixDesktop` sem saber qual plataforma o
  implementa. `installUpdate()` chama de volta
  `ObaflixBridge.installUpdate()`, que abre o instalador do sistema.
- **`:tv`** — `CamadaAtualizacao.kt` desenha um cartão navegável por D-pad
  ("Atualizar agora" / "Agora não"), mesmo padrão de camada que
  `CamadaDesafio.kt` já usa para o desafio do Superflix.

### O manifesto

JSON hospedado no R2, no mesmo domínio dos instaladores
(`app.obaflix.online`). URL declarada em `android/gradle.properties`
(`obaflix.updateManifestUrl`), lida por `:core-extractor`, `:app` e `:tv` —
mesmo padrão já usado para `obaflix.url`.

```json
{
  "schemaVersion": 1,
  "android": {
    "versionName": "1.0.9",
    "versionCode": 9,
    "url": "https://app.obaflix.online/Obaflix-1.0.9.apk",
    "size": 10667603,
    "sha256": "6a11ca2ce9ccca12afd72cc3de2ce7554845e7f8a0826e1fc51cb69ddec78374"
  },
  "androidTv": {
    "versionName": "0.7.20",
    "versionCode": 36,
    "url": "https://app.obaflix.online/Obaflix-TV-0.7.20.apk",
    "size": 5103425,
    "sha256": "6ff49bb5989008e1daf569a5a5adaf49bd56e6e6f7daa7a0cac3854c13f63cc8"
  }
}
```

Campos:

| Campo | Obrigatório | Uso |
|---|---|---|
| `versionName` | sim | Só exibição ("versão 1.1.0 pronta") |
| `versionCode` | sim | **A única coisa comparada.** Inteiro, sempre crescente |
| `url` | sim | Precisa começar com `https://` — qualquer outra coisa é rejeitada na leitura |
| `size` | não | Se presente, o download é rejeitado se o tamanho final não bater |
| `sha256` | não | Se presente (64 hex), o download é rejeitado se o hash não bater |

Cada plataforma é independente e opcional: publicar só `android` não invalida
o manifesto para a TV, e vice-versa. Uma entrada malformada (URL sem HTTPS,
`versionCode` inválido, `versionName` vazio) é tratada como **ausente**, não
como erro — o resto do manifesto continua valendo. Só um JSON ilegível no
nível raiz invalida a leitura inteira.

**Gerar o manifesto:**

```bash
node scripts/gerar-manifesto-atualizacao.js \
  --android-apk releases/Obaflix-1.0.9.apk \
  --android-url https://app.obaflix.online/Obaflix-1.0.9.apk \
  --tv-apk releases/Obaflix-TV-0.7.20.apk \
  --tv-url https://app.obaflix.online/Obaflix-TV-0.7.20.apk
```

`versionName`/`versionCode` saem direto de `android/app/build.gradle` e
`android/tv/build.gradle` — nunca digitados à mão, para nunca divergir do
binário real. `size`/`sha256` saem do próprio arquivo. Qualquer uma das duas
plataformas pode ser omitida.

**Publicar:** subir o `update-manifest.json` gerado para o R2, no mesmo
caminho de `obaflix.updateManifestUrl` — hoje,
`https://app.obaflix.online/update-manifest.json` —, junto com o(s) APK que
ele referencia. Isso é manual, como já é o upload dos próprios APK
(`docs/versoes.md`); nada neste trabalho publica automaticamente no R2.

### Fluxo, em cada aparelho

1. No boot (cada abertura do app), `Atualizador.iniciar()` começa um laço:
   verifica agora, depois a cada 4h enquanto o processo viver — mesmo
   intervalo do Electron.
2. **Verificação**: GET no manifesto (sem cache), decide por `versionCode`.
   Nunca sugere downgrade — só oferece se `versionCode` publicado > instalado.
3. Se houver versão nova: baixa em segundo plano via `DownloadManager` do
   sistema (não um GET silencioso nosso) — aparece na notificação e no
   gerenciador de downloads do Android, sobrevive o app fechando, e o próprio
   sistema tenta de novo numa queda de conexão.
4. Download concluído: confere tamanho e sha256 contra o manifesto, se
   presentes. Qualquer divergência descarta o arquivo.
5. Só então o estado vira `Pronta` — e só então a interface (banner web ou
   cartão da TV) aparece.
6. Instalar é sempre um toque explícito, que abre o instalador **do sistema**
   Android via `Intent(ACTION_VIEW)` com um `content://` do `FileProvider`.
   Nenhum código aqui instala nada sozinho.

### Tratamento de erro

| Situação | Comportamento |
|---|---|
| Sem internet / DNS falha / timeout | `SemConexao` — log, sem UI, tenta de novo no próximo ciclo |
| Manifesto não é JSON válido | `ManifestoInvalido` — idem |
| Plataforma ausente/malformada no manifesto | `PlataformaAusente` — idem |
| Mesma versão ou mais antiga | `JaAtualizado` — nada acontece, silencioso |
| Download interrompido (sem rede no meio) | `DownloadManager` tenta de novo sozinho; se não concluir em 10 min, desiste e libera para o próximo ciclo tentar do zero |
| HTTP 404/erro do servidor no arquivo | `DownloadManager` reporta o status como motivo da falha |
| Arquivo baixado corrompido/truncado | Tamanho e/ou sha256 não batem → arquivo descartado, log, sem instalar |
| Versão já baixada e pronta | Recheckagem periódica não baixa de novo, a não ser que apareça uma versão MAIS nova ainda |

### Permissões e por que cada uma existe

- **`REQUEST_INSTALL_PACKAGES`** — permissão especial (não "perigosa"):
  declarar no manifesto não concede nada sozinho. O Android exige que o
  usuário libere explicitamente em Configurações
  (`UpdateInstaller.abrirPermissaoDeInstalacao`, que abre exatamente essa
  tela) antes do instalador aceitar o APK. Sem essa permissão o Android
  mostra seu próprio aviso e recusa.
- **`FileProvider`** (`android/core-extractor/src/main/AndroidManifest.xml` +
  `res/xml/file_paths.xml`) — expõe só a pasta de downloads do próprio app
  (`getExternalFilesDir(DIRECTORY_DOWNLOADS)`), nunca o armazenamento
  inteiro. `android:authorities="${applicationId}.fileprovider"` resolve
  para `com.obaflix.fileprovider` no celular e `com.obaflix.tv.fileprovider`
  na TV — sem colisão, confirmado no manifest mesclado de cada módulo.
- **Nenhuma permissão de armazenamento** — o download cai em armazenamento
  privado do app, não na pasta pública de Downloads. Não precisa de
  `WRITE_EXTERNAL_STORAGE` em nenhuma versão do Android.

### Por que não reforça a assinatura no código

O `sha256` do manifesto protege contra download truncado/corrompido — não é
uma cadeia de confiança. Quem garante que o APK instalado é legítimo é o
próprio Android: na atualização, o sistema recusa sozinho qualquer pacote que
não esteja assinado com o **mesmo certificado** do app já instalado
(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). É a mesma garantia que
`AppIntegrity.kt` já verifica do lado de dentro do app — aqui ela roda do
lado de fora, no próprio instalador do sistema, sem precisar de código
nenhum a mais.

## Testes

`android/core-extractor/src/test/java/com/obaflix/update/` — JVM puro, sem
Robolectric:

- `UpdateManifestParserTest` — manifesto válido, plataforma ausente, URL sem
  HTTPS, `versionCode` inválido, JSON malformado, sha256 malformado/maiúsculo.
- `UpdateCheckerDecisionTest` — a comparação de `versionCode` isolada de rede
  (maior/igual/menor, plataforma ausente).
- `UpdateDownloaderChecksumTest` — o sha256 em streaming bate com o digest
  direto, inclusive em arquivo maior que o buffer interno.

```bash
cd android && ./gradlew :core-extractor:test
```

O que depende de `Context`/`DownloadManager`/`FileProvider` (I/O real de
rede e disco) não tem teste automatizado — validado por build real
(`:app:assembleRelease`, `:tv:assembleRelease`, `:tv:lintRelease`,
`:app:lintRelease`, todos limpos) e fica para validação manual em aparelho
antes da primeira publicação do manifesto.

## Arquivos

**Novos:**
- `android/core-extractor/src/main/java/com/obaflix/update/*.kt` (5 arquivos)
- `android/core-extractor/src/main/res/xml/file_paths.xml`
- `android/core-extractor/src/test/java/com/obaflix/update/*.kt` (3 arquivos)
- `android/tv/src/main/java/com/obaflix/tv/ui/CamadaAtualizacao.kt`
- `scripts/gerar-manifesto-atualizacao.js`
- `docs/auto-atualizacao.md` (este arquivo)

**Modificados:**
- `android/core-extractor/src/main/AndroidManifest.xml` — permissão + `FileProvider`
- `android/core-extractor/build.gradle` — `UPDATE_MANIFEST_URL` + deps de teste
- `android/app/build.gradle`, `android/tv/build.gradle` — `UPDATE_MANIFEST_URL`
- `android/gradle.properties` — `obaflix.updateManifestUrl`
- `android/core-extractor/src/main/java/com/obaflix/bridge/ObaLog.kt` — fase `ATUALIZACAO`
- `android/core-extractor/src/main/java/com/obaflix/bridge/ObaflixBridge.kt` — `installUpdate()`
- `android/app/src/main/java/com/obaflix/MainActivity.kt` — inicia `Atualizador`, liga o shim
- `android/tv/src/main/java/com/obaflix/tv/ui/AppTv.kt` — inicia `Atualizador`, desenha `CamadaAtualizacao`

**Não tocados (por design):** `desktop/electron/*`, `src/config/downloads.ts`,
qualquer lógica de Superflix/extração/banco.
