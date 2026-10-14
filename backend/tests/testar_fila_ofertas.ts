import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const diretorioOriginal = process.cwd();
const diretorioTeste = mkdtempSync(join(tmpdir(), "loot-fila-"));
process.chdir(diretorioTeste);

const { default: db } = await import("../src/db/index.js");
const queries = await import("../src/db/queries.js");
const {
  salvarProduto,
  reservarProdutoParaEnvio,
  setConfig,
  atualizarLinkAfiliadoPorFonte,
} = queries;

const limparProdutosAntigos = (
  queries as {
    limparProdutosAntigos?: () => number;
  }
).limparProdutosAntigos;

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

  limparBanco();
  const sentAntigoId = criarProduto("MLB-SENT-ANTIGO", 50);
  const failedAntigoId = criarProduto("MLB-FAILED-ANTIGO", 50);
  const sentRecenteId = criarProduto("MLB-SENT-RECENTE", 50);
  const pendingAntigoId = criarProduto("MLB-PENDING-ANTIGO", 50);
  const sendingAntigoId = criarProduto("MLB-SENDING-ANTIGO", 50);
  const ambiguoAntigoId = criarProduto("MLB-AMBIGUO-ANTIGO", 50);
  const sentComHistoricoId = criarProduto("MLB-SENT-COM-HISTORICO", 50);
  db.prepare(
    "UPDATE produtos SET status_fila = 'sent', enviado = 1, criado_em = datetime('now', '-31 days') WHERE id = ?",
  ).run(sentAntigoId);
  db.prepare(
    "UPDATE produtos SET status_fila = 'failed', criado_em = datetime('now', '-31 days') WHERE id = ?",
  ).run(failedAntigoId);
  db.prepare(
    "UPDATE produtos SET status_fila = 'sent', enviado = 1, criado_em = datetime('now', '-29 days') WHERE id = ?",
  ).run(sentRecenteId);
  db.prepare(
    "UPDATE produtos SET criado_em = datetime('now', '-31 days') WHERE id IN (?, ?, ?)",
  ).run(pendingAntigoId, sendingAntigoId, ambiguoAntigoId);
  db.prepare("UPDATE produtos SET status_fila = 'sending' WHERE id = ?").run(sendingAntigoId);
  db.prepare("UPDATE produtos SET status_fila = 'ambiguous' WHERE id = ?").run(ambiguoAntigoId);
  db.prepare(
    "UPDATE produtos SET status_fila = 'sent', enviado = 1, criado_em = datetime('now', '-31 days') WHERE id = ?",
  ).run(sentComHistoricoId);
  db.prepare(
    "INSERT INTO tentativas_de_envio (produto_id, origem, status, finalizado_em) VALUES (?, 'automatico', 'sent', CURRENT_TIMESTAMP)",
  ).run(sentComHistoricoId);

  assert.equal(
    typeof limparProdutosAntigos,
    "function",
    "a limpeza de produtos antigos deve estar disponível",
  );
  if (typeof limparProdutosAntigos !== "function") {
    throw new Error("a limpeza de produtos antigos não foi implementada");
  }
  assert.equal(limparProdutosAntigos(), 2);
  const produtosRestantes = db
    .prepare("SELECT external_product_id FROM produtos ORDER BY external_product_id")
    .all() as Array<{ external_product_id: string }>;
  assert.deepEqual(
    produtosRestantes.map((produto) => produto.external_product_id),
    [
      "MLB-AMBIGUO-ANTIGO",
      "MLB-PENDING-ANTIGO",
      "MLB-SENDING-ANTIGO",
      "MLB-SENT-COM-HISTORICO",
      "MLB-SENT-RECENTE",
    ],
    "a limpeza deve preservar produtos recentes, ativos, ambíguos e com histórico",
  );

  limparBanco();
  criarProduto("SHP-VENCIDA", 50, true);
  db.prepare(
    "UPDATE produtos SET oferta_expira_em = CAST(strftime('%s','now') AS INTEGER) - 60 WHERE external_product_id = ?",
  ).run("SHP-VENCIDA");
  assert.equal(
    reservarProdutoParaEnvio(),
    undefined,
    "oferta vencida não deve ser reservada",
  );

  limparBanco();
  criarProduto("SHP-VALIDA", 50, true);
  db.prepare(
    "UPDATE produtos SET oferta_expira_em = CAST(strftime('%s','now') AS INTEGER) + 3600 WHERE external_product_id = ?",
  ).run("SHP-VALIDA");
  assert.equal(reservarProdutoParaEnvio()?.external_product_id, "SHP-VALIDA");

  limparBanco();
  salvarProduto({
    source_key: "mercado_livre",
    external_product_id: "123",
    nome: "ML",
    preco_atual: "80",
    preco_original: "100",
    desconto_percentual: 20,
    link_afiliado: "https://example.test/ml",
  });
  salvarProduto({
    source_key: "shopee",
    external_product_id: "123",
    nome: "SH",
    preco_atual: "80",
    preco_original: "100",
    desconto_percentual: 20,
    link_afiliado: "https://example.test/shopee",
  });
  atualizarLinkAfiliadoPorFonte("shopee", "123", "https://shope.ee/novo");

  const linhaShopee = db
    .prepare(
      "SELECT link_afiliado FROM produtos WHERE source_key = ? AND external_product_id = ?",
    )
    .get("shopee", "123") as { link_afiliado: string } | undefined;
  const linhaMercadoLivre = db
    .prepare(
      "SELECT link_afiliado FROM produtos WHERE source_key = ? AND external_product_id = ?",
    )
    .get("mercado_livre", "123") as { link_afiliado: string } | undefined;
  const contagem123 = db
    .prepare(
      "SELECT COUNT(*) as total FROM produtos WHERE external_product_id = '123'",
    )
    .get() as { total: number };

  assert.equal(linhaShopee?.link_afiliado, "https://shope.ee/novo");
  assert.equal(linhaMercadoLivre?.link_afiliado, "https://example.test/ml");
  assert.equal(contagem123.total, 2);

  function criarProdutoLoja(fonte: "mercado_livre" | "shopee", id: string, desconto: number, selecionado = false): number {
    salvarProduto({ source_key: fonte, external_product_id: id, nome: `Produto ${id}`, preco_atual: "80", preco_original: "100", desconto_percentual: desconto, link_afiliado: `https://example.test/${id}` });
    const linha = db.prepare("SELECT id FROM produtos WHERE source_key = ? AND external_product_id = ?").get(fonte, id) as { id: number };
    if (selecionado) db.prepare("UPDATE produtos SET selecionado = 1 WHERE id = ?").run(linha.id);
    return linha.id;
  }

  // Caso A: alternância entre lojas
  limparBanco();
  criarProdutoLoja("mercado_livre", "ML-30", 30);
  criarProdutoLoja("mercado_livre", "ML-25", 25);
  criarProdutoLoja("shopee", "SHP-60", 60);
  criarProdutoLoja("shopee", "SHP-50", 50);
  {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = reservarProdutoParaEnvio();
      ids.push(p!.external_product_id);
    }
    assert.deepEqual(
      ids,
      ["SHP-60", "ML-30", "SHP-50", "ML-25"],
      "Caso A: alternância deve seguir a ordem SHP-60, ML-30, SHP-50, ML-25",
    );
  }

  // Caso B: uma loja faltando
  limparBanco();
  criarProdutoLoja("mercado_livre", "ML-A", 40);
  criarProdutoLoja("mercado_livre", "ML-B", 35);
  criarProdutoLoja("mercado_livre", "ML-C", 30);
  {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = reservarProdutoParaEnvio();
      ids.push(p!.external_product_id);
    }
    assert.deepEqual(
      ids,
      ["ML-A", "ML-B", "ML-C"],
      "Caso B: loja única deve completar todas as vagas em ordem de desconto",
    );
  }

  // Caso C: selecionado tem prioridade
  limparBanco();
  criarProdutoLoja("shopee", "SHP-1", 60);
  criarProdutoLoja("mercado_livre", "ML-1", 30, true);
  criarProdutoLoja("shopee", "SHP-2", 50);
  {
    const primeiro = reservarProdutoParaEnvio();
    assert.equal(
      primeiro?.external_product_id,
      "ML-1",
      "Caso C: produto selecionado deve ter prioridade máxima",
    );
    const segundo = reservarProdutoParaEnvio();
    assert.equal(
      segundo?.external_product_id,
      "SHP-1",
      "Caso C: após selecionado, loja com 0 envios hoje (SHP) e maior desconto deve vir a seguir",
    );
  }

  // Janela de validade: Shopee em horas, Mercado Livre em dias
  limparBanco();
  setConfig("janela_shopee_horas", "12");
  {
    const shopee13h = criarProdutoLoja("shopee", "SHP-13H", 50);
    criarProdutoLoja("shopee", "SHP-11H", 40);
    const ml2d = criarProdutoLoja("mercado_livre", "ML-2D", 30);
    const ml4d = criarProdutoLoja("mercado_livre", "ML-4D", 60);
    db.prepare(
      "UPDATE produtos SET criado_em = datetime('now', '-13 hours') WHERE id = ?",
    ).run(shopee13h);
    db.prepare(
      "UPDATE produtos SET criado_em = datetime('now', '-11 hours') WHERE external_product_id = 'SHP-11H'",
    ).run();
    db.prepare(
      "UPDATE produtos SET criado_em = datetime('now', '-2 days') WHERE id = ?",
    ).run(ml2d);
    db.prepare(
      "UPDATE produtos SET criado_em = datetime('now', '-4 days') WHERE id = ?",
    ).run(ml4d);

    assert.deepEqual(
      queries.getMelhoresDescontos(10).map((p) => p.external_product_id),
      ["SHP-11H", "ML-2D"],
      "janela de 12h: Shopee de 13h fora, Shopee de 11h e ML de 2 dias dentro, ML de 4 dias fora",
    );

    setConfig("janela_shopee_horas", "14");
    assert.deepEqual(
      queries.getMelhoresDescontos(10).map((p) => p.external_product_id),
      ["SHP-13H", "SHP-11H", "ML-2D"],
      "janela de 14h deve incluir a Shopee de 13h",
    );

    setConfig("janela_shopee_horas", "12");
    const reservados: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = reservarProdutoParaEnvio();
      if (!p) break;
      reservados.push(p.external_product_id);
    }
    assert.deepEqual(
      reservados.sort(),
      ["ML-2D", "SHP-11H"],
      "a reserva deve respeitar as mesmas janelas",
    );
  }

  // Virada do dia em Brasília: envio às 22h de Brasília (01h UTC do dia seguinte)
  // pertence ao dia de Brasília, não ao dia UTC.
  limparBanco();
  setConfig("limite_diario", "1");
  {
    const idEnviado = criarProduto("MLB-DIA-BRASILIA", 50);
    criarProduto("MLB-PROXIMO", 40);
    const brasiliaHoje = (
      db.prepare("SELECT date('now', '-3 hours') AS d").get() as { d: string }
    ).d;
    // Instante UTC que cai às 22h de Brasília de "hoje em Brasília".
    const enviadoEmUtc = `${brasiliaHoje} 22:00:00`.replace(
      /^(\d{4}-\d{2}-\d{2}) 22:00:00$/,
      (_m, dia: string) => {
        const base = new Date(`${dia}T22:00:00-03:00`);
        return base.toISOString().slice(0, 19).replace("T", " ");
      },
    );
    db.prepare(
      "UPDATE produtos SET enviado = 1, status_fila = 'sent' WHERE id = ?",
    ).run(idEnviado);
    db.prepare("INSERT INTO envios (produto_id, enviado_em) VALUES (?, ?)").run(
      idEnviado,
      enviadoEmUtc,
    );
    assert.equal(
      queries.enviosHoje(),
      1,
      "envio de 22h de Brasília deve contar no dia de Brasília",
    );
  }

  console.log("Resultado: fila de ofertas passou");
} finally {
  db.close();
  process.chdir(diretorioOriginal);
  rmSync(diretorioTeste, { recursive: true, force: true });
}
