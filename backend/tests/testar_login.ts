// tests/testar_login.ts
import { fazerLoginMercadoLivre } from "../src/affiliate/login.js";

const resultado = await fazerLoginMercadoLivre(
  "seu_email_de_teste@exemplo.com",
  "sua_senha_de_teste",
);

console.log("cookies capturados:", resultado);