import { existsSync, writeFileSync } from "node:fs";
import { executarEnvioProtegido } from "../src/whatsapp/dispatch.js";

const prontoEm = process.env.LOOT_ENVIO_PRONTO_EM;
const iniciarEm = process.env.LOOT_ENVIO_INICIAR_EM;
const resultadoEm = process.env.LOOT_ENVIO_RESULTADO_EM;

if (!prontoEm || !iniciarEm || !resultadoEm) {
  throw new Error("arquivos de sincronização do teste não configurados");
}

writeFileSync(prontoEm, "pronto");
while (!existsSync(iniciarEm)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

let inicio = 0;
let fim = 0;
await executarEnvioProtegido(async ({ aguardarIntervaloAntesDaMensagem }) => {
  await aguardarIntervaloAntesDaMensagem();
  inicio = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  fim = Date.now();
});
writeFileSync(resultadoEm, JSON.stringify({ inicio, fim }));
