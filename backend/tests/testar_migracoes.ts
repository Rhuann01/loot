import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const diretorioOriginal = process.cwd();
const diretorioTeste = mkdtempSync(join(tmpdir(), "loot-migracoes-"));
process.chdir(diretorioTeste);

const { default: db, aplicarMigracao } = await import("../src/db/index.js");

try {
  // (1) Assert que schema_migrations tem a versão 1 "baseline"
  const migracao1 = db
    .prepare("SELECT * FROM schema_migrations WHERE versao = 1")
    .get() as { versao: number; nome: string } | undefined;
  assert.ok(migracao1, "migração baseline (versão 1) deve existir");
  assert.equal(migracao1.versao, 1);
  assert.equal(migracao1.nome, "baseline");

  // (2) aplicarMigracao(900,"teste",fn) chama fn uma vez e devolve true
  let contador900 = 0;
  const sucesso1 = aplicarMigracao(900, "teste", () => {
    contador900++;
  });
  assert.equal(sucesso1, true);
  assert.equal(contador900, 1);

  // Segunda chamada devolve false e fn NÃO roda de novo
  const sucesso2 = aplicarMigracao(900, "teste", () => {
    contador900++;
  });
  assert.equal(sucesso2, false);
  assert.equal(contador900, 1);

  // (3) Migração que lança erro dentro de aplicar NÃO grava a versão (rollback) — use versão 901
  assert.throws(
    () => {
      aplicarMigracao(901, "falha", () => {
        throw new Error("erro simulado na migração");
      });
    },
    /erro simulado na migração/,
  );
  const migracao901 = db
    .prepare("SELECT 1 FROM schema_migrations WHERE versao = 901")
    .get();
  assert.equal(migracao901, undefined, "migração falha não deve ser gravada");

  console.log("Resultado: migracoes passou");
} finally {
  db.close();
  process.chdir(diretorioOriginal);
  rmSync(diretorioTeste, { recursive: true, force: true });
}
