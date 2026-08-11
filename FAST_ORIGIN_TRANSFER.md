# ALERTA CRÍTICO: Fast Origin Transfer da Vercel

> [!CAUTION]
> **NÃO encaminhe segmentos de vídeo pelo Vercel Compute.** Uma alteração que faça
> arquivos `.ts`, `.m4s`, `.mp4`, `EXT-X-MAP`, `EXT-X-PART` ou outros bytes pesados
> passarem por `/api/player/proxy` pode consumir rapidamente toda a franquia de
> **Fast Origin Transfer** da Vercel.

## Regra de arquitetura que deve ser preservada

O fluxo normal de mídia no navegador é:

```text
CDN do provedor ───────────────> dispositivo do usuário
                     segmentos de vídeo

Vercel ──> playlists pequenas, autenticação, tokens e chaves necessárias
```

Os segmentos pesados devem ser convertidos para URLs HTTPS absolutas no M3U8 e
baixados diretamente pelo dispositivo. A Vercel não deve transportar os bytes do
vídeo entre uma Function e seu CDN.

## Implementação protegida

- `src/app/api/player/proxy/route.ts`
  - `shouldProxyMediaThroughApp()` deve permanecer em modo direto por padrão.
  - `MEDIA_SEGMENT_DELIVERY=proxy` é somente um fallback emergencial e temporário.
  - Playlists, autenticação, chaves e trilhas que precisem de proteção podem continuar
    no proxy; segmentos de mídia não.
- `next.config.mjs`
  - `connect-src` e `media-src` devem permitir os CDNs HTTPS dinâmicos usados pelo HLS.
  - Restringir novamente essas diretivas a `'self'` força ou quebra a entrega direta.

## Alterações proibidas sem aprovação e medição

Não faça nenhuma destas mudanças silenciosamente:

1. Trocar o padrão de `MEDIA_SEGMENT_DELIVERY` para `proxy`.
2. Fazer navegadores comuns retornarem `true` em `shouldProxyMediaThroughApp()`.
3. Reescrever todas as linhas de segmentos do M3U8 para `/api/player/proxy`.
4. Restringir `connect-src` ou `media-src` a `'self'` sem uma solução externa equivalente.
5. Usar Middleware, Route Handler, Server Action ou Function como túnel de vídeo.
6. Criar fallback automático global para o proxy da Vercel quando apenas um provedor falhar.

## Checklist obrigatório antes de alterar o player

- Identificar se a mudança fará bytes de mídia passarem pelo Vercel Compute.
- Testar no DevTools se as requisições de segmentos apontam para o CDN externo, e não
  para `obaflix.vercel.app/api/player/proxy`.
- Testar filme, série, troca de episódio, avanço, áudio, legenda e tela cheia.
- Se um provedor não oferecer CORS, corrigir apenas esse provedor ou usar um serviço de
  mídia externo; não reativar o proxy global da Vercel.
- Após publicar, acompanhar **Usage → Fast Origin Transfer → Outgoing → Invocations**.
- Documentar e obter aprovação explícita para qualquer alteração que aumente consumo.

## Publicação

O fluxo oficial é sempre:

```text
commit → push origin main → deploy automático da Vercel
```

Não publicar diretamente com `vercel --prod`, salvo solicitação explícita do responsável.
