import assert from "node:assert/strict";
import test from "node:test";
import { canRoleSignInToSurface, getObaflixSurface, isAllowedOnAdminSurface, isLegacyAdminPath, publicCutoverEnabled } from "../../config/obaflix-surface";
import { catalogTokenMatches, catalogTokenScopeAllows } from "../catalogSyncAuth";

test("surface defaults to public and cutover remains off by default", () => {
  assert.equal(getObaflixSurface(undefined), "public");
  assert.equal(publicCutoverEnabled(undefined), false);
  assert.equal(publicCutoverEnabled("true"), true);
  assert.equal(isLegacyAdminPath("/admin"), true);
  assert.equal(isLegacyAdminPath("/api/admin/users"), true);
});

test("admin surface exposes only login, admin and catalog integration", () => {
  assert.equal(isAllowedOnAdminSurface("/admin"), true);
  assert.equal(isAllowedOnAdminSurface("/login"), true);
  assert.equal(isAllowedOnAdminSurface("/api/integracoes/catalogo/filme"), true);
  assert.equal(isAllowedOnAdminSurface("/filmes"), false);
  assert.equal(isAllowedOnAdminSurface("/api/billing/me"), false);
});

test("non-admin cannot sign in to admin surface and admin can", () => {
  assert.equal(canRoleSignInToSurface("user", "admin"), false);
  assert.equal(canRoleSignInToSurface("admin", "admin"), true);
  assert.equal(canRoleSignInToSurface("user", "public"), true);
});

test("catalog token is timing-safe, strong and scoped away from human admin APIs", () => {
  const token = "a".repeat(40);
  assert.equal(catalogTokenMatches(token, token), true);
  assert.equal(catalogTokenMatches("short", token), false);
  assert.equal(catalogTokenScopeAllows("/api/integracoes/catalogo/serie"), true);
  for (const path of ["/api/admin/usuarios", "/api/admin/reset-password", "/api/admin/assinaturas"]) {
    assert.equal(catalogTokenScopeAllows(path), false, path);
  }
});
