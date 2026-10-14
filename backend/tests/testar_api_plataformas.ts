import assert from "node:assert/strict";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";

const api = await iniciarApiDeTeste();

try {
  const {
    salvarProduto,
    buscarProdutoPorExternalId,
    gravarSnapshotComissao,
    adquirirLockExecucao,
    liberarLockExecucao,
    listarAtividades,
  } = await import("../src/db/queries.js");

  const { definirSincronizadorParaTeste } = await import(
    "../src/integrations/registry.js"
  );

  interface PlatformItem {
    key: string;
    nome: string;
    status: string;
    available: boolean;
    ativo: boolean;
    ultimaSincronizacao: string | null;
    totalProdutos: number;
    comissaoHoje: {
      valor: number | null;
      disponivel: boolean;
      estimada: boolean;
    };
    erro: string | null;
    motivo?: string;
  }

  // 1. Listagem das plataformas
  const resListagem = await api.req("/api/platforms");
  assert.equal(resListagem.status, 200);
  const plataformas = resListagem.json as PlatformItem[];
  assert.ok(Array.isArray(plataformas), "GET /api/platforms deve retornar um array");
  assert.equal(plataformas.length, 3, "Devem existir 3 plataformas no catálogo");

  const chaves = plataformas.map((p) => p.key).sort();
  assert.deepEqual(chaves, ["mercado_livre", "shopee", "tiktok_shop"]);

  const shopee = plataformas.find((p) => p.key === "shopee")!;
  assert.ok(shopee);
  assert.equal(shopee.available, true);
  assert.equal(typeof shopee.ativo, "boolean");
  assert.equal(typeof shopee.totalProdutos, "number");
  assert.ok("comissaoHoje" in shopee);
  assert.equal(shopee.comissaoHoje.estimada, true);

  // 2. TikTok indisponível
  const tiktok = plataformas.find((p) => p.key === "tiktok_shop")!;
  assert.ok(tiktok);
  assert.equal(tiktok.available, false);
  assert.equal(tiktok.motivo, "Não disponível nesta versão");

  const resSyncTiktok = await api.req("/api/platforms/tiktok_shop/sync", {
    method: "POST",
  });
  assert.equal(resSyncTiktok.status, 422);
  const jsonSyncTiktok = resSyncTiktok.json as { error: { code: string; message: string } };
  assert.equal(jsonSyncTiktok.error.code, "PLATAFORMA_INDISPONIVEL");

  const resConfigTiktok = await api.req("/api/platforms/tiktok_shop/config");
  assert.equal(resConfigTiktok.status, 422);

  // 3. Comissão diária Shopee com snapshot estimado e dia sem dado como null
  assert.equal(shopee.comissaoHoje.valor, null);
  assert.equal(shopee.comissaoHoje.disponivel, false);
  assert.equal(shopee.comissaoHoje.estimada, true);

  const ml = plataformas.find((p) => p.key === "mercado_livre")!;
  assert.equal(ml.comissaoHoje.valor, null);
  assert.equal(ml.comissaoHoje.disponivel, false);
  assert.equal(ml.comissaoHoje.estimada, true);

  // Inserir produto e snapshot hoje
  salvarProduto({
    source_key: "shopee",
    external_product_id: "999_888",
    nome: "Item Comissao Hoje",
    preco_atual: "50,00",
    link_afiliado: "https://shopee.com.br/product/999/888",
  });
  const prodShopee = buscarProdutoPorExternalId("shopee", "999_888")!;
  gravarSnapshotComissao({
    produto_id: prodShopee.id,
    integracao_key: "shopee",
    comissao_valor: 25.5,
    comissao_percentual: 0.1,
  });

  const resListagemComComissao = await api.req("/api/platforms");
  const shopeeComComissao = (resListagemComComissao.json as PlatformItem[]).find(
    (p) => p.key === "shopee",
  )!;
  assert.equal(shopeeComComissao.comissaoHoje.disponivel, true);
  assert.equal(shopeeComComissao.comissaoHoje.estimada, true);
  assert.equal(shopeeComComissao.comissaoHoje.valor, 25.5);

  // 4. Máscara de segredos
  const segredoReal = "segredo_muito_confidencial_123456";
  const resPutConfig = await api.req("/api/platforms/shopee/config", {
    method: "PUT",
    body: JSON.stringify({
      appId: "1234567890",
      apiKey: segredoReal,
    }),
  });
  assert.equal(resPutConfig.status, 200);
  const jsonPutConfig = resPutConfig.json as {
    key: string;
    appId: string;
    apiKey: string;
    apiKeyConfigurada: boolean;
  };
  assert.equal(jsonPutConfig.key, "shopee");
  assert.ok(jsonPutConfig.appId.includes("*"), "appId deve estar mascarado");
  assert.ok(!jsonPutConfig.appId.includes("345678"), "appId meio deve estar oculto");
  assert.equal(jsonPutConfig.apiKey, "********", "apiKey deve ser sempre asteriscos");
  assert.equal(jsonPutConfig.apiKeyConfigurada, true);

  const textoPutConfig = JSON.stringify(resPutConfig.json).toLowerCase();
  assert.ok(!textoPutConfig.includes("confidencial"), "Resposta não deve vazar segredo");

  const resGetConfig = await api.req("/api/platforms/shopee/config");
  assert.equal(resGetConfig.status, 200);
  const jsonGetConfig = resGetConfig.json as {
    appId: string;
    apiKey: string;
    apiKeyConfigurada: boolean;
  };
  assert.equal(jsonGetConfig.apiKey, "********");
  assert.ok(jsonGetConfig.appId.includes("*"));
  assert.ok(!JSON.stringify(resGetConfig.json).toLowerCase().includes("confidencial"));

  // Mercado Livre rejeita config manual
  const resConfigMl = await api.req("/api/platforms/mercado_livre/config");
  assert.equal(resConfigMl.status, 400);

  // 5. Sync com sucesso
  definirSincronizadorParaTeste(async (key) => {
    assert.equal(key, "shopee");
    return 12; // 12 ofertas coletadas
  });

  const resSync = await api.req("/api/platforms/shopee/sync", {
    method: "POST",
  });
  assert.equal(resSync.status, 200);
  const jsonSync = resSync.json as {
    sucesso: boolean;
    key: string;
    status: string;
    ultimaSincronizacao: string | null;
    erro: string | null;
  };
  assert.equal(jsonSync.sucesso, true);
  assert.equal(jsonSync.key, "shopee");
  assert.equal(jsonSync.status, "connected");
  assert.ok(jsonSync.ultimaSincronizacao, "Deve ter gravado ultimaSincronizacao");
  assert.equal(jsonSync.erro, null);

  const ativsSync = listarAtividades({ integracao_key: "shopee" });
  assert.ok(
    ativsSync.items.some((a) => a.tipo === "sincronizacao_inicio"),
    "Deve registrar atividade sincronizacao_inicio",
  );
  assert.ok(
    ativsSync.items.some((a) => a.tipo === "sincronizacao_sucesso"),
    "Deve registrar atividade sincronizacao_sucesso",
  );

  // 6. Lock 409
  adquirirLockExecucao("sync_shopee", "token-teste-lock", 60_000);
  const resLock = await api.req("/api/platforms/shopee/sync", {
    method: "POST",
  });
  assert.equal(resLock.status, 409);
  const jsonLock = resLock.json as { error: { code: string } };
  assert.equal(jsonLock.error.code, "SINCRONIZACAO_EM_ANDAMENTO");
  liberarLockExecucao("sync_shopee", "token-teste-lock");

  // 7. Falha de credencial sem segredo na resposta
  const segredoVazadoSimulado = "super_secret_token_chave_privada_999";
  definirSincronizadorParaTeste(async () => {
    throw new Error(`Falha de autenticação com token ${segredoVazadoSimulado}`);
  });

  const resFalha = await api.req("/api/platforms/shopee/sync", {
    method: "POST",
  });
  assert.equal(resFalha.status, 502);
  const jsonFalha = resFalha.json as { error: { code: string; message: string } };
  assert.equal(jsonFalha.error.code, "SINCRONIZACAO_FALHOU");

  const textoFalha = JSON.stringify(resFalha.json).toLowerCase();
  assert.ok(
    !textoFalha.includes("chave_privada_999"),
    "Erro não deve vazar credencial privada",
  );

  const resShopeeAposFalha = await api.req("/api/platforms/shopee");
  assert.equal(resShopeeAposFalha.status, 200);
  const shopeeAposFalha = resShopeeAposFalha.json as PlatformItem;
  assert.equal(shopeeAposFalha.status, "disconnected");
  assert.ok(shopeeAposFalha.erro, "Deve armazenar erro na integração");
  assert.ok(!shopeeAposFalha.erro?.toLowerCase().includes("chave_privada_999"));

  // Resetar stub de sincronização
  definirSincronizadorParaTeste(null);

  // 8. Ativação/desativação Shopee
  const resDesativar = await api.req("/api/platforms/shopee/active", {
    method: "PUT",
    body: JSON.stringify({ active: false }),
  });
  assert.equal(resDesativar.status, 200);
  const shopeeDesativada = resDesativar.json as PlatformItem;
  assert.equal(shopeeDesativada.ativo, false);
  assert.equal(shopeeDesativada.status, "disabled");

  const resReativar = await api.req("/api/platforms/shopee/active", {
    method: "PUT",
    body: JSON.stringify({ active: true }),
  });
  assert.equal(resReativar.status, 200);
  const shopeeReativada = resReativar.json as PlatformItem;
  assert.equal(shopeeReativada.ativo, true);

  // 9. Compatibilidade das rotas antigas
  const resRotasAntigas = await api.req("/api/integrations");
  assert.equal(resRotasAntigas.status, 200);
  const jsonAntigas = resRotasAntigas.json as { integrations: unknown[] };
  assert.ok(Array.isArray(jsonAntigas.integrations));

  const resAtivarAntiga = await api.req("/api/integrations/shopee/active", {
    method: "PUT",
    body: JSON.stringify({ active: true }),
  });
  assert.equal(resAtivarAntiga.status, 200);
  assert.ok(Array.isArray((resAtivarAntiga.json as { integrations: unknown[] }).integrations));

  // 10. Chave inexistente
  const res404 = await api.req("/api/platforms/fantasma/sync", {
    method: "POST",
  });
  assert.equal(res404.status, 404);

  console.log("Resultado: api plataformas passou");
} finally {
  await api.encerrar();
}
