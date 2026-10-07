import "dotenv/config";
import { conectarWhatsApp } from "./whatsapp/connection.js";
import { iniciarScheduler } from "./auto/scheduler.js";
import { iniciarServidor } from "./api/server.js";

async function iniciar(): Promise<void> {
  console.log("iniciando Loot...");

  iniciarScheduler();
  console.log("scheduler ativo, aguardando horários programados");

  iniciarServidor();
  console.log("API disponível enquanto o WhatsApp conecta...");

  void conectarWhatsApp()
    .then(() => console.log("WhatsApp conectando..."))
    .catch((erro: unknown) => {
      console.error("falha ao iniciar o WhatsApp; a API continuará disponível:", erro);
    });
}

iniciar().catch((erro: unknown) => {
  console.error("falha ao iniciar o Loot:", erro);
  process.exitCode = 1;
});
