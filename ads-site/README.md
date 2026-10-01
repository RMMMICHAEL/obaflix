# obaflix-ads

Site estático e isolado que entrega o banner Monetag (In-Page Push) exibido no
app Windows do Obaflix. Vive num **projeto Vercel separado** e num **site
diferente** do app (`*.vercel.app` está na Public Suffix List), para o iframe
poder ter origem real — IndexedDB funcionando, que a tag exige — sem jamais ter
a origem do app.

Não depende de nada do Obaflix: sem build, sem `package.json`, sem segredos, sem
cookies/sessão do app, sem API, sem redirect.

```
ads-site/
  vercel.json          headers, CSP e frame-ancestors; outputDirectory = public
  public/index.html    raiz (verificação do domínio na Monetag)
  public/banner.html   documento do anúncio (detector + tag, zonas vazias)
  public/404.html
  public/robots.txt
  test/site.test.mjs   verificações estáticas (node --test ads-site/test)
```

## Pontos de edição

1. **Verificação do domínio** — `public/index.html`, bloco `VERIFICAÇÃO DA
   MONETAG`: colar a `<meta>` gerada pela Monetag.
2. **Zonas** — `public/banner.html`, `var ZONAS = { feed, detalhe, player }`:
   zonas In-Page Push criadas **para este domínio**. Vazio = tag não carrega.
3. **Quem pode emoldurar** — `frame-ancestors` em `vercel.json` **e** a lista
   `APP` em `public/banner.html` (o teste exige as duas iguais). Hoje:
   produção `https://obaflix.vercel.app` + alias da branch de homologação.

## Fronteira de segurança (medida no Electron 43 com a Monetag real)

A tag In-Page Push **não entrega anúncio em iframe com `sandbox`**, com
qualquer combinação de flags — inclusive todas. Sem o atributo, entrega
(POST /400 → GET /500 → criativo → impressão). Por isso o app vai emoldurar
este documento **sem sandbox**, e a fronteira passa a ser:

- **site diferente do app** — o navegador isola os documentos: o anúncio não
  lê `parent.document`, `obaflixDesktop`, cookies nem storage do app (medido:
  `SecurityError`). O preload do Electron só roda no frame principal. **Nunca
  servir este documento pelo domínio do app** — lá, sem sandbox, ele teria a
  origem do app;
- **`allow=` restritivo no iframe** (câmera, microfone, geolocalização,
  pagamento, USB, fullscreen etc. negados) — compatível com a tag (medido);
- **`credentialless`** opcional — também compatível (medido);
- **`frame-ancestors`** só nas origens do Obaflix (medido: outra origem não
  carrega o documento); raiz com `frame-ancestors 'none'`;
- **CSP do banner**: `https:` para script/connect/img/frame porque a tag troca
  de domínio; sem `eval`, `http:`, workers, objetos, formulários e `<base>`.
  Zero violações com o anúncio entregue (medido).

**Obrigatório no Electron antes de usar (próxima etapa, novo EXE):** sem
sandbox, o frame conseguiu navegar a janela de cima para outro site **sem
gesto** (medido). O `main.js` precisa recusar navegação do topo iniciada por
este domínio — sem mandá-la ao navegador —, cancelar download vindo dele e
continuar mandando `window.open` só ao navegador do sistema.
