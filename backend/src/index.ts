import "dotenv/config";
import { conectarWhatsApp } from "./whatsapp/connection.js";
import { iniciarScheduler } from "./auto/scheduler.js";
import { iniciarServidor } from "./api/server.js";

async function iniciar() {
  console.log("iniciando Loot...");

  await conectarWhatsApp();
  console.log("WhatsApp conectando...");

  iniciarScheduler();
  console.log("scheduler ativo, aguardando horários programados");

  iniciarServidor();
}

iniciar();
