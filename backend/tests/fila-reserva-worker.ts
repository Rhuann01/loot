import { existsSync, writeFileSync } from "node:fs";
import { reservarProdutoParaEnvio } from "../src/db/queries.js";

const prontoEm = process.env.LOOT_FILA_PRONTO_EM;
const iniciarEm = process.env.LOOT_FILA_INICIAR_EM;
const resultadoEm = process.env.LOOT_FILA_RESULTADO_EM;

if (!prontoEm || !iniciarEm || !resultadoEm) {
  throw new Error("arquivos de sincronização do teste não configurados");
}

writeFileSync(prontoEm, "pronto");

while (!existsSync(iniciarEm)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const produto = reservarProdutoParaEnvio();
writeFileSync(resultadoEm, JSON.stringify({ produto: produto?.external_product_id ?? null }));
