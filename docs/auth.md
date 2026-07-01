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

```typescript
export async function requireAdmin(req?) {
  // 1. Preflight CORS para o painel admin externo
  if (req?.method === "OPTIONS") return CORS 204;

  // 2. Token estático (scripts do painel Megaflix)
  if (req?.headers.get("x-admin-token") === ADMIN_SECRET_TOKEN) return null; // ok

  // 3. JWT session com role="admin"
  const session = await getServerSession(authOptions);
  if (!session?.user) return 401;
  if (session.user.role !== "admin") return 403;
  return null; // ok
}
```

Uso em rotas admin:
```typescript
const guard = await requireAdmin(req);
if (guard) return guard; // retorna 401/403 direto
```

## CORS Admin

O painel admin externo (`admin.megafrixapi.com`) tem CORS liberado para rotas admin:

```typescript
export const ADMIN_CORS_ORIGIN = "https://admin.megafrixapi.com";

// Headers retornados quando origin === ADMIN_CORS_ORIGIN:
Access-Control-Allow-Origin: https://admin.megafrixapi.com
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, x-admin-token
```

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
| `ADMIN_SECRET_TOKEN` | Token estático para scripts admin |
