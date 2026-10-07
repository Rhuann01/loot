import express from "express";
import cors from "cors";
import routes from "./routes.js";

const app = express();

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

export function iniciarServidor() {
  const porta = process.env.PORT ?? 3000;

  app.listen(porta, () => {
    console.log(`servidor rodando na porta ${porta}`);
  });
}
