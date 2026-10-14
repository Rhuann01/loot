import "dotenv/config";
import { conectarWhatsApp } from "./whatsapp/connection.js";
import { iniciarScheduler } from "./auto/scheduler.js";
import { iniciarServidor } from "./api/server.js";

export function validarCredenciaisInicializacao(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  const ehLocal = nodeEnv === "development" || nodeEnv === "test";

  const user = (env.PAINEL_USER ?? "").trim();
  const senha = (env.PAINEL_SENHA ?? "").trim();

  if (!ehLocal && user === "admin" && senha === "admin") {
    throw new Error(
      "Credenciais padrão (admin/admin) não são permitidas fora do ambiente local por motivos de segurança.",
    );
  }
}

async function iniciar(): Promise<void> {
  validarCredenciaisInicializacao();

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

// Executa iniciar apenas se este for o arquivo principal
const ehExecucaoDireta =
  process.argv[1] &&
  (process.argv[1].endsWith("/src/index.ts") ||
    process.argv[1].endsWith("/src/index.js") ||
    process.argv[1].endsWith("/dist/src/index.js"));

if (ehExecucaoDireta) {
  iniciar().catch((erro: unknown) => {
    console.error("falha ao iniciar o Loot:", erro instanceof Error ? erro.message : erro);
    process.exitCode = 1;
  });
}
