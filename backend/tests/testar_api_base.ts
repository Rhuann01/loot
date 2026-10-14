import assert from "node:assert/strict";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";

const api = await iniciarApiDeTeste();

try {
  // (1) GET /api/health autenticado => 200 e json.status "ok"
  const resHealthAuth = await api.req("/api/health");
  assert.equal(resHealthAuth.status, 200);
  assert.deepEqual(resHealthAuth.json, { status: "ok" });

  // (2) GET /api/health sem credenciais => 401
  const resHealthAnon = await api.req("/api/health", {}, false);
  assert.equal(resHealthAnon.status, 401);

  // (3) GET /api/produtos autenticado => 200
  const resProdutosAuth = await api.req("/api/produtos");
  assert.equal(resProdutosAuth.status, 200);

  console.log("Resultado: api base passou");
} finally {
  await api.encerrar();
  process.exit(0);
}
