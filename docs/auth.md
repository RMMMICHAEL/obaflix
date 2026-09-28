# Autenticação e Autorização

## Arquivo Principal

`src/lib/auth.ts` — `authOptions` do NextAuth.js

## Estratégia

- **Sessões:** JWT (client-side, stateless)
- **Providers:** Credentials (email + senha) + Google OAuth (opcional)
- **Cookies:** `__Secure-` prefixo, `HttpOnly`, `Secure`, `SameSite=strict`

## Providers

### Credentials

```typescript
async authorize(credentials) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user.senhaHash) throw new Error("google-account"); // conta Google sem senha
  const ok = await bcrypt.compare(senha, user.senhaHash);
  if (!ok) return null;
  return { id, email, name: user.nome, role: user.role };
}
```

### Google OAuth

Ativado apenas se `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` estiverem configurados. Usuários Google não têm `senhaHash` — logar com email/senha em conta Google retorna erro `"google-account"` (tratado na UI).

## JWT Callbacks

```typescript
async jwt({ token, user }) {
  if (user) {
    token.id = user.id;
    token.role = user.role ?? "user";
  }
  return token;
},
async session({ session, token }) {
  if (session.user) {
    session.user.id = token.id;
    session.user.role = token.role;
  }
  return session;
}
```

O `id` e `role` do usuário estão disponíveis em qualquer Server Component via `getServerSession()`.

## Roles

| Role | Acesso |
|------|--------|
| `"user"` | Padrão; acesso ao conteúdo |
| `"admin"` | Painel `/admin`, rotas admin |

## Autorização Admin

Detalhes e estado final: `docs/admin-cutover-final.md`.

| Guarda (`src/lib/auth.ts`) | Aceita | Onde |
|---|---|---|
| `requireAdmin` / `requireAdminSession` | **só** sessão com `role=admin` reconfirmado no banco a cada requisição. `x-admin-token` → 403 sem consultar sessão | toda API humana em `/api/admin/*` e `/api/player/debug-segment` |
| `requireAdminAction` | idem + origem = host + rate limit por admin; grava `AdminAudit` | ações sensíveis (senha, assinatura, canais) |
| `requireAdminOrLegacyCatalogToken` | sessão admin; **ou**, na transição, `x-admin-token` só em GET/POST, superfície pública, cutover desligado e `ADMIN_SECRET_TOKEN` ≥ 32 | `/api/admin/{filme,serie,episodio/bulk}` (DELETE/PUT sempre sessão) |
| `requireCatalogSync` | `CATALOG_SYNC_TOKEN` (Bearer), escopo `/api/integracoes/catalogo/*` | integrações de catálogo |

```typescript
const guard = await requireAdmin(req);
if (guard) return guard; // 401 sem sessão, 403 sem role admin no banco ou com token legado
```

## CORS Admin

Só o legado de catálogo tem CORS, e só para `https://admin.megafrixapi.com`
(origem do Tampermonkey; é **fonte** MegaFlix, não o admin do Obaflix), só
`GET, POST, OPTIONS`, e nunca no painel separado nem com o cutover ligado.
O Tampermonkey usa `GM_xmlhttpRequest`, que não depende de CORS; a integração
não tem CORS nenhum.

## Cadastro

Rota `POST /api/auth/register`:
- Hash da senha com `bcrypt` (cost factor 10)
- Email normalizado: `toLowerCase().trim()`
- Role padrão: `"user"`
- Usuários Google: `senhaHash: null`

## Página de Login

`src/app/login/page.tsx` — formulário de email/senha + botão "Entrar com Google".

Erros tratados:
- `"google-account"` — exibe "Esta conta foi criada com Google"
- `"CredentialsSignin"` — "Email ou senha incorretos"

## Variáveis de Ambiente

| Variável | Propósito |
|----------|-----------|
| `NEXTAUTH_SECRET` | Chave JWT + derivação PlayToken/StreamToken/SegmentSig |
| `NEXTAUTH_URL` | URL base do site (para callbacks OAuth) |
| `GOOGLE_CLIENT_ID` | Client ID OAuth do Google (opcional) |
| `GOOGLE_CLIENT_SECRET` | Client Secret OAuth do Google (opcional) |
| `ADMIN_SECRET_TOKEN` | Legado em descontinuação: só catálogo (`filme`/`serie`/`episodio/bulk`, GET/POST) no público com cutover desligado |
| `CATALOG_SYNC_TOKEN` | Integração de catálogo máquina→máquina (`/api/integracoes/catalogo/*`) |
