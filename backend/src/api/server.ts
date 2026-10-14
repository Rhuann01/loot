import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import routes from "./routes.js";
import { enviarErro } from "./respostas.js";

export const app = express();

const origensPermitidas = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origem) => origem.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origem, callback) => {
    if (!origem || origensPermitidas.includes(origem)) {
      callback(null, true);
      return;
    }

    callback(new Error("origem não autorizada pelo CORS"));
  },
}));
app.use(express.json());

app.use("/api", routes);

app.use((_req, res) => {
  enviarErro(res, 404, "NAO_ENCONTRADO", "rota não encontrada");
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const erro = err as { message?: string; type?: string };
  if (erro?.message === "origem não autorizada pelo CORS") {
    return enviarErro(res, 403, "ORIGEM_NAO_AUTORIZADA", "origem não autorizada pelo CORS");
  }
  if (erro?.type === "entity.parse.failed") {
    return enviarErro(res, 400, "JSON_INVALIDO", "JSON inválido");
  }
  console.error("erro não tratado:", err);
  return enviarErro(res, 500, "ERRO_INTERNO", "erro interno");
});

export function iniciarServidor() {
  const porta = process.env.PORT ?? 3000;

  return app.listen(porta, () => {
    console.log(`servidor rodando na porta ${porta}`);
  });
}
