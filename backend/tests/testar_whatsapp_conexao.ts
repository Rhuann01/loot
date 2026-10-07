import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { conectarWhatsApp, getQrCode, getStatusConexao, listarGruposWhatsApp } from "../src/whatsapp/connection.js";

const TEMPO_MAXIMO_MS = 120_000;
const INTERVALO_MS = 1_000;
const caminhoQr = "/tmp/loot-whatsapp-qr.png";

function esperar(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function salvarQrSeDisponivel() {
  const qr = getQrCode().qr;
  if (!qr || !qr.startsWith("data:image/png;base64,")) return false;

  const base64 = qr.replace("data:image/png;base64,", "");
  await writeFile(caminhoQr, Buffer.from(base64, "base64"));
  return true;
}

console.log("Iniciando teste de conexão do WhatsApp...");
console.log("Este teste não envia mensagens.");

await conectarWhatsApp();

const inicio = Date.now();
let qrSalvo = false;
let ultimoEstado = "";

while (Date.now() - inicio < TEMPO_MAXIMO_MS) {
  const status = getStatusConexao();

  if (status.estado !== ultimoEstado) {
    ultimoEstado = status.estado;
    console.log(`Estado: ${status.estado}`);
  }

  if (status.qrDisponivel && !qrSalvo) {
    qrSalvo = await salvarQrSeDisponivel();
    if (qrSalvo) {
      console.log(`QR salvo em: ${caminhoQr}`);
      console.log("Abra esse arquivo e escaneie pelo WhatsApp > Aparelhos conectados.");
    }
  }

  if (status.conectado) {
    console.log("WhatsApp conectado com sucesso.");

    try {
      const grupos = await listarGruposWhatsApp();
      console.log(`Grupos encontrados: ${grupos.length}`);
      for (const grupo of grupos) {
        console.log(`- ${grupo.nome} (${grupo.id})`);
      }
    } catch (erro) {
      console.error("Conectou, mas não foi possível listar os grupos:", erro);
      process.exit(1);
    }

    process.exit(0);
  }

  await esperar(INTERVALO_MS);
}

if (!getStatusConexao().conectado) {
  console.error("Tempo esgotado aguardando a conexão do WhatsApp.");
  process.exit(1);
}
