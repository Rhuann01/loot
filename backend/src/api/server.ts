import express from "express";
import cors from "cors";
import routes from "./routes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api", routes);

export function iniciarServidor() {
  const porta = process.env.PORT ?? 3000;

  app.listen(porta, () => {
    console.log(`servidor rodando na porta ${porta}`);
  });
}