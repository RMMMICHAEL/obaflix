-- Direito de cortes de cena no Plano: separa recorte de trecho do download
-- completo (coluna `downloads`). Ordenado: nenhum < individual < lote < ia.
--
-- NOT NULL com DEFAULT 'nenhum' num ADD COLUMN é reescrita barata e segura: toda
-- linha existente recebe 'nenhum' (restritivo) — nenhum plano passa a conceder
-- corte por acidente. Ordem expand/contract: aplicar ANTES de publicar o código
-- que lê a coluna (o select de entitlements já a inclui).
ALTER TABLE "Plano" ADD COLUMN IF NOT EXISTS "cortesNivel" TEXT NOT NULL DEFAULT 'nenhum';

-- DROP + ADD como os demais CHECK desta base: o ADD revalida as linhas existentes.
ALTER TABLE "Plano" DROP CONSTRAINT IF EXISTS "Plano_cortesNivel_check";
ALTER TABLE "Plano" ADD CONSTRAINT "Plano_cortesNivel_check"
    CHECK ("cortesNivel" IN ('nenhum', 'individual', 'lote', 'ia'));
