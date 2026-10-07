
import { mergeCookies } from "../src/affiliate/mercadolivre/cookies.js";

let passou = 0;
let falhou = 0;

function assert(descricao: string, condicao: boolean) {
  if (condicao) {
    console.log(`   ${descricao}`);
    passou++;
  } else {
    console.error(`   FALHOU: ${descricao}`);
    falhou++;
  }
}

function cookieTemValor(cookie: string, nome: string, valor: string): boolean {
  return cookie.split(";").some((p) => {
    const [k, v] = p.trim().split("=");
    return k === nome && v === valor;
  });
}

function cookieTemNome(cookie: string, nome: string): boolean {
  return cookie.split(";").some((p) => p.trim().split("=")[0] === nome);
}

// ---------------------------------------------------------------
console.log("\n1. Substituição — cookie existente é atualizado");
{
  const atual = "_mldataSessionId=abc123; _d2id=xyz";
  const setCookies = ["_mldataSessionId=novo999; Max-Age=1800; Path=/; Secure"];
  const resultado = mergeCookies(atual, setCookies);

  assert(
    "_mldataSessionId foi atualizado para novo999",
    cookieTemValor(resultado, "_mldataSessionId", "novo999"),
  );
  assert(
    "_d2id permanece presente",
    cookieTemNome(resultado, "_d2id"),
  );
}

// ---------------------------------------------------------------
console.log("\n2. Adição — cookie novo é inserido no jar");
{
  const atual = "_d2id=xyz";
  const setCookies = ["_mldataSessionId=fresh; Max-Age=1800; Path=/"];
  const resultado = mergeCookies(atual, setCookies);

  assert(
    "_mldataSessionId=fresh foi adicionado",
    cookieTemValor(resultado, "_mldataSessionId", "fresh"),
  );
  assert(
    "_d2id ainda está presente",
    cookieTemNome(resultado, "_d2id"),
  );
}

// ---------------------------------------------------------------
console.log("\n3a. Remoção por Max-Age=0");
{
  const atual = "_mldataSessionId=abc123; _d2id=xyz";
  const setCookies = ["_mldataSessionId=; Max-Age=0; Path=/"];
  const resultado = mergeCookies(atual, setCookies);

  assert(
    "_mldataSessionId removido por Max-Age=0",
    !cookieTemNome(resultado, "_mldataSessionId"),
  );
  assert(
    "_d2id ainda está presente",
    cookieTemNome(resultado, "_d2id"),
  );
}

// ---------------------------------------------------------------
console.log("\n3b. Remoção por Expires no passado");
{
  const passado = new Date(Date.now() - 60_000).toUTCString();
  const atual = "_mldataSessionId=abc123; _d2id=xyz";
  const setCookies = [`_mldataSessionId=old; Expires=${passado}; Path=/`];
  const resultado = mergeCookies(atual, setCookies);

  assert(
    "_mldataSessionId removido por Expires no passado",
    !cookieTemNome(resultado, "_mldataSessionId"),
  );
  assert(
    "_d2id ainda está presente",
    cookieTemNome(resultado, "_d2id"),
  );
}

// ---------------------------------------------------------------
console.log("\n4. Cookie inicial vazio + Set-Cookie novo");
{
  const atual = "";
  const setCookies = ["sid=abc; Max-Age=3600; Path=/"];
  const resultado = mergeCookies(atual, setCookies);

  assert(
    "sid=abc foi adicionado a partir de jar vazio",
    cookieTemValor(resultado, "sid", "abc"),
  );
}

// ---------------------------------------------------------------
console.log("\n5. Múltiplos Set-Cookie de uma vez");
{
  const atual = "a=1; b=2";
  const setCookies = [
    "a=99; Max-Age=3600; Path=/",
    "c=3; Max-Age=3600; Path=/",
    "b=; Max-Age=0; Path=/",
  ];
  const resultado = mergeCookies(atual, setCookies);

  assert("a atualizado para 99", cookieTemValor(resultado, "a", "99"));
  assert("c=3 adicionado", cookieTemValor(resultado, "c", "3"));
  assert("b removido por Max-Age=0", !cookieTemNome(resultado, "b"));
}

// ---------------------------------------------------------------
console.log(
  `\nResultado: ${passou} passou, ${falhou} falhou`,
);

if (falhou > 0) process.exit(1);
