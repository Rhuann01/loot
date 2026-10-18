import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import routes from "./routes.js";
import { enviarErro } from "./respostas.js";
import { generalLimiter } from "./rate-limiters.js";
import { limparSessoesExpiradas } from "../db/queries.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin: (origem, callback) => {
    if (!origem) {
      callback(null, true);
      return;
    }

    const origensPermitidas = (process.env.CORS_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (origensPermitidas.includes(origem)) {
      callback(null, true);
      return;
    }

    const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
    const ehDev = nodeEnv === "development" || !process.env.NODE_ENV;
    if (ehDev) {
      try {
        const url = new URL(origem);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          callback(null, true);
          return;
        }
      } catch {
        // Ignora erro de parsing de URL
      }
    }

    callback(new Error("origem não autorizada pelo CORS"));
  },
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json());

function resolverDistFrontend(): string | null {
  const candidatos = [
    path.resolve(__dirname, "../../../frontend/dist"),
    path.resolve(__dirname, "../../../../frontend/dist"),
    path.resolve(process.cwd(), "frontend/dist"),
    path.resolve(process.cwd(), "../frontend/dist"),
  ];
  return candidatos.find((caminho) => fs.existsSync(caminho)) ?? null;
}

app.use("/api", generalLimiter);
app.use("/api", routes);

const distFrontend = resolverDistFrontend();
if (distFrontend) {
  app.use(express.static(distFrontend));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) {
      return res.sendFile(path.join(distFrontend, "index.html"));
    }
    next();
  });
}

app.use((_req, res) => {
  enviarErro(res, 404, "NAO_ENCONTRADO", "rota não encontrada");
});

function sanitizarParaLog(dado: unknown, visitados = new WeakSet<object>()): unknown {
  if (!dado || typeof dado !== "object") return dado;
  if (visitados.has(dado)) return "[circular]";
  visitados.add(dado);
  if (dado instanceof Error) {
    let msg = dado.message;
    msg = msg.replace(/basic\s+[a-z0-9+/=]+/gi, "Basic [redigido]");
    msg = msg.replace(/bearer\s+[a-z0-9_.-]+/gi, "Bearer [redigido]");
    msg = msg.replace(/(senha|password|token|secret|cookie|apiKey)=[^&\s]+/gi, "$1=[redigido]");
    return { name: dado.name, message: msg, stack: dado.stack?.split("\n").slice(0, 3).join("\n") };
  }
  const limpo: Record<string, unknown> = (Array.isArray(dado) ? [] : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(dado as Record<string, unknown>)) {
    if (/senha|password|token|cookie|authorization|secret|apiKey/i.test(k)) {
      limpo[k] = "[redigido]";
    } else {
      limpo[k] = typeof v === "object" ? sanitizarParaLog(v, visitados) : v;
    }
  }
  return limpo;
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const erro = err as { message?: string; type?: string };
  if (erro?.message === "origem não autorizada pelo CORS") {
    return enviarErro(res, 403, "ORIGEM_NAO_AUTORIZADA", "origem não autorizada pelo CORS");
  }
  if (erro?.type === "entity.parse.failed") {
    return enviarErro(res, 400, "JSON_INVALIDO", "JSON inválido");
  }
  console.error("erro não tratado:", sanitizarParaLog(err));
  return enviarErro(res, 500, "ERRO_INTERNO", "erro interno");
});

export function iniciarServidor() {
  try {
    limparSessoesExpiradas();
  } catch (erro) {
    console.error("falha ao limpar sessões expiradas na inicialização:", erro);
  }

  const porta = process.env.PORT ?? 3000;

  return app.listen(porta, () => {
    console.log(`servidor rodando na porta ${porta}`);
  });
}
