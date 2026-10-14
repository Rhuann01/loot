import assert from "node:assert/strict";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";
import { envelopeLista } from "../src/api/respostas.js";

const api = await iniciarApiDeTeste();

try {
  // (1) Rota inexistente autenticada => 404 com json.error.code "NAO_ENCONTRADO"
  const rInexistente = await api.req("/api/rota_inexistente_teste");
  assert.equal(rInexistente.status, 404);
  assert.equal(
    (rInexistente.json as { error: { code: string } })?.error?.code,
    "NAO_ENCONTRADO",
  );

  // (2) Sem credenciais => 401 e json.error.code "NAO_AUTENTICADO"
  const rSemCred = await api.req("/api/health", {}, false);
  assert.equal(rSemCred.status, 401);
  assert.equal(
    (rSemCred.json as { error: { code: string } })?.error?.code,
    "NAO_AUTENTICADO",
  );

  // (3) POST /api/whatsapp/reconnect com corpo JSON malformado ("{") => 400 JSON_INVALIDO
  const rJsonInvalido = await api.req("/api/whatsapp/reconnect", {
    method: "POST",
    body: "{",
  });
  assert.equal(rJsonInvalido.status, 400);
  assert.equal(
    (rJsonInvalido.json as { error: { code: string } })?.error?.code,
    "JSON_INVALIDO",
  );

  // (4) PUT /api/whatsapp/group com {} => 400 e json.error.code "PARAMETRO_INVALIDO"
  const rPutGrupo = await api.req("/api/whatsapp/group", {
    method: "PUT",
    body: JSON.stringify({}),
  });
  assert.equal(rPutGrupo.status, 400);
  assert.equal(
    (rPutGrupo.json as { error: { code: string } })?.error?.code,
    "PARAMETRO_INVALIDO",
  );

  // (5) POST /api/produtos/1/reenviar sem header Idempotency-Key => 400 PARAMETRO_INVALIDO
  const rReenviar = await api.req("/api/produtos/1/reenviar", {
    method: "POST",
  });
  assert.equal(rReenviar.status, 400);
  assert.equal(
    (rReenviar.json as { error: { code: string } })?.error?.code,
    "PARAMETRO_INVALIDO",
  );

  // (6) envelopeLista([1,2],1,20,2) deepEqual {items:[1,2],page:1,limit:20,total:2}
  assert.deepEqual(envelopeLista([1, 2], 1, 20, 2), {
    items: [1, 2],
    page: 1,
    limit: 20,
    total: 2,
  });

  console.log("Resultado: api formato passou");
} finally {
  await api.encerrar();
  process.exit(0);
}
