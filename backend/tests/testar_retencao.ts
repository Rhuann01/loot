import assert from "node:assert/strict";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";

const api = await iniciarApiDeTeste();

try {
  const {
    getConfig,
    setConfig,
    limparProdutosAntigos,
    buscarProdutoPorExternalId,
    listarAtividades,
    gravarSnapshotComissao,
  } = await import("../src/db/queries.js");

  const db = api.db;

  // -------------------------------------------------------------
  // 8. A política padrão é 90 dias
  // -------------------------------------------------------------
  const retencaoPadrao = getConfig("retencao_dias");
  assert.equal(
    retencaoPadrao,
    "90",
    "A política padrão de retenção deve ser 90 dias",
  );

  // Helper para inserir produtos diretamente com datas arbitrárias
  function inserirProdutoTeste(params: {
    externalId: string;
    statusFila: string;
    diasAtras: number;
  }): number {
    const info = db
      .prepare(
        `
      INSERT INTO produtos (
        source_key, external_product_id, nome, preco_atual, link_afiliado,
        status_fila, criado_em
      ) VALUES (
        'shopee', ?, 'Produto Retenção Teste', '10.00', 'https://s.shopee.com.br/teste',
        ?, datetime('now', '-3 hours', ? || ' days')
      )
    `,
      )
      .run(params.externalId, params.statusFila, `-${params.diasAtras}`);
    return Number(info.lastInsertRowid);
  }

  // -------------------------------------------------------------
  // 1. Produto sent com mais de 90 dias e sem histórico relevante é removido
  // -------------------------------------------------------------
  const idSent91 = inserirProdutoTeste({
    externalId: "shopee:sent_91",
    statusFila: "sent",
    diasAtras: 91,
  });
  const idFailed95 = inserirProdutoTeste({
    externalId: "shopee:failed_95",
    statusFila: "failed",
    diasAtras: 95,
  });

  // -------------------------------------------------------------
  // 2. Produto com 89 dias permanece
  // -------------------------------------------------------------
  const idSent89 = inserirProdutoTeste({
    externalId: "shopee:sent_89",
    statusFila: "sent",
    diasAtras: 89,
  });

  // -------------------------------------------------------------
  // 3. Produto antigo com envios permanece
  // -------------------------------------------------------------
  const idComEnvios = inserirProdutoTeste({
    externalId: "shopee:com_envios",
    statusFila: "sent",
    diasAtras: 120,
  });
  db.prepare(`INSERT INTO envios (produto_id) VALUES (?)`).run(idComEnvios);

  // -------------------------------------------------------------
  // 4. Produto antigo com tentativa/snapshot recente permanece
  // -------------------------------------------------------------
  const idComTentativa = inserirProdutoTeste({
    externalId: "shopee:com_tentativa",
    statusFila: "sent",
    diasAtras: 110,
  });
  db.prepare(
    `INSERT INTO tentativas_de_envio (produto_id, plataforma, origem, status, mensagem_snapshot)
     VALUES (?, 'shopee', 'manual', 'sent', 'Mensagem snapshot teste')`,
  ).run(idComTentativa);

  const idComComissao = inserirProdutoTeste({
    externalId: "shopee:com_comissao",
    statusFila: "sent",
    diasAtras: 105,
  });
  gravarSnapshotComissao({
    produto_id: idComComissao,
    integracao_key: "shopee",
    comissao_valor: 5.5,
    comissao_percentual: 10,
    estimada: 1,
  });

  // -------------------------------------------------------------
  // 5. pending, sending e ambiguous não são apagados indevidamente
  // -------------------------------------------------------------
  const idPending = inserirProdutoTeste({
    externalId: "shopee:pending_150",
    statusFila: "pending",
    diasAtras: 150,
  });
  const idSending = inserirProdutoTeste({
    externalId: "shopee:sending_150",
    statusFila: "sending",
    diasAtras: 150,
  });
  const idAmbiguous = inserirProdutoTeste({
    externalId: "shopee:ambiguous_150",
    statusFila: "ambiguous",
    diasAtras: 150,
  });

  // Executa a limpeza
  const removidos = limparProdutosAntigos();
  assert.equal(
    removidos,
    2,
    "Deve remover exatamente os 2 produtos antigos (sent_91 e failed_95)",
  );

  // Verificações de existência
  assert.equal(
    buscarProdutoPorExternalId("shopee", "shopee:sent_91"),
    undefined,
    "Produto sent_91 deve ter sido removido",
  );
  assert.equal(
    buscarProdutoPorExternalId("shopee", "shopee:failed_95"),
    undefined,
    "Produto failed_95 deve ter sido removido",
  );

  assert.ok(
    buscarProdutoPorExternalId("shopee", "shopee:sent_89"),
    "Produto com 89 dias deve permanecer",
  );
  assert.ok(
    buscarProdutoPorExternalId("shopee", "shopee:com_envios"),
    "Produto antigo referenciado por envios deve permanecer",
  );
  assert.ok(
    buscarProdutoPorExternalId("shopee", "shopee:com_tentativa"),
    "Produto antigo com tentativa/snapshot deve permanecer",
  );
  assert.ok(
    buscarProdutoPorExternalId("shopee", "shopee:com_comissao"),
    "Produto antigo com snapshot de comissão deve permanecer",
  );
  assert.ok(
    buscarProdutoPorExternalId("shopee", "shopee:pending_150"),
    "Produto pending não deve ser removido",
  );
  assert.ok(
    buscarProdutoPorExternalId("shopee", "shopee:sending_150"),
    "Produto sending não deve ser removido",
  );
  assert.ok(
    buscarProdutoPorExternalId("shopee", "shopee:ambiguous_150"),
    "Produto ambiguous não deve ser removido",
  );

  // -------------------------------------------------------------
  // 6. Limpeza é idempotente
  // -------------------------------------------------------------
  const removidosSegundaVez = limparProdutosAntigos();
  assert.equal(
    removidosSegundaVez,
    0,
    "Execuções subsequentes sem novos produtos antigos devem remover 0",
  );

  // -------------------------------------------------------------
  // 7. Atividade de limpeza é registrada
  // -------------------------------------------------------------
  const atividades = listarAtividades({ limit: 10 });
  const atividadeLimpeza = atividades.items.find(
    (a) => a.tipo === "limpeza_retencao",
  );
  assert.ok(
    atividadeLimpeza,
    "Atividade com tipo limpeza_retencao deve ter sido registrada",
  );
  assert.ok(
    atividadeLimpeza.titulo.includes("Limpeza"),
    "Título deve indicar limpeza",
  );

  // -------------------------------------------------------------
  // 9. Ausência de backup/restauração continua explícita
  // -------------------------------------------------------------
  const rotasInexistentes = [
    { method: "DELETE", path: "/api/produtos" },
    { method: "GET", path: "/api/backup" },
    { method: "POST", path: "/api/backup" },
    { method: "POST", path: "/api/restore" },
    { method: "POST", path: "/api/restaurar" },
  ];
  for (const r of rotasInexistentes) {
    const res = await api.req(r.path, { method: r.method });
    assert.equal(
      res.status,
      404,
      `Rota ${r.method} ${r.path} não deve existir (deve retornar 404)`,
    );
  }

  const resSettings = await api.req("/api/settings");
  assert.equal(resSettings.status, 200);
  const jsonSettings = resSettings.json as any;
  assert.ok(!("backup" in jsonSettings), "Settings não deve conter backup");
  assert.ok(!("restauracao" in jsonSettings), "Settings não deve conter restauração");

  // -------------------------------------------------------------
  // 10. Nenhum segredo aparece no detalhe da atividade
  // -------------------------------------------------------------
  const todasAtividades = listarAtividades({ limit: 50 });
  const termosSegredos = [
    "secret",
    "cookie",
    "csrf",
    "token",
    "shopee_secret",
    "password",
    "senha",
    "authorization",
  ];
  for (const ativ of todasAtividades.items) {
    const texto = `${ativ.titulo} ${ativ.detalhe ?? ""}`.toLowerCase();
    for (const termo of termosSegredos) {
      assert.ok(
        !texto.includes(termo),
        `Atividade não deve conter termo sensível "${termo}": ${texto}`,
      );
    }
  }

  console.log("Resultado: retencao passou");
} finally {
  await api.encerrar();
}
