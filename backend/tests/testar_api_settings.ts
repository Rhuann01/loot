import assert from "node:assert/strict";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";
import {
  definirStatusConexaoParaTeste,
  definirListadorGruposParaTeste,
  definirSolicitadorCodigoParaTeste,
  limparCodigoPareamento,
} from "../src/whatsapp/connection.js";

const api = await iniciarApiDeTeste();

try {
  const { setConfig, getConfig, salvarProduto } = await import("../src/db/queries.js");

  // Configuração inicial
  setConfig("auto_envio_ativo", "true");
  setConfig("limite_diario", "15");
  setConfig("horarios_envio", JSON.stringify(["06:00", "12:00", "18:00"]));
  setConfig("janela_shopee_horas", "12");
  setConfig("whatsapp_grupo_id", "123@g.us");
  setConfig("whatsapp_grupo_nome", "Grupo Teste");

  // Cadastra alguns produtos para storage.totalPromocoes
  salvarProduto({
    external_product_id: "shopee:1",
    source_key: "shopee",
    nome: "Produto Teste 1",
    preco_atual: "50.00",
    preco_original: "100.00",
    desconto_percentual: 50,
    link_original: "https://shopee.com.br/product/1/1",
    link_afiliado: "https://s.shopee.com.br/1",
  });
  salvarProduto({
    external_product_id: "shopee:2",
    source_key: "shopee",
    nome: "Produto Teste 2",
    preco_atual: "80.00",
    preco_original: "100.00",
    desconto_percentual: 20,
    link_original: "https://shopee.com.br/product/2/2",
    link_afiliado: "https://s.shopee.com.br/2",
  });

  // Mocks de WhatsApp conectado
  definirStatusConexaoParaTeste(() => ({
    estado: "conectado",
    conectado: true,
    requerQr: false,
    qrDisponivel: false,
    reconexaoNecessaria: false,
    ultimaMudancaEm: new Date().toISOString(),
  }));
  definirListadorGruposParaTeste(async () => [
    { id: "123@g.us", nome: "Grupo Teste", participantes: 10 },
    { id: "456@g.us", nome: "Outro Grupo", participantes: 5 },
  ]);

  // -------------------------------------------------------------
  // 1. GET agregado retorna scheduler, WhatsApp e storage
  // -------------------------------------------------------------
  const resGet = await api.req("/api/settings");
  assert.equal(resGet.status, 200, "GET /api/settings deve retornar 200");
  const jsonGet = resGet.json as any;

  assert.ok(jsonGet.scheduler, "Deve conter bloco scheduler");
  assert.equal(jsonGet.scheduler.ativo, true);
  assert.deepEqual(jsonGet.scheduler.horarios, ["06:00", "12:00", "18:00"]);
  assert.equal(jsonGet.scheduler.limiteDiario, 15);
  assert.equal(jsonGet.scheduler.quantidadePorExecucao, 3);
  assert.equal(jsonGet.scheduler.intervaloEntreMensagensMs, 3000);
  assert.equal(typeof jsonGet.scheduler.proximoEnvio, "string");
  assert.equal(jsonGet.scheduler.janelaShopeeHoras, 12);

  assert.ok(jsonGet.whatsapp, "Deve conter bloco whatsapp");
  assert.equal(jsonGet.whatsapp.status, "connected");
  assert.deepEqual(jsonGet.whatsapp.destino, { id: "123@g.us", nome: "Grupo Teste" });
  assert.equal(jsonGet.whatsapp.grupos.length, 2);

  assert.ok(jsonGet.storage, "Deve conter bloco storage");
  assert.equal(jsonGet.storage.tipo, "sqlite");
  assert.equal(jsonGet.storage.totalPromocoes, 2);

  // -------------------------------------------------------------
  // 2. Resposta não contém backup, cookie, CSRF, secret ou token
  // -------------------------------------------------------------
  const textoMinusculo = resGet.texto.toLowerCase();
  for (const proibido of ["backup", "cookie", "csrf", "secret", "token", "sessao_afiliado", "loot.db"]) {
    assert.ok(
      !textoMinusculo.includes(proibido),
      `GET /api/settings não deve conter "${proibido}"`,
    );
  }

  // -------------------------------------------------------------
  // 3. PUT aceita configuração válida
  // -------------------------------------------------------------
  const payloadValido = {
    scheduler: {
      ativo: false,
      horarios: ["08:00", "14:00", "20:00"],
      limiteDiario: 20,
      quantidadePorExecucao: 4,
      intervaloEntreMensagensMs: 4000,
      janelaShopeeHoras: 24,
    },
  };
  const resPut = await api.req("/api/settings", {
    method: "PUT",
    body: JSON.stringify(payloadValido),
  });
  assert.equal(resPut.status, 200, "PUT /api/settings com payload válido deve retornar 200");
  const jsonPut = resPut.json as any;
  assert.equal(jsonPut.sucesso, true);
  assert.equal(jsonPut.scheduler.ativo, false);
  assert.deepEqual(jsonPut.scheduler.horarios, ["08:00", "14:00", "20:00"]);
  assert.equal(jsonPut.scheduler.limiteDiario, 20);
  assert.equal(jsonPut.scheduler.quantidadePorExecucao, 4);
  assert.equal(jsonPut.scheduler.intervaloEntreMensagensMs, 4000);
  assert.equal(jsonPut.scheduler.janelaShopeeHoras, 24);

  // -------------------------------------------------------------
  // 4. PUT rejeita horários inválidos
  // -------------------------------------------------------------
  const casosHorariosInvalidos = [
    ["25:00"],
    ["12:60"],
    ["invalido"],
    ["08:00", "10:00", "12:00", "14:00", "16:00"], // 5 horários (> 4)
    "nao_e_array",
  ];
  for (const h of casosHorariosInvalidos) {
    const res = await api.req("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ scheduler: { horarios: h } }),
    });
    assert.equal(res.status, 400, `Horário inválido ${JSON.stringify(h)} deve retornar 400`);
    assert.equal((res.json as any).error.code, "PARAMETRO_INVALIDO");
  }

  // -------------------------------------------------------------
  // 5. PUT rejeita limite/intervalo/janela fora dos limites
  // -------------------------------------------------------------
  const casosForaDosLimites = [
    { limiteDiario: 0 },
    { limiteDiario: 101 },
    { limiteDiario: -5 },
    { limiteDiario: "abc" },
    { quantidadePorExecucao: 0 },
    { quantidadePorExecucao: -1 },
    { intervaloEntreMensagensMs: -1 },
    { intervaloEntreMensagensMs: 700_000 },
    { janelaShopeeHoras: 0 },
    { janelaShopeeHoras: 169 },
    { ativo: "sim" },
  ];
  for (const caso of casosForaDosLimites) {
    const res = await api.req("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ scheduler: caso }),
    });
    assert.equal(
      res.status,
      400,
      `Caso inválido ${JSON.stringify(caso)} deve retornar 400`,
    );
    assert.equal((res.json as any).error.code, "PARAMETRO_INVALIDO");
  }

  // -------------------------------------------------------------
  // 6. Alterações persistem e aparecem no GET seguinte
  // -------------------------------------------------------------
  const resGetAposPut = await api.req("/api/settings");
  assert.equal(resGetAposPut.status, 200);
  const jsonApos = resGetAposPut.json as any;
  assert.equal(jsonApos.scheduler.ativo, false);
  assert.deepEqual(jsonApos.scheduler.horarios, ["08:00", "14:00", "20:00"]);
  assert.equal(jsonApos.scheduler.limiteDiario, 20);
  assert.equal(jsonApos.scheduler.quantidadePorExecucao, 4);
  assert.equal(jsonApos.scheduler.intervaloEntreMensagensMs, 4000);
  assert.equal(jsonApos.scheduler.janelaShopeeHoras, 24);

  // -------------------------------------------------------------
  // 7. Rotas antigas continuam funcionando
  // -------------------------------------------------------------
  const resConfigLegado = await api.req("/api/config");
  assert.equal(resConfigLegado.status, 200, "GET /api/config deve retornar 200");
  assert.equal((resConfigLegado.json as any).auto_envio_ativo, "false");

  const resPostConfigLegado = await api.req("/api/config", {
    method: "POST",
    body: JSON.stringify({ chave: "desconto_minimo_global", valor: "25" }),
  });
  assert.equal(resPostConfigLegado.status, 200, "POST /api/config deve retornar 200");

  const resSchedulerLegado = await api.req("/api/scheduler");
  assert.equal(resSchedulerLegado.status, 200, "GET /api/scheduler deve retornar 200");

  const resPutSchedulerLegado = await api.req("/api/scheduler", {
    method: "PUT",
    body: JSON.stringify({
      ativo: true,
      horarios: ["09:00", "15:00"],
      limite_diario: 10,
    }),
  });
  assert.equal(resPutSchedulerLegado.status, 200, "PUT /api/scheduler deve retornar 200");

  // -------------------------------------------------------------
  // 8. POST /api/whatsapp/test verifica conexão/grupo sem enviar mensagem
  // -------------------------------------------------------------
  // 8.1 Grupo existe
  const resTestOk = await api.req("/api/whatsapp/test", { method: "POST" });
  assert.equal(resTestOk.status, 200, "POST /api/whatsapp/test deve retornar 200 quando conectado");
  const jsonTestOk = resTestOk.json as any;
  assert.equal(jsonTestOk.sucesso, true);
  assert.equal(jsonTestOk.conectado, true);
  assert.equal(jsonTestOk.grupoValido, true);
  assert.equal(jsonTestOk.status, "ok");
  assert.ok(jsonTestOk.diagnostico.includes("Grupo Teste"));

  // 8.2 Grupo configurado não existe na conta
  setConfig("whatsapp_grupo_id", "grupo_inexistente@g.us");
  const resTestInexistente = await api.req("/api/whatsapp/test", { method: "POST" });
  assert.equal(resTestInexistente.status, 200);
  const jsonTestInexistente = resTestInexistente.json as any;
  assert.equal(jsonTestInexistente.sucesso, false);
  assert.equal(jsonTestInexistente.conectado, true);
  assert.equal(jsonTestInexistente.grupoValido, false);
  assert.equal(jsonTestInexistente.status, "aviso");

  // 8.3 Nenhum grupo configurado
  setConfig("whatsapp_grupo_id", "");
  const resTestSemGrupo = await api.req("/api/whatsapp/test", { method: "POST" });
  assert.equal(resTestSemGrupo.status, 200);
  const jsonTestSemGrupo = resTestSemGrupo.json as any;
  assert.equal(jsonTestSemGrupo.sucesso, false);
  assert.equal(jsonTestSemGrupo.grupoValido, false);
  assert.equal(jsonTestSemGrupo.destino, null);

  // -------------------------------------------------------------
  // 9. WhatsApp offline retorna erro correto (503 WHATSAPP_OFFLINE)
  // -------------------------------------------------------------
  definirStatusConexaoParaTeste(() => ({
    estado: "desconectado",
    conectado: false,
    requerQr: false,
    qrDisponivel: false,
    reconexaoNecessaria: false,
    ultimaMudancaEm: new Date().toISOString(),
  }));
  const resTestOffline = await api.req("/api/whatsapp/test", { method: "POST" });
  assert.equal(resTestOffline.status, 503, "WhatsApp offline deve responder 503");
  assert.equal((resTestOffline.json as any).error.code, "WHATSAPP_OFFLINE");

  // Tentativa de ativar envio automático com WhatsApp offline deve falhar com 400 WHATSAPP_DESCONECTADO
  const resAtivarOffline = await api.req("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ scheduler: { ativo: true } }),
  });
  assert.equal(resAtivarOffline.status, 400, "Ativar com WhatsApp offline deve responder 400");
  assert.equal((resAtivarOffline.json as any).error.code, "WHATSAPP_DESCONECTADO");

  // Tentativa de ativar sem grupo de ofertas configurado deve falhar com 400 WHATSAPP_SEM_GRUPO
  definirStatusConexaoParaTeste(() => ({
    estado: "conectado",
    conectado: true,
    requerQr: false,
    qrDisponivel: false,
    reconexaoNecessaria: false,
    ultimaMudancaEm: new Date().toISOString(),
  }));
  setConfig("whatsapp_grupo_id", "");
  const resAtivarSemGrupo = await api.req("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ scheduler: { ativo: true } }),
  });
  assert.equal(resAtivarSemGrupo.status, 400, "Ativar sem grupo deve responder 400");
  assert.equal((resAtivarSemGrupo.json as any).error.code, "WHATSAPP_SEM_GRUPO");

  // Restaura WhatsApp desconectado para próximos testes
  definirStatusConexaoParaTeste(() => ({
    estado: "desconectado",
    conectado: false,
    requerQr: false,
    qrDisponivel: false,
    reconexaoNecessaria: false,
    ultimaMudancaEm: new Date().toISOString(),
  }));

  // -------------------------------------------------------------
  // 10. TikTok e credenciais não podem ser habilitados pelo settings
  // -------------------------------------------------------------
  const tentativasProibidas = [
    { tiktok: true },
    { tiktok_shop: true },
    { credentials: { token: "123" } },
    { cookie: "sessao=123" },
    { csrf: "token" },
    { shopee_secret: "hack" },
    { comissao: 50 },
    { backup: true },
  ];
  for (const tentativa of tentativasProibidas) {
    const res = await api.req("/api/settings", {
      method: "PUT",
      body: JSON.stringify(tentativa),
    });
    assert.equal(
      res.status,
      400,
      `Tentativa de configurar ${Object.keys(tentativa)[0]} deve retornar 400`,
    );
    assert.equal((res.json as any).error.code, "PARAMETRO_INVALIDO");
  }

  // Verifica que o estado de TikTok permanece indisponível
  const resTiktok = await api.req("/api/platforms/tiktok_shop");
  assert.equal(resTiktok.status, 200);
  assert.equal((resTiktok.json as any).available, false);
  assert.equal((resTiktok.json as any).ativo, false);

  // Teste de desconexão do WhatsApp
  setConfig("auto_envio_ativo", "true");
  const resDisconnect = await api.req("/api/whatsapp/disconnect", { method: "POST" });
  assert.equal(resDisconnect.status, 200, "POST /api/whatsapp/disconnect deve retornar 200");
  assert.equal((resDisconnect.json as any).sucesso, true);
  assert.equal((resDisconnect.json as any).autoEnvioAtivo, false);
  assert.equal(getConfig("auto_envio_ativo"), "false", "auto_envio_ativo deve ser false após desconectar");

  // Teste de código de pareamento por telefone
  limparCodigoPareamento();
  const resPairingGet = await api.req("/api/whatsapp/pairing-code");
  assert.equal(resPairingGet.status, 200, "GET /api/whatsapp/pairing-code deve retornar 200");
  assert.equal((resPairingGet.json as any).codigo, null);

  const resPairingVazio = await api.req("/api/whatsapp/pairing-code", {
    method: "POST",
    body: JSON.stringify({ telefone: "" }),
  });
  assert.equal(resPairingVazio.status, 400, "POST sem telefone deve retornar 400");
  assert.equal((resPairingVazio.json as any).error.code, "PARAMETRO_INVALIDO");

  definirSolicitadorCodigoParaTeste(async (_tel: string) => {
    return "ABCD-1234";
  });

  const resPairingOk = await api.req("/api/whatsapp/pairing-code", {
    method: "POST",
    body: JSON.stringify({ telefone: "11999998888" }),
  });
  assert.equal(resPairingOk.status, 200, "POST /api/whatsapp/pairing-code com telefone válido deve retornar 200");
  assert.equal((resPairingOk.json as any).sucesso, true);
  assert.equal((resPairingOk.json as any).codigo, "ABCD-1234");

  console.log("Resultado: api settings passou");
} finally {
  const { pararScheduler } = await import("../src/auto/scheduler.js");
  pararScheduler();
  definirStatusConexaoParaTeste(null);
  definirListadorGruposParaTeste(null);
  definirSolicitadorCodigoParaTeste(null);
  limparCodigoPareamento();
  await api.encerrar();
}

