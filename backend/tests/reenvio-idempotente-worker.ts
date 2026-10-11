import { existsSync, writeFileSync } from "node:fs";
import { iniciarEnvioManualIdempotente } from "../src/db/queries.js";

const prontoEm = process.env.LOOT_REENVIO_PRONTO_EM;
const iniciarEm = process.env.LOOT_REENVIO_INICIAR_EM;
const resultadoEm = process.env.LOOT_REENVIO_RESULTADO_EM;
const produtoId = Number(process.env.LOOT_REENVIO_PRODUTO_ID);
const chave = process.env.LOOT_REENVIO_CHAVE;

if (!prontoEm || !iniciarEm || !resultadoEm || !Number.isInteger(produtoId) || !chave) {
  throw new Error("arquivos de sincronização do teste não configurados");
}

writeFileSync(prontoEm, "pronto");
while (!existsSync(iniciarEm)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const resultado = iniciarEnvioManualIdempotente(produtoId, chave);
if (resultado.tipo === "conflito") {
  throw new Error("a chave concorrente não deveria conflitar com o mesmo produto");
}
if (resultado.tipo === "ausente") {
  throw new Error("o produto concorrente deveria existir");
}
writeFileSync(
  resultadoEm,
  JSON.stringify({
    tipo: resultado.tipo,
    tentativaId:
      resultado.tipo === "nova"
        ? resultado.reserva.tentativa.id
        : resultado.tentativa.id,
  }),
);
