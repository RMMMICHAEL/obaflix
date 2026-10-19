export const dynamic = "force-dynamic";
export const maxDuration = 60;
import { timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ambienteTesteIsolado } from "@/lib/isolamentoTeste";
import { PLANO_GRATUITO, PLANOS_COMERCIAIS, PLANOS_CORTES, semearPlano, type RepositorioDePlanos } from "@/lib/planos";
import { getFilme, getSerie, getTVSeasonDetails, imgUrl } from "@/lib/tmdb";

// TEMPORÁRIA: preparação única do Neon de TESTE (migration cortesNivel, planos,
// catálogo mínimo real via TMDB, conta de teste). Remover após executar.
const NO_STORE = { "Cache-Control": "no-store" };
const MIGRATION = "20261019120000_plano_cortes_nivel";
const CHECKSUM = "af2a2bf7d8d8fc862d8a6f57a0a6f87a5fca3aea346fd28850cdb4c6f7682bae";
const FILMES = [27205, 157336, 603, 155];
const SERIES = [1396, 66732];
const DOMINIO = "@teste.obaflix.invalid";

function tokenValido(recebido: string | null): boolean {
  const esperado = process.env.PREPARO_TOKEN ?? "";
  if (esperado.length < 32 || !recebido) return false;
  const a = Buffer.from(recebido), b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview" || process.env.OBAFLIX_AMBIENTE !== "teste"
    || process.env.VERCEL_GIT_COMMIT_REF !== "feat/cortes-permissoes") {
    return new NextResponse(null, { status: 404, headers: NO_STORE });
  }
  if (!tokenValido(req.headers.get("x-preparo-token"))) return new NextResponse(null, { status: 404, headers: NO_STORE });
  if (!ambienteTesteIsolado(process.env)) return NextResponse.json({ etapa: "isolamento", ok: false }, { status: 503, headers: NO_STORE });
  const corpo = (await req.json().catch(() => ({}))) as { email?: string; senha?: string };
  if (!corpo.email?.endsWith(DOMINIO) || !corpo.senha || corpo.senha.length < 12) {
    return NextResponse.json({ etapa: "entrada", ok: false }, { status: 400, headers: NO_STORE });
  }

  const relatorio: Record<string, unknown> = {};
  try {
    // 1) Marcador e ausência de dados reais, imediatamente antes de escrever.
    const marcador = await prisma.$queryRawUnsafe<{ ambiente: string }[]>(`SELECT "ambiente" FROM "_ObaflixAmbiente"`);
    if (marcador.length !== 1 || marcador[0].ambiente !== "teste") throw new Error("marcador");
    const [{ fora }] = await prisma.$queryRawUnsafe<{ fora: number }[]>(
      `SELECT count(*)::int AS fora FROM "User" WHERE email NOT LIKE $1`, `%${DOMINIO}`);
    const [{ pagos }] = await prisma.$queryRawUnsafe<{ pagos: number }[]>(
      `SELECT count(*)::int AS pagos FROM "PedidoPagamento" WHERE status = 'PAGO' AND provedor <> 'simulado'`);
    if (fora > 0 || pagos > 0) {
      // Só domínios e provedores (sem e-mails), para decidir se é dado real.
      const dominios = await prisma.$queryRawUnsafe<{ d: string; n: number }[]>(
        `SELECT split_part(email, '@', 2) AS d, count(*)::int AS n FROM "User" WHERE email NOT LIKE $1 GROUP BY 1`, `%${DOMINIO}`);
      const provedores = await prisma.$queryRawUnsafe<{ p: string; n: number }[]>(
        `SELECT provedor AS p, count(*)::int AS n FROM "PedidoPagamento" WHERE status = 'PAGO' AND provedor <> 'simulado' GROUP BY 1`);
      return NextResponse.json({ ok: false, erro: "dados-reais", fora, pagos, dominios, provedores }, { status: 409, headers: NO_STORE });
    }
    relatorio.marcador = "teste";

    // 2) Migration (mesmo SQL do arquivo, idempotente) + registro no histórico do Prisma.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`ALTER TABLE "Plano" ADD COLUMN IF NOT EXISTS "cortesNivel" TEXT NOT NULL DEFAULT 'nenhum'`),
      prisma.$executeRawUnsafe(`ALTER TABLE "Plano" DROP CONSTRAINT IF EXISTS "Plano_cortesNivel_check"`),
      prisma.$executeRawUnsafe(`ALTER TABLE "Plano" ADD CONSTRAINT "Plano_cortesNivel_check" CHECK ("cortesNivel" IN ('nenhum', 'individual', 'lote', 'ia'))`),
    ]);
    const [{ historico }] = await prisma.$queryRawUnsafe<{ historico: boolean }[]>(
      `SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS historico`);
    if (historico) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
         SELECT gen_random_uuid()::text, $1, $2, now(), now(), 1
         WHERE NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $2)`, CHECKSUM, MIGRATION);
    }
    relatorio.migration = { aplicada: true, historico };

    // 3) Planos: cria se faltar (semearPlano); planos de cortes com o nível do código.
    const repo: RepositorioDePlanos = {
      buscar: (id) => prisma.plano.findUnique({ where: { id } }) as Promise<Record<string, unknown> | null>,
      criar: async (plano) => { await prisma.plano.create({ data: plano }); },
    };
    const planos: Record<string, string> = {};
    for (const plano of [PLANO_GRATUITO, ...PLANOS_COMERCIAIS, ...PLANOS_CORTES]) {
      planos[plano.id] = (await semearPlano(repo, plano)).acao;
    }
    for (const plano of PLANOS_CORTES) {
      await prisma.plano.update({ where: { id: plano.id }, data: { cortesNivel: plano.cortesNivel } });
    }
    relatorio.planos = planos;

    // 4) Catálogo mínimo real (TMDB). urlDub marca disponível; as fontes saem do tmdbId.
    let filmes = 0, episodios = 0;
    for (const tmdb of FILMES) {
      const f = await getFilme(tmdb);
      if (!f) throw new Error(`tmdb filme ${tmdb}`);
      const dados = {
        tmdbId: String(tmdb), titulo: f.title ?? f.name ?? "Sem título", sinopse: f.overview ?? null,
        poster: imgUrl(f.poster_path, "w500"), background: imgUrl(f.backdrop_path, "original"),
        ano: f.release_date ? Number(f.release_date.slice(0, 4)) : null, nota: f.vote_average ?? null,
        duracao: f.runtime ?? null, urlDub: `https://superflixapi.beer/filme/${tmdb}`,
      };
      await prisma.filme.upsert({ where: { id: `teste-${tmdb}` }, create: { id: `teste-${tmdb}`, ...dados }, update: dados });
      filmes++;
    }
    for (const tmdb of SERIES) {
      const s = await getSerie(tmdb);
      if (!s) throw new Error(`tmdb serie ${tmdb}`);
      const sid = `teste-${tmdb}`;
      const dados = {
        tmdbId: String(tmdb), titulo: s.name ?? s.title ?? "Sem título", sinopse: s.overview ?? null,
        poster: imgUrl(s.poster_path, "w500"), background: imgUrl(s.backdrop_path, "original"),
        ano: s.first_air_date ? Number(s.first_air_date.slice(0, 4)) : null, nota: s.vote_average ?? null,
        temporadas: 1, tipo: "serie",
      };
      await prisma.serie.upsert({ where: { id: sid }, create: { id: sid, ...dados }, update: dados });
      const temporada = await getTVSeasonDetails(tmdb, 1);
      if (!temporada) throw new Error(`tmdb temporada ${tmdb}`);
      for (const e of temporada.episodes.slice(0, 3)) {
        const eid = `${sid}-s1e${e.episode_number}`;
        const ep = {
          serieId: sid, temporada: 1, numeroEp: e.episode_number, titulo: e.name ?? null,
          thumbnail: imgUrl(e.still_path, "w500"), urlDub: `https://superflixapi.beer/serie/${tmdb}/1/${e.episode_number}`,
        };
        await prisma.episodio.upsert({ where: { id: eid }, create: { id: eid, ...ep }, update: ep });
        episodios++;
      }
    }
    relatorio.catalogo = { filmes, series: SERIES.length, episodios };

    // 5) Conta de teste com UMA assinatura ATIVA de Cortes Pro (cortesia; sem pagamento).
    const senhaHash = await bcrypt.hash(corpo.senha, 10);
    const user = await prisma.user.upsert({
      where: { email: corpo.email }, create: { email: corpo.email, nome: "Teste Cortes Pro", senhaHash }, update: { senhaHash },
    });
    const assinaturaId = `teste-cortes-pro-${user.id}`;
    await prisma.assinatura.updateMany({ where: { userId: user.id, status: "ATIVA", NOT: { id: assinaturaId } }, data: { status: "CANCELADA" } });
    await prisma.assinatura.upsert({
      where: { id: assinaturaId },
      create: { id: assinaturaId, userId: user.id, planoId: "cortes-pro", status: "ATIVA", origem: "cortesia", iniciaEm: new Date(), terminaEm: new Date("2027-12-31") },
      update: { planoId: "cortes-pro", status: "ATIVA", terminaEm: new Date("2027-12-31") },
    });
    relatorio.conta = { plano: "cortes-pro", cortesNivel: "lote" };
    return NextResponse.json({ ok: true, ...relatorio }, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n").pop()?.slice(0, 160) : "erro";
    return NextResponse.json({ ok: false, ...relatorio, erro: msg }, { status: 500, headers: NO_STORE });
  }
}
