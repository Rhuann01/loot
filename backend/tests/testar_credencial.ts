// tests/testar_credencial.ts
import "dotenv/config";
import { salvarCredencialML, buscarCredencialML } from "../src/db/queries.js";
import { criptografar } from "../src/affiliate/crypto.js";
import { renovarCookies } from "../src/affiliate/renovar.js";

const existente = buscarCredencialML();

if (!existente) {
  const senhaCriptografada = criptografar("SUA_SENHA_AQUI");
  salvarCredencialML("seu_email@exemplo.com", senhaCriptografada);
  console.log("credencial salva");
}

console.log("renovando cookies...");
const resultado = await renovarCookies();
console.log("cookies capturados:", resultado);