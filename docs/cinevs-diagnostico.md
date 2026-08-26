# extractCineVs — diagnóstico local (isolado e desativado)

Extrator novo, **isolado** e **desligado por padrão**, que reproduz **apenas** o fluxo
comprovado no bytecode do `tv16.apk` (base `/api/v1/`):

```
autenticação autorizada (refresh) → /videos → /video/{videoId} → video_url
```

Não usa `resolve-url`. Não forja `X-App-Sig`, `X-App-Integrity` nem `X-Ad-Proof`.
Nada é servido por proxy público nesta etapa. O `extractWebcine` antigo permanece intacto.

- Código: [`src/lib/cinevs.ts`](../src/lib/cinevs.ts)
- Teste local: [`scripts/test-cinevs.ts`](../scripts/test-cinevs.ts) → `npm run test:cinevs`

---

## 1. Variáveis de ambiente

Crie/edite **`.env.local`** na raiz (não commitar). Só você preenche host e token —
nada disso vai para o código nem para os logs.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `CINEVS_API_BASE` | ✅ | Base completa, **sem barra final**. Ex.: `https://SEU-HOST/api/v1` |
| `CINEVS_REFRESH_TOKEN` | ✅ | Refresh token da **sua** conta. Fica só na sua máquina. |
| `CINEVS_DEVICE_ID` | recomendado | `x-device-id` da sua sessão. |
| `CINEVS_PROFILE_ID` | recomendado | `profile_id` do perfil. |
| `CINEVS_AUTH_PATH` | opcional | Caminho do refresh. Padrão `auth/refresh`. Se der 404/401, tente `auth/token`. |
| `CINEVS_PLATFORM` | opcional | Query `platform`. Padrão `web`. |
| `CINEVS_DEVICE_TYPE` | opcional | Query `device_type`. Padrão `web`. |
| `CINEVS_CLIENT_PLATFORM` | opcional | Header `X-Client-Platform`. **Vazio por padrão** (evita casar com o atestado `android-tv`). |
| `CINEVS_TIMEOUT_MS` | opcional | Timeout por requisição. Padrão `8000`. |
| `CINEVS_ENABLED` | opcional | `1` só ativa o uso fora do modo diagnóstico. **Deixe ausente/`0` por enquanto.** |

Exemplo de `.env.local` (valores fictícios):

```dotenv
CINEVS_API_BASE=https://SEU-HOST/api/v1
CINEVS_REFRESH_TOKEN=coloque-o-seu-aqui
CINEVS_DEVICE_ID=coloque-o-seu-aqui
CINEVS_PROFILE_ID=coloque-o-seu-aqui
# CINEVS_AUTH_PATH=auth/token
# CINEVS_CLIENT_PLATFORM=
# CINEVS_ENABLED=0
```

> Sobre o **host** (`CINEVS_API_BASE`): no APK ele chega por config remota **ofuscada**,
> que eu deliberadamente **não** decodifiquei. Você o obtém do seu próprio ambiente/conta.
> Os fallbacks embutidos no APK são `https://utxptx-api.b-cdn.net/api/v1` e
> `https://urobotsy.com/api/v1` — use por sua conta e risco, apenas se forem legítimos para você.

---

## 2. Rodar o teste

Filme:
```bash
npm run test:cinevs -- --tmdb 27205 --type movie
```

Série (com dica de título para a busca):
```bash
npm run test:cinevs -- --tmdb 1399 --type tv --season 1 --episode 1 --q "Game of Thrones"
```

O teste **não baixa nem redistribui** conteúdo. Ele confirma, em ordem:

1. **Autenticação** — `[cinevs/auth] status=200` e `[cinevs/auth_ok]`.
2. **Catálogo** — `[cinevs/search]` + `[cinevs/detail]` até casar o `tmdb_id` → `[cinevs/found]`.
3. **Lista de servidores** — `[cinevs/videos] status=200`.
4. **Obtenção da `video_url`** — `[cinevs/video]` + `[cinevs/head]` → `[cinevs/ok]`.

Saída final (sanitizada):
```
RESULTADO: video_url obtida ✔  (conteúdo NÃO baixado)
  formato .......: HLS
  host da mídia .: <cdn>
  tem expiração .: sim (token/expires na query)
  áudio .........: dubbed
  legendas ......: 2
```

---

## 3. Como ler as falhas

| Log | Significado | Ação |
|---|---|---|
| `auth status=401/404` | refresh path/credencial errados | ajuste `CINEVS_AUTH_PATH` / `CINEVS_REFRESH_TOKEN` |
| `search/detail` sem `found` | título não casa por `tmdb_id` | passe `--q "Título"` |
| `videos status=401/403` | token/headers recusados no `/api/v1/` | ver §4 (atestado) |
| `no_sub` | conta sem assinatura p/ o título | esperado; **não** contornamos ad-gate |
| `video status=401/403` | possível exigência de `X-App-Sig`/`X-Ad-Proof` | ver §4 |
| `ok ... hasExpiry=sim` | **sucesso**: URL assinada temporária | pronto p/ avaliar TTL |

---

## 4. O que ainda depende de validação em runtime (com a sua conta)

Implementado a partir do **bytecode** (comprovado no APK):
- Sequência de endpoints, nomes/campos de resposta (`video_url`, `session_id`, `subtitles`…),
  ausência de `resolve-url` no `/api/v1/`, headers que o cliente nativo envia.

Ainda **não confirmado** (só o seu teste com conta real confirma) — **[RUNTIME]**:
- Se `X-App-Sig` / `X-App-Integrity` / `X-Client-Platform: android-tv` são **exigidos** pelo
  servidor no `/api/v1/`. Este extrator **não os envia forjados**; se o servidor recusar
  (401/403), a integração **não é viável sem burlar o atestado** — e aí paramos.
- Se a `video_url` do `/video/{videoId}` é a URL **final** utilizável ou um redirect assinado
  (o `[cinevs/head]` mostra o redirect, se houver).
- Formato real (HLS/MP4/DASH), host do CDN, TTL da assinatura e se os segmentos exigem
  `Referer`/`Origin`.
- Shape de temporadas/episódios do `/api/v1/` (o código assume `seasons[].episodes[]`).

---

## 5. Ativação definitiva (só depois da sua confirmação)

Enquanto `CINEVS_ENABLED` não for `1`, `extractCineVs()` retorna `null` fora do modo
diagnóstico e **não** está ligado à rota pública `/api/player/extract`. A ligação ao player
e ao proxy só deve ser feita **após** você:

1. rodar o teste com a **sua** conta e ver `RESULTADO: video_url obtida ✔`;
2. confirmar que **possui autorização/licença** para reencaminhar esse conteúdo;
3. decidir a política de proxy/expiração para servir aos usuários.

Só então integramos ao dispatch de extractors (sem remover o antigo) e validamos na Vercel.
