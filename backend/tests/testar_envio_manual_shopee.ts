import assert from "node:assert/strict";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";

const api = await iniciarApiDeTeste();

try {
  const {
    setConfig,
    getConfig,
    salvarProduto,
    buscarTentativaEnvioPorId,
    listarAtividades,
  } = await import("../src/db/queries.js");

  const {
    definirResolvedorRedirectParaTeste,
    definirConsultorShopeeParaTeste,
    definirGeradorLinkParaTeste,
    definirEnviadorParaTeste,
    definirStatusConexaoParaTeste,
  } = await import("../src/whatsapp/envio-manual-shopee.js");

  const { getAffiliateProvider } = await import(
    "../src/integrations/registry.js"
  );

  // Configuração inicial de teste
  setConfig("whatsapp_grupo_id", "120363000000000000@g.us");
  setConfig("whatsapp_grupo_nome", "Grupo de Promoções");
  setConfig("intervalo_entre_mensagens_ms", "0");
  setConfig("limite_diario", "10");
  setConfig("horarios_envio", JSON.stringify(["09:00", "15:00", "21:00"]));
  setConfig("auto_envio_ativo", "true");

  // Helper de mock do WhatsApp
  const mockStatusWhats = (conectado: boolean) => {
    definirStatusConexaoParaTeste(() => ({
      estado: conectado ? "conectado" : "desconectado",
      conectado,
      qrDisponivel: false,
      reconexaoNecessaria: false,
      ultimaMudancaEm: new Date().toISOString(),
    }));
  };
  mockStatusWhats(true);

  // Helper de mock da consulta de oferta Shopee
  const ofertasMock = new Map<string, {
    precoAtual: number;
    descontoPercentual: number;
    nome: string;
    imageUrl: string;
  }>();

  ofertasMock.set("111", {
    precoAtual: 29.9,
    descontoPercentual: 40,
    nome: "Fone Bluetooth Shopee",
    imageUrl: "https://cf.shopee.com.br/file/img_111",
  });
  ofertasMock.set("222", {
    precoAtual: 49.9,
    descontoPercentual: 25,
    nome: "Mouse Gamer Shopee",
    imageUrl: "https://cf.shopee.com.br/file/img_222",
  });
  ofertasMock.set("333", {
    precoAtual: 89.9,
    descontoPercentual: 30,
    nome: "Teclado Mecânico Shopee",
    imageUrl: "https://cf.shopee.com.br/file/img_333",
  });

  definirConsultorShopeeParaTeste(async (itemId: string) => {
    return ofertasMock.get(itemId) ?? null;
  });

  // Mock gerador de link afiliado
  definirGeradorLinkParaTeste(async (url: string) => {
    return `https://s.shopee.com.br/aff_${Buffer.from(url).toString("base64").slice(0, 8)}`;
  });

  // Spy de mensagens enviadas
  const mensagensEnviadas: unknown[] = [];
  definirEnviadorParaTeste(async (dados) => {
    mensagensEnviadas.push(dados);
  });

  const todasRespostasParaAuditoria: Array<{ rota: string; json: unknown }> = [];
  function registrarResposta(rota: string, json: unknown) {
    todasRespostasParaAuditoria.push({ rota, json });
  }

  // -------------------------------------------------------------
  // 1. Resolve de URL Shopee limpa
  // -------------------------------------------------------------
  {
    const urlEntrada =
      "https://shopee.com.br/product/1000/111?sp_atk=abc123&utm_source=twitter#review";
    const res = await api.req("/api/sends/manual/resolve", {
      method: "POST",
      body: JSON.stringify({ url: urlEntrada }),
    });
    registrarResposta("1.resolve_limpa", res.json);

    assert.equal(res.status, 200, "Resolve deve responder 200");
    const json = res.json as any;
    assert.deepEqual(json.plataforma, { key: "shopee", nome: "Shopee" });
    assert.equal(
      json.urlOriginal,
      "https://shopee.com.br/product/1000/111",
      "URL normalizada deve remover query params e fragmentos",
    );
    assert.equal(json.externalProductId, "1000_111");
    assert.deepEqual(json.camposManuais, []);
    assert.equal(json.produtoJaEnviadoHoje, false);
    assert.equal(json.enviadoEm, null);
    assert.equal(json.dados.nome, "Fone Bluetooth Shopee");
    assert.equal(json.dados.precoAtual, "29,90");
    assert.equal(json.dados.precoOriginal, null);
    assert.equal(json.dados.descontoPercentual, 40);
    assert.equal(json.dados.imagemUrl, "https://cf.shopee.com.br/file/img_111");
  }

  // -------------------------------------------------------------
  // 2. Resolve de link curto com redirect stubado
  // -------------------------------------------------------------
  {
    definirResolvedorRedirectParaTeste(async (urlCurta: string) => {
      assert.ok(urlCurta.startsWith("https://s.shopee.com.br/"));
      return "https://shopee.com.br/product/2000/222?smtt=0.0.9";
    });

    const res = await api.req("/api/sends/manual/resolve", {
      method: "POST",
      body: JSON.stringify({ url: "https://s.shopee.com.br/short_mouse" }),
    });
    registrarResposta("2.resolve_curto", res.json);

    assert.equal(res.status, 200);
    const json = res.json as any;
    assert.equal(
      json.urlOriginal,
      "https://shopee.com.br/product/2000/222",
      "Link curto deve resolver para URL normalizada canônica",
    );
    assert.equal(json.externalProductId, "2000_222");
    assert.equal(json.dados.nome, "Mouse Gamer Shopee");
  }

  // -------------------------------------------------------------
  // 3. Mercado Livre retorna 422 e não chama provider ML
  // -------------------------------------------------------------
  {
    let mlProviderChamado = false;
    const mlProvider = getAffiliateProvider("mercado_livre");
    const originalGenerateLink = mlProvider.generateLink;
    mlProvider.generateLink = async (u: string) => {
      mlProviderChamado = true;
      return originalGenerateLink(u);
    };

    const urlML = "https://produto.mercadolivre.com.br/MLB-123456789-celular";

    // Resolve com ML
    const resResolveML = await api.req("/api/sends/manual/resolve", {
      method: "POST",
      body: JSON.stringify({ url: urlML }),
    });
    registrarResposta("3.resolve_ml", resResolveML.json);
    assert.equal(resResolveML.status, 422);
    const errResolve = (resResolveML.json as any).error;
    assert.equal(errResolve.code, "PLATAFORMA_NAO_DISPONIVEL");
    assert.ok(
      errResolve.message.toLowerCase().includes("shopee"),
      "Mensagem deve informar disponibilidade exclusiva Shopee",
    );

    // Preview com ML
    const resPreviewML = await api.req("/api/sends/manual/preview", {
      method: "POST",
      body: JSON.stringify({ url: urlML, precoAtual: "100,00" }),
    });
    registrarResposta("3.preview_ml", resPreviewML.json);
    assert.equal(resPreviewML.status, 422);
    assert.equal((resPreviewML.json as any).error.code, "PLATAFORMA_NAO_DISPONIVEL");

    // Envio com ML
    const resEnvioML = await api.req("/api/sends/manual", {
      method: "POST",
      body: JSON.stringify({ url: urlML, precoAtual: "100,00" }),
    });
    registrarResposta("3.envio_ml", resEnvioML.json);
    assert.equal(resEnvioML.status, 422);
    assert.equal((resEnvioML.json as any).error.code, "PLATAFORMA_NAO_DISPONIVEL");

    assert.equal(mlProviderChamado, false, "Provider do Mercado Livre NUNCA deve ser acionado");
    mlProvider.generateLink = originalGenerateLink;
  }

  // -------------------------------------------------------------
  // 4. Domínio inválido retorna 422
  // -------------------------------------------------------------
  {
    const res = await api.req("/api/sends/manual/resolve", {
      method: "POST",
      body: JSON.stringify({ url: "https://www.amazon.com.br/dp/B08N5WRWNW" }),
    });
    registrarResposta("4.dominio_invalido", res.json);
    assert.equal(res.status, 422);
    assert.equal((res.json as any).error.code, "URL_NAO_SUPORTADA");
  }

  // -------------------------------------------------------------
  // 5. Link Shopee inválido retorna erro
  // -------------------------------------------------------------
  {
    // URL vazia
    const resVazia = await api.req("/api/sends/manual/resolve", {
      method: "POST",
      body: JSON.stringify({ url: "" }),
    });
    assert.equal(resVazia.status, 400);
    assert.equal((resVazia.json as any).error.code, "PARAMETRO_INVALIDO");

    // URL malformada
    const resMalformada = await api.req("/api/sends/manual/resolve", {
      method: "POST",
      body: JSON.stringify({ url: "htp://invalido" }),
    });
    assert.equal(resMalformada.status, 400);
    assert.equal((resMalformada.json as any).error.code, "PARAMETRO_INVALIDO");

    // URL da Shopee sem produto/item id
    const resSemItem = await api.req("/api/sends/manual/resolve", {
      method: "POST",
      body: JSON.stringify({ url: "https://shopee.com.br/cart" }),
    });
    registrarResposta("5.shopee_sem_item", resSemItem.json);
    assert.equal(resSemItem.status, 422);
    assert.equal((resSemItem.json as any).error.code, "URL_INVALIDA");
  }

  // -------------------------------------------------------------
  // 6. Preview preenche dados e não envia
  // -------------------------------------------------------------
  {
    mensagensEnviadas.length = 0;
    const totalTentativasAntes = (api.db.prepare("SELECT COUNT(*) as n FROM tentativas_de_envio").get() as any).n;

    const res = await api.req("/api/sends/manual/preview", {
      method: "POST",
      body: JSON.stringify({
        url: "https://shopee.com.br/product/1000/111",
        nome: "Fone Bluetooth Shopee",
        precoAtual: "31,99",
        precoOriginal: null,
        descontoPercentual: 45,
        imagemUrl: "https://cf.shopee.com.br/file/img_111",
      }),
    });
    registrarResposta("6.preview", res.json);

    assert.equal(res.status, 200, "Preview deve responder 200");
    const json = res.json as any;
    assert.ok(typeof json.mensagem === "string" && json.mensagem.includes("31,99"));
    assert.ok(json.mensagem.includes("https://s.shopee.com.br/aff_"));
    assert.deepEqual(json.destino, {
      id: "120363000000000000@g.us",
      nome: "Grupo de Promoções",
    });
    assert.ok(json.linkAfiliado.startsWith("https://s.shopee.com.br/aff_"));
    assert.equal(json.produtoJaEnviadoHoje, false);

    assert.equal(mensagensEnviadas.length, 0, "Preview NUNCA deve disparar mensagem");
    const totalTentativasDepois = (api.db.prepare("SELECT COUNT(*) as n FROM tentativas_de_envio").get() as any).n;
    assert.equal(totalTentativasDepois, totalTentativasAntes, "Preview NUNCA deve criar tentativa de envio");
  }

  // -------------------------------------------------------------
  // 7. precoAtual ausente/inválido retorna 400
  // -------------------------------------------------------------
  {
    for (const preco of ["", "0", "-15,50", "abc"]) {
      const resPreview = await api.req("/api/sends/manual/preview", {
        method: "POST",
        body: JSON.stringify({
          url: "https://shopee.com.br/product/1000/111",
          precoAtual: preco,
        }),
      });
      assert.equal(
        resPreview.status,
        400,
        `precoAtual '${preco}' deve retornar 400 no preview`,
      );
      assert.equal((resPreview.json as any).error.code, "PARAMETRO_INVALIDO");

      const resEnvio = await api.req("/api/sends/manual", {
        method: "POST",
        body: JSON.stringify({
          url: "https://shopee.com.br/product/1000/111",
          precoAtual: preco,
        }),
      });
      assert.equal(
        resEnvio.status,
        400,
        `precoAtual '${preco}' deve retornar 400 no envio`,
      );
      assert.equal((resEnvio.json as any).error.code, "PARAMETRO_INVALIDO");
    }
  }

  // -------------------------------------------------------------
  // 8. Oferta Shopee inexistente retorna 422
  // -------------------------------------------------------------
  {
    const res = await api.req("/api/sends/manual/resolve", {
      method: "POST",
      body: JSON.stringify({ url: "https://shopee.com.br/product/9999/8888" }),
    });
    registrarResposta("8.oferta_inexistente", res.json);
    assert.equal(res.status, 422);
    assert.equal((res.json as any).error.code, "OFERTA_NAO_ENCONTRADA");
  }

  // -------------------------------------------------------------
  // 9. Comissão ausente é null/indisponível/estimada
  // -------------------------------------------------------------
  {
    const res = await api.req("/api/sends/manual/preview", {
      method: "POST",
      body: JSON.stringify({
        url: "https://shopee.com.br/product/1000/111",
        precoAtual: "29,90",
      }),
    });
    registrarResposta("9.comissao_ausente", res.json);
    assert.equal(res.status, 200);
    const json = res.json as any;
    assert.equal(json.comissao.valor, null, "Valor de comissão ausente deve ser null");
    assert.equal(json.comissao.percentual, null, "Percentual deve ser null");
    assert.equal(json.comissao.disponivel, false, "Disponível deve ser false");
    assert.equal(json.comissao.estimada, true, "Estimada deve ser true");
    assert.equal(json.comissao.coletadaEm, null, "ColetadaEm deve ser null");
    assert.notEqual(json.comissao.valor, 0, "Comissão ausente NUNCA deve ser zero fabricado");
  }

  // -------------------------------------------------------------
  // 10. Envio cria snapshot e tentativa 'manual'
  // -------------------------------------------------------------
  let tentativaSentId: number = 0;
  {
    mensagensEnviadas.length = 0;
    const res = await api.req("/api/sends/manual", {
      method: "POST",
      body: JSON.stringify({
        url: "https://shopee.com.br/product/1000/111",
        nome: "Fone Bluetooth Shopee",
        precoAtual: "31,99",
        descontoPercentual: 45,
        imagemUrl: "https://cf.shopee.com.br/file/img_111",
      }),
    });
    registrarResposta("10.envio_sucesso", res.json);

    assert.equal(res.status, 200, "Envio deve retornar 200");
    const json = res.json as any;
    assert.equal(json.sucesso, true);
    assert.equal(json.status, "sent");
    assert.equal(json.needsReview, false);
    assert.ok(typeof json.tentativaId === "number");
    tentativaSentId = json.tentativaId;

    assert.equal(mensagensEnviadas.length, 1, "Envio deve ter disparado a mensagem");

    // Verificar banco
    const tentativa = buscarTentativaEnvioPorId(tentativaSentId);
    assert.ok(tentativa);
    assert.equal(tentativa.origem, "manual", "Tentativa deve ter origem 'manual'");
    assert.equal(tentativa.status, "sent");
    assert.ok(tentativa.mensagem_snapshot, "Deve gravar snapshot da mensagem");
    assert.ok(tentativa.mensagem_snapshot.includes("31,99"));
    assert.equal(tentativa.destino_id, "120363000000000000@g.us");
    assert.equal(tentativa.destino_nome, "Grupo de Promoções");
    assert.equal(tentativa.plataforma, "shopee");

    // Verificar atividade gravada
    const atividades = listarAtividades({ limit: 5 });
    const atividadeSucesso = atividades.items.find(
      (a) => a.tipo === "envio_sucesso" && a.tentativa_id === tentativaSentId,
    );
    assert.ok(atividadeSucesso, "Atividade envio_sucesso deve ser registrada");
  }

  // -------------------------------------------------------------
  // 11. Falha conhecida vira 'failed'
  // -------------------------------------------------------------
  let tentativaFailedId: number = 0;
  {
    mockStatusWhats(false); // WhatsApp desconectado

    const res = await api.req("/api/sends/manual", {
      method: "POST",
      body: JSON.stringify({
        url: "https://shopee.com.br/product/3000/333",
        nome: "Teclado Mecânico Shopee",
        precoAtual: "89,90",
      }),
    });
    registrarResposta("11.falha_conhecida", res.json);

    assert.equal(res.status, 503);
    const json = res.json as any;
    assert.equal(json.error.code, "WHATSAPP_OFFLINE");

    // Verificar banco
    const tentativas = api.db
      .prepare(
        "SELECT * FROM tentativas_de_envio WHERE plataforma = 'shopee' AND status = 'failed' ORDER BY id DESC LIMIT 1",
      )
      .get() as any;
    assert.ok(tentativas);
    assert.equal(tentativas.origem, "manual");
    assert.equal(tentativas.status, "failed");
    assert.equal(tentativas.motivo, "WhatsApp não está conectado");
    tentativaFailedId = tentativas.id;

    // Verificar atividade gravada
    const atividades = listarAtividades({ limit: 5 });
    const ativFalha = atividades.items.find(
      (a) => a.tipo === "envio_falha" && a.tentativa_id === tentativaFailedId,
    );
    assert.ok(ativFalha, "Atividade envio_falha deve ser registrada");

    mockStatusWhats(true); // Restaurar WhatsApp
  }

  // -------------------------------------------------------------
  // 12. Erro após despacho vira 'ambiguous' / 'needsReview: true'
  // -------------------------------------------------------------
  let tentativaAmbiguousId: number = 0;
  {
    definirEnviadorParaTeste(async () => {
      throw new Error("Falha de rede após confirmação de handshake");
    });

    const res = await api.req("/api/sends/manual", {
      method: "POST",
      body: JSON.stringify({
        url: "https://shopee.com.br/product/3000/333",
        nome: "Teclado Mecânico Shopee",
        precoAtual: "89,90",
      }),
    });
    registrarResposta("12.erro_despacho", res.json);

    assert.equal(res.status, 502);
    const json = res.json as any;
    assert.equal(json.sucesso, false);
    assert.equal(json.status, "ambiguous");
    assert.equal(json.needsReview, true);
    tentativaAmbiguousId = json.tentativaId;

    // Verificar banco
    const tentativa = buscarTentativaEnvioPorId(tentativaAmbiguousId);
    assert.ok(tentativa);
    assert.equal(tentativa.status, "ambiguous");
    assert.ok(tentativa.motivo?.includes("Falha de rede após confirmação"));

    // Restaurar enviador funcional
    definirEnviadorParaTeste(async (dados) => {
      mensagensEnviadas.push(dados);
    });
  }

  // -------------------------------------------------------------
  // 13. Idempotência igual e conflito por payload diferente
  // -------------------------------------------------------------
  {
    const payloadP1 = {
      url: "https://shopee.com.br/product/2000/222",
      nome: "Mouse Gamer Shopee",
      precoAtual: "49,90",
    };

    // 13.1 Primeira chamada com Idempotency-Key
    const res1 = await api.req("/api/sends/manual", {
      method: "POST",
      headers: { "Idempotency-Key": "idemp-shopee-test-1" },
      body: JSON.stringify(payloadP1),
    });
    registrarResposta("13.idemp_1", res1.json);
    assert.equal(res1.status, 200);
    const idPrimeiraTentativa = (res1.json as any).tentativaId;

    // 13.2 Replay com mesmo Idempotency-Key e mesmo payload
    const resReplay = await api.req("/api/sends/manual", {
      method: "POST",
      headers: { "Idempotency-Key": "idemp-shopee-test-1" },
      body: JSON.stringify(payloadP1),
    });
    registrarResposta("13.idemp_replay", resReplay.json);
    assert.equal(resReplay.status, 200);
    assert.equal(
      (resReplay.json as any).tentativaId,
      idPrimeiraTentativa,
      "Replay idempotente com mesmo payload deve retornar mesma tentativa",
    );

    // 13.3 Conflito com mesmo Idempotency-Key e payload diferente
    const resConflito = await api.req("/api/sends/manual", {
      method: "POST",
      headers: { "Idempotency-Key": "idemp-shopee-test-1" },
      body: JSON.stringify({
        ...payloadP1,
        precoAtual: "99,90", // alterado!
      }),
    });
    registrarResposta("13.idemp_conflito", resConflito.json);
    assert.equal(resConflito.status, 409, "Payload diferente com mesma chave deve retornar 409");
    assert.equal((resConflito.json as any).error.code, "CONFLITO");
  }

  // -------------------------------------------------------------
  // 14. Produto já enviado hoje é sinalizado / bloqueado
  // -------------------------------------------------------------
  {
    // O produto 2000/222 foi enviado no passo 13
    const urlEnviado = "https://shopee.com.br/product/2000/222";

    // 14.1 Sinalizado no resolve
    const resResolve = await api.req("/api/sends/manual/resolve", {
      method: "POST",
      body: JSON.stringify({ url: urlEnviado }),
    });
    registrarResposta("14.resolve_duplicado", resResolve.json);
    assert.equal(resResolve.status, 200);
    assert.equal(
      (resResolve.json as any).produtoJaEnviadoHoje,
      true,
      "Resolve deve sinalizar produtoJaEnviadoHoje: true",
    );
    assert.ok((resResolve.json as any).enviadoEm !== null);

    // 14.2 Sinalizado no preview
    const resPreview = await api.req("/api/sends/manual/preview", {
      method: "POST",
      body: JSON.stringify({ url: urlEnviado, precoAtual: "49,90" }),
    });
    registrarResposta("14.preview_duplicado", resPreview.json);
    assert.equal(resPreview.status, 200);
    assert.equal((resPreview.json as any).produtoJaEnviadoHoje, true);

    // 14.3 Bloqueado no envio novo
    const resEnvio = await api.req("/api/sends/manual", {
      method: "POST",
      body: JSON.stringify({ url: urlEnviado, precoAtual: "49,90" }),
    });
    registrarResposta("14.envio_bloqueado", resEnvio.json);
    assert.equal(
      resEnvio.status,
      422,
      "Envio de produto já enviado hoje deve ser bloqueado com 422",
    );
    assert.equal((resEnvio.json as any).error.code, "PRODUTO_JA_ENVIADO_HOJE");
  }

  // -------------------------------------------------------------
  // 15. Listagem, summary, snapshot e retry bloqueado para 'sent'
  // -------------------------------------------------------------
  {
    // 15.1 Listagem GET /api/sends
    const resList = await api.req("/api/sends?page=1&limit=10&plataforma=shopee");
    registrarResposta("15.listagem", resList.json);
    assert.equal(resList.status, 200);
    const jsonList = resList.json as any;
    assert.ok(Array.isArray(jsonList.items));
    assert.ok(jsonList.total >= 3);
    assert.equal(jsonList.page, 1);
    assert.equal(jsonList.limit, 10);

    const tentativaSent = jsonList.items.find((i: any) => i.id === tentativaSentId);
    assert.ok(tentativaSent);
    assert.equal(tentativaSent.status, "sent");
    assert.equal(tentativaSent.needsReview, false);
    assert.equal(tentativaSent.origem, "manual");
    assert.equal(tentativaSent.mensagem.disponivel, true);

    // 15.2 Resumo GET /api/sends/summary
    const resSummary = await api.req("/api/sends/summary");
    registrarResposta("15.summary", resSummary.json);
    assert.equal(resSummary.status, 200);
    const jsonSummary = resSummary.json as any;
    assert.equal(typeof jsonSummary.ativo, "boolean");
    assert.equal(typeof jsonSummary.limiteDiario, "number");
    assert.equal(typeof jsonSummary.enviadosHoje, "number");
    assert.deepEqual(jsonSummary.plataformasPermitidas, ["shopee", "mercado_livre"]);
    assert.equal(jsonSummary.formatoMensagem, "padrao");
    assert.ok("destino" in jsonSummary);

    // 15.3 Mensagem snapshot GET /api/sends/:attemptId/message
    const resMsgSent = await api.req(`/api/sends/${tentativaSentId}/message`);
    registrarResposta("15.message_snapshot", resMsgSent.json);
    assert.equal(resMsgSent.status, 200);
    const jsonMsgSent = resMsgSent.json as any;
    assert.equal(jsonMsgSent.disponivel, true);
    assert.ok(typeof jsonMsgSent.texto === "string" && jsonMsgSent.texto.includes("31,99"));

    // Tentativa inexistente -> 404
    const resMsg404 = await api.req("/api/sends/999999/message");
    assert.equal(resMsg404.status, 404);

    // 15.4 Retry bloqueado para 'sent'
    const resRetrySent = await api.req(`/api/sends/${tentativaSentId}/retry`, {
      method: "POST",
    });
    registrarResposta("15.retry_sent", resRetrySent.json);
    assert.equal(
      resRetrySent.status,
      400,
      "Retry em tentativa sent deve ser bloqueado com 400",
    );
    assert.equal((resRetrySent.json as any).error.code, "ENVIO_JA_REALIZADO");

    // Retry em tentativa com status 'failed' ou 'ambiguous'
    if (tentativaFailedId > 0) {
      const resRetryFailed = await api.req(`/api/sends/${tentativaFailedId}/retry`, {
        method: "POST",
      });
      assert.ok(
        resRetryFailed.status === 200 || resRetryFailed.status === 502,
        "Retry em tentativa failed deve tentar reenviar",
      );
    }
  }

  // -------------------------------------------------------------
  // 16. Nenhuma resposta contém segredos ou link original como final
  // -------------------------------------------------------------
  {
    const palavrasProibidas = ["cookie", "csrf", "secret", "token"];

    for (const { rota, json } of todasRespostasParaAuditoria) {
      const texto = JSON.stringify(json).toLowerCase();
      for (const proibida of palavrasProibidas) {
        assert.ok(
          !texto.includes(proibida),
          `Resposta da rota '${rota}' vazou '${proibida}'! Conteúdo: ${texto.slice(0, 200)}`,
        );
      }
    }

    // Verificar que o linkAfiliado gerado NUNCA é o link original
    const resPreview = await api.req("/api/sends/manual/preview", {
      method: "POST",
      body: JSON.stringify({
        url: "https://shopee.com.br/product/1000/111",
        precoAtual: "31,99",
      }),
    });
    const jsonPreview = resPreview.json as any;
    assert.notEqual(
      jsonPreview.linkAfiliado,
      "https://shopee.com.br/product/1000/111",
      "Link afiliado NUNCA deve ser igual ao link original",
    );
  }

  console.log("Resultado: envio manual shopee passou");
} finally {
  await api.encerrar();
}
