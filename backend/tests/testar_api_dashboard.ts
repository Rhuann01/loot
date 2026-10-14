import assert from "node:assert/strict";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";

const api = await iniciarApiDeTeste();

try {
  const {
    salvarProduto,
    buscarProdutoPorExternalId,
    gravarSnapshotComissao,
    gravarAtividade,
    setConfig,
  } = await import("../src/db/queries.js");

  const { sqlDiaBrasilia } = await import("../src/lib/time.js");

  // Configuração inicial do scheduler para o dashboard
  setConfig("auto_envio_ativo", "true");
  setConfig("limite_diario", "12");
  setConfig("horarios_envio", JSON.stringify(["05:00", "12:00", "15:00", "20:00"]));

  // -------------------------------------------------------------
  // 1. period=7d retorna 200 e ausência assume 7d
  // -------------------------------------------------------------
  const resPadrao = await api.req("/api/dashboard");
  assert.equal(resPadrao.status, 200, "GET /api/dashboard sem parâmetro deve retornar 200");
  const jsonPadrao = resPadrao.json as any;
  assert.equal(jsonPadrao.period, "7d");
  assert.ok("automation" in jsonPadrao);
  assert.ok("today" in jsonPadrao);
  assert.ok("commissionHistory" in jsonPadrao);
  assert.ok("platformPerformance" in jsonPadrao);
  assert.ok("recentActivities" in jsonPadrao);

  const res7d = await api.req("/api/dashboard?period=7d");
  assert.equal(res7d.status, 200, "GET /api/dashboard?period=7d deve retornar 200");
  const json7d = res7d.json as any;
  assert.equal(json7d.period, "7d");
  assert.equal(json7d.automation.ativo, true);
  assert.equal(json7d.automation.limiteDiario, 12);
  assert.deepEqual(json7d.automation.horarios, ["05:00", "12:00", "15:00", "20:00"]);
  assert.ok(Array.isArray(json7d.commissionHistory));
  assert.equal(json7d.commissionHistory.length, 7, "commissionHistory deve conter exatamente 7 dias");

  // -------------------------------------------------------------
  // 2. period=30d e outro período inválido retornam 400 PARAMETRO_INVALIDO
  // -------------------------------------------------------------
  for (const p of ["30d", "1d", "15d", "all", ""]) {
    const resInvalido = await api.req(`/api/dashboard?period=${p}`);
    assert.equal(
      resInvalido.status,
      400,
      `period='${p}' deve retornar 400`,
    );
    assert.equal((resInvalido.json as any).error.code, "PARAMETRO_INVALIDO");
  }

  // -------------------------------------------------------------
  // 3. Fixtures com múltiplas plataformas e comissão Shopee estimada
  // -------------------------------------------------------------
  salvarProduto({
    source_key: "shopee",
    external_product_id: "shop_item_1",
    nome: "Produto Shopee 1",
    preco_atual: "50,00",
    link_afiliado: "https://s.shopee.com.br/aff_1",
  });
  const prodShopee = buscarProdutoPorExternalId("shopee", "shop_item_1")!;

  salvarProduto({
    source_key: "mercado_livre",
    external_product_id: "MLB12345678",
    nome: "Produto ML 1",
    preco_atual: "120,00",
    link_afiliado: "https://mercadolivre.com/p/MLB12345678",
  });
  const prodML = buscarProdutoPorExternalId("mercado_livre", "MLB12345678")!;

  // Gravar snapshot de comissão Shopee hoje
  gravarSnapshotComissao({
    produto_id: prodShopee.id,
    integracao_key: "shopee",
    comissao_valor: 18.5,
    comissao_percentual: 0.1,
  });

  // Gravar tentativas de envio hoje
  // 1 Shopee enviada com sucesso
  api.db.prepare(
    `INSERT INTO tentativas_de_envio (produto_id, origem, status, plataforma, finalizado_em)
     VALUES (?, 'manual', 'sent', 'shopee', CURRENT_TIMESTAMP)`,
  ).run(prodShopee.id);

  // 1 Shopee failed (deve ser ignorada na contagem de enviados)
  api.db.prepare(
    `INSERT INTO tentativas_de_envio (produto_id, origem, status, motivo, plataforma, finalizado_em)
     VALUES (?, 'manual', 'failed', 'WhatsApp offline', 'shopee', CURRENT_TIMESTAMP)`,
  ).run(prodShopee.id);

  // 1 Shopee ambiguous (deve ser ignorada na contagem de enviados)
  api.db.prepare(
    `INSERT INTO tentativas_de_envio (produto_id, origem, status, motivo, plataforma, finalizado_em)
     VALUES (?, 'manual', 'ambiguous', 'Socket drop', 'shopee', CURRENT_TIMESTAMP)`,
  ).run(prodShopee.id);

  // 1 Shopee sending (deve ser ignorada na contagem de enviados)
  api.db.prepare(
    `INSERT INTO tentativas_de_envio (produto_id, origem, status, plataforma, finalizado_em)
     VALUES (?, 'auto', 'sending', 'shopee', CURRENT_TIMESTAMP)`,
  ).run(prodShopee.id);

  // 2 Mercado Livre enviadas com sucesso
  api.db.prepare(
    `INSERT INTO tentativas_de_envio (produto_id, origem, status, plataforma, finalizado_em)
     VALUES (?, 'auto', 'sent', 'mercado_livre', CURRENT_TIMESTAMP)`,
  ).run(prodML.id);

  api.db.prepare(
    `INSERT INTO tentativas_de_envio (produto_id, origem, status, plataforma, finalizado_em)
     VALUES (?, 'auto', 'sent', 'mercado_livre', CURRENT_TIMESTAMP)`,
  ).run(prodML.id);

  // 1 Mercado Livre failed (deve ser ignorada na contagem de enviados)
  api.db.prepare(
    `INSERT INTO tentativas_de_envio (produto_id, origem, status, motivo, plataforma, finalizado_em)
     VALUES (?, 'auto', 'failed', 'Erro de envio', 'mercado_livre', CURRENT_TIMESTAMP)`,
  ).run(prodML.id);

  // Consulta do dashboard com fixtures
  const resComDados = await api.req("/api/dashboard?period=7d");
  assert.equal(resComDados.status, 200);
  const json = resComDados.json as any;

  // -------------------------------------------------------------
  // 4. Comissão Shopee presente é marcada como estimada
  // -------------------------------------------------------------
  assert.equal(json.today.comissaoEstimada.valor, 18.5);
  assert.equal(json.today.comissaoEstimada.disponivel, true);
  assert.equal(json.today.comissaoEstimada.estimada, true);

  // -------------------------------------------------------------
  // 5. Mercado Livre não gera comissão fabricada
  // -------------------------------------------------------------
  const perfML = json.platformPerformance.find(
    (p: any) => p.plataforma === "mercado_livre",
  );
  assert.ok(perfML, "platformPerformance deve conter mercado_livre");
  assert.equal(perfML.available, true);
  assert.equal(
    perfML.comissaoEstimada.valor,
    null,
    "Mercado Livre não deve fabricar comissão",
  );
  assert.equal(perfML.comissaoEstimada.disponivel, false);
  assert.equal(perfML.comissaoEstimada.estimada, true);

  // TikTok Shop disponível: false
  const perfTikTok = json.platformPerformance.find(
    (p: any) => p.plataforma === "tiktok_shop",
  );
  assert.ok(perfTikTok, "platformPerformance deve conter tiktok_shop");
  assert.equal(perfTikTok.available, false);
  assert.equal(perfTikTok.motivo, "Não disponível nesta versão");
  assert.equal(perfTikTok.comissaoEstimada.valor, null);
  assert.equal(perfTikTok.comissaoEstimada.disponivel, false);

  // -------------------------------------------------------------
  // 6. Dia sem comissão retorna null/indisponível
  // -------------------------------------------------------------
  const history = json.commissionHistory;
  assert.equal(history.length, 7);
  // O último item é hoje (com comissão 18.50)
  const hojeEntry = history[history.length - 1];
  assert.equal(hojeEntry.valor, 18.5);
  assert.equal(hojeEntry.disponivel, true);
  assert.equal(hojeEntry.estimada, true);

  // Os outros 6 dias não têm comissão: devem ser null e indisponível (nunca zero!)
  for (let i = 0; i < 6; i++) {
    const entry = history[i];
    assert.equal(
      entry.valor,
      null,
      `Dia ${entry.data} sem snapshot deve ter valor null`,
    );
    assert.equal(
      entry.disponivel,
      false,
      `Dia ${entry.data} sem snapshot deve ter disponivel false`,
    );
    assert.equal(entry.estimada, true);
    assert.notEqual(
      entry.valor,
      0,
      `Dia ${entry.data} sem snapshot NUNCA deve ser zero fabricado`,
    );
  }

  // -------------------------------------------------------------
  // 7. Contagem de enviados ignora failed, ambiguous e sending
  // -------------------------------------------------------------
  // Hoje enviadas: 1 Shopee + 2 ML = 3
  assert.equal(
    json.today.enviadas,
    3,
    "today.enviadas deve somar apenas sent, ignorando failed, ambiguous e sending",
  );
  assert.equal(
    json.automation.enviadosHoje,
    3,
    "automation.enviadosHoje deve somar apenas sent",
  );

  const perfShopee = json.platformPerformance.find(
    (p: any) => p.plataforma === "shopee",
  );
  assert.ok(perfShopee);
  assert.equal(perfShopee.enviadas, 1);
  assert.equal(perfShopee.falhas, 1);
  assert.equal(perfShopee.ambiguous, 1);
  assert.equal(perfShopee.comissaoEstimada.valor, 18.5);
  assert.equal(perfShopee.comissaoEstimada.disponivel, true);

  assert.equal(perfML.enviadas, 2);
  assert.equal(perfML.falhas, 1);
  assert.equal(perfML.ambiguous, 0);

  // -------------------------------------------------------------
  // 8. Virada do dia em Brasília
  // -------------------------------------------------------------
  // Inserir registro com timestamp às 22h de Brasília do dia 2026-10-10:
  // 22h Brasília = 01:00 UTC do dia seguinte (2026-10-11 01:00:00 UTC).
  // O fuso de Brasília (-3h) deve converter para '2026-10-10'.
  const resViradaA = api.db
    .prepare(`SELECT ${sqlDiaBrasilia("'2026-10-11 01:00:00'")} as dia`)
    .get() as { dia: string };
  assert.equal(
    resViradaA.dia,
    "2026-10-10",
    "22h de Brasília (01:00 UTC dia seguinte) deve pertencer ao dia correto em Brasília",
  );

  // Próximo da meia-noite (23:59:59 Brasília = 02:59:59 UTC dia seguinte)
  const resViradaB = api.db
    .prepare(`SELECT ${sqlDiaBrasilia("'2026-10-11 02:59:59'")} as dia`)
    .get() as { dia: string };
  assert.equal(
    resViradaB.dia,
    "2026-10-10",
    "23:59:59 de Brasília deve pertencer a 2026-10-10",
  );

  // Exatamente meia-noite (00:00:00 Brasília = 03:00:00 UTC dia seguinte)
  const resViradaC = api.db
    .prepare(`SELECT ${sqlDiaBrasilia("'2026-10-11 03:00:00'")} as dia`)
    .get() as { dia: string };
  assert.equal(
    resViradaC.dia,
    "2026-10-11",
    "00:00:00 de Brasília deve pertencer ao novo dia 2026-10-11",
  );

  // -------------------------------------------------------------
  // 9. Atividades recentes são retornadas sem segredos
  // -------------------------------------------------------------
  gravarAtividade({
    tipo: "envio_sucesso",
    integracao_key: "shopee",
    produto_id: prodShopee.id,
    titulo: "Envio de produto teste",
    detalhe: "Mensagem entregue com sucesso",
  });

  const resComAtividade = await api.req("/api/dashboard?period=7d");
  assert.equal(resComAtividade.status, 200);
  const jsonAtiv = resComAtividade.json as any;
  assert.ok(Array.isArray(jsonAtiv.recentActivities));
  assert.ok(jsonAtiv.recentActivities.length > 0);
  const primeiraAtividade = jsonAtiv.recentActivities[0];
  assert.ok("id" in primeiraAtividade);
  assert.ok("tipo" in primeiraAtividade);
  assert.ok("titulo" in primeiraAtividade);
  assert.ok("criadoEm" in primeiraAtividade);

  // -------------------------------------------------------------
  // 10. Nenhuma resposta contém cookie, csrf, secret ou token
  // -------------------------------------------------------------
  const textoResposta = JSON.stringify(jsonAtiv).toLowerCase();
  for (const proibida of ["cookie", "csrf", "secret", "token"]) {
    assert.ok(
      !textoResposta.includes(proibida),
      `Resposta do dashboard não deve vazar '${proibida}'`,
    );
  }

  console.log("Resultado: api dashboard passou");
} finally {
  await api.encerrar();
}
