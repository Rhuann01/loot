import assert from "node:assert/strict";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";

const api = await iniciarApiDeTeste();

try {
  // 1. /api/auth/me sem autenticação deve retornar 401
  const resMeSemAuth = await api.req("/api/auth/me", {}, false);
  assert.equal(resMeSemAuth.status, 401, "me sem auth deve ser 401");

  // 1b. CORS com credentials: true deve permitir envio de cookies
  const resCors = await api.req(
    "/api/auth/me",
    {
      headers: { Origin: "http://localhost:5173" },
    },
    false,
  );
  assert.equal(
    resCors.headers.get("access-control-allow-credentials"),
    "true",
    "CORS deve retornar access-control-allow-credentials: true",
  );

  // 2. Login com senha incorreta deve retornar 401
  const resLoginInvalido = await api.req(
    "/api/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ usuario: "teste", senha: "senha_errada" }),
    },
    false,
  );
  assert.equal(resLoginInvalido.status, 401, "senha errada deve retornar 401");

  // 3. Login com credenciais válidas deve retornar 200 e Set-Cookie
  const resLoginValido = await api.req(
    "/api/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ usuario: "teste", senha: "senha" }),
    },
    false,
  );
  assert.equal(resLoginValido.status, 200, "credenciais válidas devem retornar 200");
  const cookieHeader = resLoginValido.headers.get("set-cookie");
  assert.ok(cookieHeader, "resposta de login deve conter cabeçalho set-cookie");
  assert.ok(cookieHeader.includes("loot_session="), "cookie deve conter loot_session");
  assert.ok(cookieHeader.includes("HttpOnly"), "cookie deve ter flag HttpOnly");
  assert.ok(cookieHeader.includes("SameSite=Strict"), "cookie deve ter flag SameSite=Strict");

  // Extrair valor do cookie
  const matchCookie = cookieHeader.match(/loot_session=([^;]+)/);
  assert.ok(matchCookie, "deve extrair valor do cookie");
  const cookieVal = matchCookie[1];

  // 4. Chamar rota protegida usando apenas o cookie
  const resProtegidaComCookie = await api.req(
    "/api/produtos",
    {
      headers: { Cookie: `loot_session=${cookieVal}` },
    },
    false,
  );
  assert.equal(resProtegidaComCookie.status, 200, "rota protegida deve aceitar cookie");

  // 5. /api/auth/me com cookie retorna status do usuário
  const resMeComCookie = await api.req(
    "/api/auth/me",
    {
      headers: { Cookie: `loot_session=${cookieVal}` },
    },
    false,
  );
  assert.equal(resMeComCookie.status, 200);
  assert.equal((resMeComCookie.json as any).autenticado, true);
  assert.equal((resMeComCookie.json as any).usuario, "teste");

  // 5b. Rota protegida com token forjado/inexistente deve retornar 401
  const resTokenFalso = await api.req(
    "/api/produtos",
    {
      headers: { Cookie: "loot_session=token_forjado_e_inexistente_123" },
    },
    false,
  );
  assert.equal(resTokenFalso.status, 401, "cookie forjado deve ser rejeitado com 401");

  // 6. Testar Rate Limiting no Login (estourar quota de 5 erros)
  let bateuRateLimit = false;
  for (let i = 0; i < 7; i++) {
    const resTentativa = await api.req(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ usuario: "invasor", senha: `tentativa_${i}` }),
      },
      false,
    );
    if (resTentativa.status === 429) {
      bateuRateLimit = true;
      assert.equal((resTentativa.json as any).error.code, "MUITAS_REQUISICOES");
      break;
    }
  }
  assert.ok(bateuRateLimit, "deve disparar 429 após exceder tentativas de login");

  // 7. Logout invalida a sessão
  const resLogout = await api.req(
    "/api/auth/logout",
    {
      method: "POST",
      headers: { Cookie: `loot_session=${cookieVal}` },
    },
    false,
  );
  assert.equal(resLogout.status, 200);
  const clearCookieHeader = resLogout.headers.get("set-cookie");
  assert.ok(clearCookieHeader?.includes("loot_session="), "logout deve limpar cookie");

  // 8. Rota protegida com token após logout deve retornar 401
  const resPosLogout = await api.req(
    "/api/produtos",
    {
      headers: { Cookie: `loot_session=${cookieVal}` },
    },
    false,
  );
  assert.equal(resPosLogout.status, 401, "token deslogado deve ser rejeitado");

  console.log("Resultado: testes de auth e rate limit passaram com sucesso");
} finally {
  await api.encerrar();
}
