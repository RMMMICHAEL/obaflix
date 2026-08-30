# Proxy de mídia fora da Vercel — etapa preparada, não aplicada

Nada aqui está ligado. `src/worker.ts` não é chamado por nenhuma rota do app, e
o `MEDIA_SEGMENT_DELIVERY` do backend continua decidindo tudo como antes.

## Por que existe

O navegador é o único ambiente que não consegue enviar o `Referer` que os CDNs
exigem. Por isso, hoje, cada segmento de vídeo assistido no site atravessa o
Compute da Vercel — cerca de 1 GB por episódio em 1080p, cobrado nas duas
pontas (CDN→Compute na entrada, Transfer Out na saída).

Android, Android TV e Electron **não** entram nessa conta e não devem entrar:
quando o provedor tem extrator nativo, eles já buscam direto no CDN injetando os
cabeçalhos localmente. Isso foi verificado e não deve ser "otimizado" de novo —
a nota no fim de `src/app/api/player/proxy/route.ts` explica o que acontece
quando se tenta.

## O que precisa mudar no backend antes de ligar

A assinatura de segmento de hoje (`signSegmentUrl` em `src/lib/playTokens.ts`)
cobre apenas `userId:url`. Faltam duas coisas para ela servir aqui:

1. **Expiração.** Sem `exp`, a assinatura vale até a chave semanal girar — na
   prática, até duas semanas. O Worker exige `exp` e o inclui no material
   assinado.
2. **Referer no material assinado.** O Worker precisa receber qual `Referer`
   injetar. Se esse campo não for assinado, quem monta o pedido escolhe com
   quem o Worker vai falar — é exatamente a diferença entre um proxy fechado e
   um proxy aberto com etapa extra.

O `userId` também não deve viajar na URL. O Worker recebe `s` (um `sub` opaco),
e o backend deriva esse valor do `userId`.

Esboço do lado Node, para quando a etapa for aplicada — **não implementar agora**:

```ts
// material assinado: `${sub}:${exp}:${url}:${ref}`
const sub = crypto.createHmac("sha256", key).update(`sub:${userId}`).digest("base64url").slice(0, 16);
const exp = Date.now() + 4 * 3600 * 1000; // sessão de reprodução, não mais
const sig = crypto.createHmac("sha256", key)
  .update(`${sub}:${exp}:${url}:${ref}`)
  .digest("base64url").slice(0, 22);
```

A derivação de chave (`sha256(secret:week:N)`, semana corrente + anterior) é a
mesma dos dois lados, e o segredo é o `NEXTAUTH_SECRET` que já existe.

## Os quatro controles — nenhum é opcional

| Controle | O que segura | Onde |
|---|---|---|
| HMAC sobre `sub:exp:url:ref` | só busca URL que o nosso backend emitiu | `assinaturaConfere` |
| `exp` conferido antes do HMAC | replay de URL antiga | `fetch()` |
| Allowlist de host por sufixo | vazamento de chave virar SSRF | `hostPermitido` |
| CORS preso a `APP_ORIGIN` | outro site consumir nossa banda | headers de saída |

Além disso: só `GET`/`HEAD`; só `https`; sem credenciais na URL; `redirect:
"manual"` (seguir redirect sairia da allowlist sem revalidar); resposta montada
campo a campo, para o domínio real do CDN não vazar em `Location` ou cookie; e
recusa sempre com o mesmo 403 genérico, sem dizer qual controle barrou.

## Ordem do corte, quando for a hora

1. Publicar o Worker com `CDN_ALLOWLIST` preenchida e o secret configurado.
2. Adicionar a assinatura v2 no backend (não remover a v1 ainda).
3. Ligar para **uma** fonte, atrás de flag, e comparar no painel da Vercel:
   Fast Origin Transfer e Fast Data Transfer devem cair na proporção do tráfego
   movido; Functions não deve subir.
4. Só então estender às demais e aposentar a v1.

Rollback é o próprio `MEDIA_SEGMENT_DELIVERY=proxy`: volta tudo para a Vercel
sem deploy de código.

## Custo

O plano gratuito da Cloudflare não cobra por banda de Worker; cobra por
requisição (100 mil/dia). Um episódio HLS são centenas de segmentos, então o
limite que aperta primeiro é o de requisições, não o de bytes — é o oposto da
Vercel, e é justamente por isso que a troca compensa.
