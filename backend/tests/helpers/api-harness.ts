import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";

export interface ApiDeTeste {
  db: Database.Database;
  req: (caminho: string, init?: RequestInit, autenticado?: boolean) => Promise<{
    status: number;
    json: unknown;
    texto: string;
    headers: Headers;
  }>;
  encerrar: () => Promise<void>;
}

export async function iniciarApiDeTeste(): Promise<ApiDeTeste> {
  const diretorioOriginal = process.cwd();
  const diretorio = mkdtempSync(join(tmpdir(), "loot-api-"));
  process.chdir(diretorio);
  process.env.PAINEL_USER = "teste";
  process.env.PAINEL_SENHA = "senha";
  process.env.CORS_ORIGINS = "http://localhost:5173";

  const { default: db } = await import("../../src/db/index.js");
  const { app } = await import("../../src/api/server.js");
  const servidor = app.listen(0);
  await once(servidor, "listening");
  const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  const basic = `Basic ${Buffer.from("teste:senha").toString("base64")}`;

  async function req(caminho: string, init: RequestInit = {}, autenticado = true) {
    const headers = new Headers(init.headers);
    if (autenticado) headers.set("authorization", basic);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const resposta = await fetch(`${base}${caminho}`, { ...init, headers });
    const texto = await resposta.text();
    let json: unknown = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { /* corpo não-JSON */ }
    return { status: resposta.status, json, texto, headers: resposta.headers };
  }

  async function encerrar() {
    servidor.close();
    db.close();
    process.chdir(diretorioOriginal);
    rmSync(diretorio, { recursive: true, force: true });
  }
  return { db, req, encerrar };
}
