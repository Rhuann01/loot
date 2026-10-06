import { buscarCredencialML, atualizarCookiesML } from "../db/queries.js";
import { descriptografar } from "./crypto.js";
import { fazerLoginMercadoLivre } from "./login.js";

export async function renovarCookies() {
  const credencial = buscarCredencialML();

  if (!credencial) {
    throw new Error("nenhuma credencial do Mercado Livre cadastrada");
  }

  const senha = descriptografar(credencial.senha_criptografada);

  const { csrf, d2id } = await fazerLoginMercadoLivre(credencial.email, senha);

  atualizarCookiesML(credencial.id, csrf, d2id);

  console.log("cookies do Mercado Livre renovados com sucesso");

  return { csrf, d2id };
}   