-- Pareamento de TV: aparelho pareado e refresh token.
-- Aditiva: duas tabelas novas, nenhuma coluna alterada, nenhum dado tocado.
--
-- Deliberadamente NAO inclui o indice unico de Episodio que aparece no
-- `prisma migrate diff`. Aquilo e divergencia antiga entre o schema e o banco,
-- nao tem relacao com esta mudanca, e criar UNIQUE sobre uma tabela grande que
-- pode ter duplicatas e outra decisao — com outro risco e outra janela.

CREATE TABLE IF NOT EXISTS "TvDevice" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "nome"        TEXT NOT NULL,
    "modelo"      TEXT,
    -- SHA-256 de androidId + modelo. Nunca o identificador em claro.
    "fingerprint" TEXT NOT NULL,
    "criadoEm"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimoUso"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Faixa de rede (/24), nao o IP. O suficiente para reconhecer o aparelho.
    "ultimaRede"  TEXT,
    "revogadoEm"  TIMESTAMP(3),

    CONSTRAINT "TvDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TvRefreshToken" (
    "id"         TEXT NOT NULL,
    -- SHA-256 do token opaco. Vazamento de backup nao entrega credencial.
    "tokenHash"  TEXT NOT NULL,
    "deviceId"   TEXT NOT NULL,
    -- Familia da rotacao: reuso de um token derruba a familia inteira.
    "familia"    TEXT NOT NULL,
    "criadoEm"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiraEm"   TIMESTAMP(3) NOT NULL,
    "usadoEm"    TIMESTAMP(3),
    "revogadoEm" TIMESTAMP(3),

    CONSTRAINT "TvRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TvDevice_userId_idx" ON "TvDevice"("userId");

-- Reparear a mesma TV atualiza a linha existente em vez de acumular aparelhos.
CREATE UNIQUE INDEX IF NOT EXISTS "TvDevice_userId_fingerprint_key"
    ON "TvDevice"("userId", "fingerprint");

CREATE UNIQUE INDEX IF NOT EXISTS "TvRefreshToken_tokenHash_key"
    ON "TvRefreshToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "TvRefreshToken_deviceId_idx" ON "TvRefreshToken"("deviceId");
CREATE INDEX IF NOT EXISTS "TvRefreshToken_familia_idx"  ON "TvRefreshToken"("familia");

-- CASCADE nos dois: apagar a conta leva os aparelhos, apagar o aparelho leva os
-- refresh tokens. Nao deve sobrar credencial orfa de uma conta que nao existe.
ALTER TABLE "TvDevice"
    DROP CONSTRAINT IF EXISTS "TvDevice_userId_fkey";
ALTER TABLE "TvDevice"
    ADD CONSTRAINT "TvDevice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TvRefreshToken"
    DROP CONSTRAINT IF EXISTS "TvRefreshToken_deviceId_fkey";
ALTER TABLE "TvRefreshToken"
    ADD CONSTRAINT "TvRefreshToken_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "TvDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
