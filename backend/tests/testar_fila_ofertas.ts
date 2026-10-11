import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const diretorioOriginal = process.cwd();
const diretorioTeste = mkdtempSync(join(tmpdir(), "loot-fila-"));
process.chdir(diretorioTeste);

const { default: db } = await import("../src/db/index.js");
const {
  salvarProduto,
  reservarProdutoParaEnvio,
  setConfig,
} = await import("../src/db/queries.js");

function limparBanco() {
  db.exec("DELETE FROM tentativas_de_envio; DELETE FROM envios; DELETE FROM produtos;");
  setConfig("desconto_minimo_global", "20");
  setConfig("janela_fallback_dias", "3");
  setConfig("limite_diario", "12");
}

function criarProduto(
  id: string,
  desconto: number,
  selecionado = false,
): number {
  salvarProduto({
    source_key: "mercado_livre",
    external_product_id: id,
    nome: `Produto ${id}`,
    preco_atual: "80",
    preco_original: "100",
    desconto_percentual: desconto,
    link_afiliado: `https://example.test/${id}`,
  });

  const produto = db
    .prepare("SELECT id FROM produtos WHERE external_product_id = ?")
    .get(id) as { id: number };
  if (selecionado) {
    db.prepare("UPDATE produtos SET selecionado = 1 WHERE id = ?").run(produto.id);
  }
  return produto.id;
}

async function esperarArquivo(caminho: string) {
  for (let tentativa = 0; tentativa < 100; tentativa++) {
    if (existsSync(caminho)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`processo de teste não ficou pronto: ${caminho}`);
}

function executarReservaEmProcesso(
  prontoEm: string,
  iniciarEm: string,
  resultadoEm: string,
): Promise<void> {
  const worker = new URL("./fila-reserva-worker.js", import.meta.url).pathname;
  const processo = spawn(process.execPath, [worker], {
    cwd: diretorioTeste,
    env: {
      ...process.env,
      LOOT_FILA_PRONTO_EM: prontoEm,
      LOOT_FILA_INICIAR_EM: iniciarEm,
      LOOT_FILA_RESULTADO_EM: resultadoEm,
    },
  });
  let erro = "";
  processo.stderr.on("data", (chunk) => {
    erro += String(chunk);
  });

  return new Promise((resolve, reject) => {
    processo.once("error", reject);
    processo.once("close", (codigo) => {
      if (codigo === 0) resolve();
      else reject(new Error(`worker de reserva falhou (${codigo}): ${erro}`));
    });
  });
}

try {
  limparBanco();
  criarProduto("MLB-MAIOR-DESCONTO", 60);
  criarProduto("MLB-SELECIONADO", 25, true);
  assert.equal(
    reservarProdutoParaEnvio()?.external_product_id,
    "MLB-SELECIONADO",
    "produto selecionado elegível deve ter preferência sobre desconto maior",
  );

  limparBanco();
  criarProduto("MLB-ABAIXO-MINIMO", 19, true);
  assert.equal(
    reservarProdutoParaEnvio(),
    undefined,
    "produto selecionado abaixo do desconto mínimo não deve ser reservado",
  );

  limparBanco();
  const idAntigo = criarProduto("MLB-ANTIGO", 50, true);
  db.prepare("UPDATE produtos SET criado_em = datetime('now', '-4 days') WHERE id = ?").run(idAntigo);
  assert.equal(
    reservarProdutoParaEnvio(),
    undefined,
    "produto fora da janela de validade não deve ser reservado",
  );

  limparBanco();
  const idTentativas = criarProduto("MLB-TENTATIVAS", 50, true);
  db.prepare("UPDATE produtos SET tentativas_envio = 3 WHERE id = ?").run(idTentativas);
  assert.equal(
    reservarProdutoParaEnvio(),
    undefined,
    "produto que atingiu o máximo de tentativas não deve ser reservado",
  );

  limparBanco();
  setConfig("limite_diario", "1");
  criarProduto("MLB-PRIMEIRO", 50);
  criarProduto("MLB-SEGUNDO", 40);
  assert.ok(reservarProdutoParaEnvio(), "a primeira reserva deve caber no limite diário");
  assert.equal(
    reservarProdutoParaEnvio(),
    undefined,
    "uma reserva em andamento deve ocupar a única vaga diária",
  );

  limparBanco();
  setConfig("limite_diario", "1");
  criarProduto("MLB-CONCORRENTE-1", 50);
  criarProduto("MLB-CONCORRENTE-2", 40);
  const iniciarEm = join(diretorioTeste, "iniciar-reservas");
  const prontoA = join(diretorioTeste, "reserva-a-pronta");
  const prontoB = join(diretorioTeste, "reserva-b-pronta");
  const resultadoA = join(diretorioTeste, "reserva-a-resultado");
  const resultadoB = join(diretorioTeste, "reserva-b-resultado");
  const reservaA = executarReservaEmProcesso(prontoA, iniciarEm, resultadoA);
  const reservaB = executarReservaEmProcesso(prontoB, iniciarEm, resultadoB);
  await Promise.all([esperarArquivo(prontoA), esperarArquivo(prontoB)]);
  writeFileSync(iniciarEm, "iniciar");
  await Promise.all([reservaA, reservaB]);
  const reservas = [resultadoA, resultadoB].map((resultadoEm) =>
    JSON.parse(readFileSync(resultadoEm, "utf8")) as { produto: string | null },
  );
  assert.equal(
    reservas.filter((reserva) => reserva.produto !== null).length,
    1,
    "duas execuções concorrentes não devem ultrapassar o limite diário",
  );

  console.log("Resultado: fila de ofertas passou");
} finally {
  db.close();
  process.chdir(diretorioOriginal);
  rmSync(diretorioTeste, { recursive: true, force: true });
}
