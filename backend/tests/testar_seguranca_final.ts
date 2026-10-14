import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";

// Inicia harness com banco temporário antes de qualquer import dinâmico do projeto
const api = await iniciarApiDeTeste();

try {
  const { validarCredenciaisInicializacao } = await import("../src/index.js");
  const { formatarMensagem } = await import("../src/whatsapp/mensagem.js");
  const {
    setConfig,
    salvarProduto,
    gravarAtividade,
    gravarSnapshotComissao,
  } = await import("../src/db/queries.js");
  const { pararScheduler } = await import("../src/auto/scheduler.js");

  // -------------------------------------------------------------
  // 1. admin/admin é recusado fora do ambiente local
  // -------------------------------------------------------------
  assert.throws(
    () => {
      validarCredenciaisInicializacao({
        NODE_ENV: "production",
        PAINEL_USER: "admin",
        PAINEL_SENHA: "admin",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("Credenciais padrão"),
        "Mensagem deve estar em português e mencionar credenciais padrão",
      );
      assert.ok(
        !err.message.includes("PAINEL_SENHA"),
        "Mensagem não deve expor variável de ambiente de senha",
      );
      return true;
    },
    "admin/admin em produção deve ser rejeitado",
  );

  assert.throws(
    () => {
      validarCredenciaisInicializacao({
        NODE_ENV: "staging",
        PAINEL_USER: "admin",
        PAINEL_SENHA: "admin",
      });
    },
    /Credenciais padrão/,
    "admin/admin em staging deve ser rejeitado",
  );

  // -------------------------------------------------------------
  // 2. Ambiente local continua permitindo o harness
  // -------------------------------------------------------------
  assert.doesNotThrow(() => {
    validarCredenciaisInicializacao({
      NODE_ENV: "development",
      PAINEL_USER: "admin",
      PAINEL_SENHA: "admin",
    });
  }, "development deve permitir credenciais");

  assert.doesNotThrow(() => {
    validarCredenciaisInicializacao({
      NODE_ENV: "test",
      PAINEL_USER: "admin",
      PAINEL_SENHA: "admin",
    });
  }, "test deve permitir credenciais");

  const resHealth = await api.req("/api/health");
  assert.equal(resHealth.status, 200, "Ambiente de teste deve inicializar com 200 em /health");

  const SEGREDO_RAW = "shopee_secret_ultra_secreto_999";
  const APP_ID_RAW = "123456789";

  setConfig("shopee_secret", SEGREDO_RAW);
  setConfig("shopee_app_id", APP_ID_RAW);
  setConfig("auto_envio_ativo", "true");
  setConfig("limite_diario", "10");
  setConfig("horarios_envio", JSON.stringify(["06:00", "12:00", "18:00"]));

  // Cadastra produto Shopee sem preço original
  salvarProduto({
    external_product_id: "shopee:sem_de",
    source_key: "shopee",
    nome: "Fone Bluetooth Shopee",
    preco_atual: "29.90",
    desconto_percentual: 0,
    link_original: "https://shopee.com.br/product/1/2",
    link_afiliado: "https://s.shopee.com.br/abc",
  });

  const db = api.db;
  const prodRow = db
    .prepare("SELECT id FROM produtos WHERE external_product_id = 'shopee:sem_de'")
    .get() as { id: number };

  gravarSnapshotComissao({
    produto_id: prodRow.id,
    integracao_key: "shopee",
    comissao_valor: 3.5,
    comissao_percentual: 10,
    estimada: 1,
  });

  gravarAtividade({
    tipo: "teste_auditoria",
    titulo: "Atividade com parâmetros",
    detalhe: "Tentativa de log com dados normais",
  });

  // -------------------------------------------------------------
  // 3. Nenhuma resposta da API contém segredo
  // -------------------------------------------------------------
  const rotasParaVerificarSegredos = [
    "/api/platforms/shopee/config",
    "/api/settings",
    "/api/activities",
    "/api/dashboard?period=7d",
    "/api/sends",
    "/api/sends/summary",
    "/api/platforms",
    "/api/produtos",
  ];

  for (const rota of rotasParaVerificarSegredos) {
    const res = await api.req(rota);
    assert.equal(res.status, 200, `${rota} deve retornar 200`);
    const texto = res.texto;
    assert.ok(
      !texto.includes(SEGREDO_RAW),
      `Resposta de ${rota} não deve conter o segredo raw (${SEGREDO_RAW})`,
    );
    assert.ok(
      !texto.includes(APP_ID_RAW),
      `Resposta de ${rota} não deve conter o appId raw desmascarado (${APP_ID_RAW})`,
    );
  }

  // -------------------------------------------------------------
  // 4. Configurações mascaram credenciais
  // -------------------------------------------------------------
  const resPlatConfig = await api.req("/api/platforms/shopee/config");
  assert.equal(resPlatConfig.status, 200);
  const jsonPlatConfig = resPlatConfig.json as any;
  assert.equal(jsonPlatConfig.apiKey, "********");
  assert.equal(jsonPlatConfig.appId, "12*****89");
  assert.equal(jsonPlatConfig.apiKeyConfigurada, true);

  // -------------------------------------------------------------
  // 5. Dashboard, settings, atividades e envios não vazam dados sensíveis
  // -------------------------------------------------------------
  const rotasSemVazamento = [
    "/api/dashboard?period=7d",
    "/api/settings",
    "/api/activities",
    "/api/sends",
  ];
  for (const rota of rotasSemVazamento) {
    const res = await api.req(rota);
    const texto = res.texto.toLowerCase();
    for (const sensivel of ["shopee_secret", "cookie", "csrf_token", "basic ", "bearer "]) {
      assert.ok(
        !texto.includes(sensivel),
        `${rota} não deve vazar "${sensivel}"`,
      );
    }
  }

  // -------------------------------------------------------------
  // 6. Comissão mantém estimada: true
  // -------------------------------------------------------------
  const resDash = await api.req("/api/dashboard?period=7d");
  assert.equal(resDash.status, 200);
  const jsonDash = resDash.json as any;
  assert.equal(jsonDash.today.comissaoEstimada.estimada, true);
  for (const c of jsonDash.commissionHistory) {
    assert.equal(c.estimada, true, "commissionHistory deve manter estimada: true");
  }
  for (const p of jsonDash.platformPerformance) {
    assert.equal(
      p.comissaoEstimada.estimada,
      true,
      "platformPerformance deve manter estimada: true",
    );
  }

  const resProduto = await api.req(`/api/produtos/${prodRow.id}`);
  assert.equal(resProduto.status, 200);
  const jsonProduto = resProduto.json as any;
  if (jsonProduto.comissao) {
    assert.equal(jsonProduto.comissao.estimada, true);
  }

  // -------------------------------------------------------------
  // 7. Shopee não possui De: fabricado
  // -------------------------------------------------------------
  const msgShopeeSemDe = formatarMensagem({
    nome: "Fone Bluetooth Shopee",
    precoAtual: "29.90",
    precoOriginal: null,
    descontoPercentual: 0,
    linkAfiliado: "https://s.shopee.com.br/abc",
  });
  assert.ok(
    !msgShopeeSemDe.includes("De:"),
    "Mensagem Shopee sem precoOriginal não pode incluir 'De:'",
  );
  assert.ok(
    msgShopeeSemDe.includes("Por:"),
    "Mensagem Shopee deve incluir 'Por:'",
  );

  // -------------------------------------------------------------
  // 8. Nenhum endpoint novo de envio manual aceita Mercado Livre
  // -------------------------------------------------------------
  const resResolveMl = await api.req("/api/sends/manual/resolve", {
    method: "POST",
    body: JSON.stringify({ url: "https://www.mercadolivre.com.br/produto/123" }),
  });
  assert.equal(
    resResolveMl.status,
    422,
    "Envio manual resolve deve rejeitar link Mercado Livre com 422",
  );

  const resPreviewMl = await api.req("/api/sends/manual/preview", {
    method: "POST",
    body: JSON.stringify({ url: "https://www.mercadolivre.com.br/produto/123" }),
  });
  assert.equal(
    resPreviewMl.status,
    422,
    "Envio manual preview deve rejeitar link Mercado Livre com 422",
  );

  // -------------------------------------------------------------
  // 9. Não existe endpoint de backup/restauração ou exclusão manual criado pelo lote
  // -------------------------------------------------------------
  const rotasProibidas = [
    { method: "DELETE", path: "/api/produtos" },
    { method: "DELETE", path: `/api/produtos/${prodRow.id}` },
    { method: "GET", path: "/api/backup" },
    { method: "POST", path: "/api/backup" },
    { method: "POST", path: "/api/restore" },
    { method: "POST", path: "/api/restaurar" },
  ];
  for (const r of rotasProibidas) {
    const res = await api.req(r.path, { method: r.method });
    assert.equal(
      res.status,
      404,
      `Endpoint ${r.method} ${r.path} não deve existir (deve ser 404)`,
    );
  }

  // -------------------------------------------------------------
  // 10. TikTok permanece indisponível
  // -------------------------------------------------------------
  const resTiktokGet = await api.req("/api/platforms/tiktok_shop");
  assert.equal(resTiktokGet.status, 200);
  assert.equal((resTiktokGet.json as any).available, false);
  assert.equal((resTiktokGet.json as any).ativo, false);
  assert.equal((resTiktokGet.json as any).motivo, "Não disponível nesta versão");

  const resTiktokPut = await api.req("/api/platforms/tiktok_shop/active", {
    method: "PUT",
    body: JSON.stringify({ active: true }),
  });
  assert.equal(resTiktokPut.status, 422);
  assert.equal((resTiktokPut.json as any).error.code, "PLATAFORMA_INDISPONIVEL");

  const resTiktokConfig = await api.req("/api/platforms/tiktok_shop/config");
  assert.equal(resTiktokConfig.status, 422);
  assert.equal((resTiktokConfig.json as any).error.code, "PLATAFORMA_INDISPONIVEL");

  const resTiktokSync = await api.req("/api/platforms/tiktok_shop/sync", {
    method: "POST",
  });
  assert.equal(resTiktokSync.status, 422);
  assert.equal((resTiktokSync.json as any).error.code, "PLATAFORMA_INDISPONIVEL");

  // -------------------------------------------------------------
  // 11. docs/API.md existe e não contém segredos
  // -------------------------------------------------------------
  const caminhoDoc = [
    join(fileURLToPath(import.meta.url), "../../../../docs/API.md"),
    join(fileURLToPath(import.meta.url), "../../../docs/API.md"),
  ].find((p) => existsSync(p));
  assert.ok(caminhoDoc && existsSync(caminhoDoc), "docs/API.md deve existir na raiz do projeto");
  const conteudoDoc = readFileSync(caminhoDoc, "utf8");
  assert.ok(conteudoDoc.length > 500, "docs/API.md deve ter conteúdo relevante");

  const termosSegredoDoc = [
    "shopee_secret_ultra",
    "x-csrf-token: 1",
    "cookie: session=",
    "bearer secret",
  ];
  for (const termo of termosSegredoDoc) {
    assert.ok(
      !conteudoDoc.includes(termo),
      `docs/API.md não deve conter segredo: "${termo}"`,
    );
  }

  // -------------------------------------------------------------
  // 12. Todas as rotas antigas cobertas pelo lote 01 e lote 02 continuam funcionando
  // -------------------------------------------------------------
  const rotasAntigas = [
    "/api/health",
    "/api/config",
    "/api/scheduler",
    "/api/produtos",
    `/api/produtos/${prodRow.id}`,
    `/api/produtos/${prodRow.id}/attempts`,
    "/api/platforms",
    "/api/platforms/shopee",
    "/api/platforms/mercado_livre",
    "/api/activities",
    "/api/sends",
    "/api/sends/summary",
    "/api/queue/summary",
    "/api/whatsapp/status",
  ];

  for (const rota of rotasAntigas) {
    const res = await api.req(rota);
    assert.equal(res.status, 200, `Rota antiga ${rota} deve continuar retornando 200`);
  }

  pararScheduler();
  console.log("Resultado: seguranca final passou");
} finally {
  await api.encerrar();
}
