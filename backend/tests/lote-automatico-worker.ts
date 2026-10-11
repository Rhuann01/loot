import { existsSync, writeFileSync } from "node:fs";
import { tentarExecutarLoteAutomatico } from "../src/whatsapp/dispatch.js";

const prontoEm = process.env.LOOT_LOTE_PRONTO_EM;
const iniciarEm = process.env.LOOT_LOTE_INICIAR_EM;
const resultadoEm = process.env.LOOT_LOTE_RESULTADO_EM;

if (!prontoEm || !iniciarEm || !resultadoEm) {
  throw new Error("arquivos de sincronização do teste não configurados");
}

writeFileSync(prontoEm, "pronto");
while (!existsSync(iniciarEm)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const resultado = await tentarExecutarLoteAutomatico(async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return true;
});
writeFileSync(resultadoEm, JSON.stringify({ executou: resultado === true }));
