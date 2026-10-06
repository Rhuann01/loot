import crypto from "node:crypto";

const ALGORITMO = "aes-256-gcm";
const CHAVE = Buffer.from(process.env.ENCRYPTION_KEY as string, "hex");

export function criptografar(texto: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITMO, CHAVE, iv);

  let criptografado = cipher.update(texto, "utf8", "hex");
  criptografado += cipher.final("hex");

  const tag = cipher.getAuthTag().toString("hex");

  // junta tudo numa string só, separada por ":", pra facilitar guardar no banco
  return `${iv.toString("hex")}:${tag}:${criptografado}`;
}

export function descriptografar(valorCriptografado: string): string {
  const partes = valorCriptografado.split(":");

  if (partes.length !== 3) {
    throw new Error("formato de dado criptografado inválido");
  }

  const [ivHex, tagHex, dados] = partes as [string, string, string];

  const decipher = crypto.createDecipheriv(
    ALGORITMO,
    CHAVE,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  let texto = decipher.update(dados, "hex", "utf8");
  texto += decipher.final("utf8");

  return texto;
}