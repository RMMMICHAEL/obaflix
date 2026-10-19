/**
 * Pré-condição do Preview isolado de testes, decidida SÓ pelas variáveis — antes
 * de qualquer conexão. Se uma URL de banco ou Redis não for a do recurso de
 * teste (`OBAFLIX_TESTE_*`, do Neon/Upstash de teste), ninguém conecta: assim a
 * verificação nunca toca Production, nem para ler.
 */
type Env = Record<string, string | undefined>;

const host = (url: string | undefined) => {
  try { return url ? new URL(url).hostname : null; } catch { return null; }
};
/** Pooled e unpooled do Neon diferem só no sufixo `-pooler` do endpoint. */
const endpointNeon = (url: string | undefined) => host(url)?.replace(/-pooler(?=\.)/, "") ?? null;

export function ambienteTesteIsolado(env: Env): boolean {
  const neon = endpointNeon(env.OBAFLIX_TESTE_DATABASE_URL_UNPOOLED);
  return env.VERCEL_ENV === "preview"
    && env.OBAFLIX_AMBIENTE === "teste"
    && !!neon && neon.endsWith(".neon.tech")
    && endpointNeon(env.DATABASE_URL) === neon
    && endpointNeon(env.DIRECT_URL) === neon
    && !!host(env.OBAFLIX_TESTE_KV_REST_API_URL)?.endsWith(".upstash.io")
    && env.UPSTASH_REDIS_REST_URL === env.OBAFLIX_TESTE_KV_REST_API_URL
    && !!env.UPSTASH_REDIS_REST_TOKEN && env.UPSTASH_REDIS_REST_TOKEN === env.OBAFLIX_TESTE_KV_REST_API_TOKEN
    && env.MONETIZACAO_ATIVA !== "true" && env.BLACKCAT_PIX_ATIVO !== "true";
}
