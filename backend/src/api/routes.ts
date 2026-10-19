import { Router, type RequestHandler } from "express";
import {
  randomUUID,
  timingSafeEqual,
  createHmac,
  randomBytes,
} from "node:crypto";
import { enviarErro, envelopeLista } from "./respostas.js";
import {
  authLimiter,
  whatsappReconnectLimiter,
  whatsappTestLimiter,
  whatsappEventsLimiter,
  sendsLimiter,
  scrapingLimiter,
  syncLimiter,
  settingsLimiter,
  healthLimiter,
} from "./rate-limiters.js";
import {
  alternarSelecao,
  listarProdutos,
  listarIntegracoes,
  atualizarAtivacaoIntegracao,
  obterResumoFila,
  listarProdutosPaginado,
  buscarProdutoComPlataforma,
  listarTentativasEnvio,
  obterUltimaComissao,
  listarAtividades,
  gravarAtividade,
  obterEstadoPlataforma,
  listarPlataformas,
  atualizarSincronizacaoPlataforma,
  atualizarStatusIntegracao,
  adquirirLockExecucao,
  liberarLockExecucao,
  sanitizarTextoAtividade,
  ABAS_PRODUTOS,
  buscarTentativaEnvioPorId,
  buscarProdutoPorExternalId,
  listarEnviosPaginado,
  enviosHoje,
  obterDadosDashboard,
  atualizarLinkAfiliadoPorFonte,
  contarTotalProdutos,
  salvarSessao,
  buscarSessaoValida,
  removerSessao,
  buscarSessaoAfiliado,
  type AbaProdutos,
  type ProdutoComPlataforma,
  type TentativaEnvio,
  type Produto,
} from "../db/queries.js";
import { calcularProximoEnvio, formatarDataIso } from "../lib/time.js";
import {
  normalizarUrlShopee,
  resolverLinkShopee,
  gerarPreviewManualShopee,
  executarEnvioManualShopee,
  ShopeeUrlError,
} from "../whatsapp/envio-manual-shopee.js";
import {
  sincronizarPlataforma,
  temAffiliateProvider,
  getAffiliateProvider,
} from "../integrations/registry.js";
import type { IntegrationKey } from "../integrations/types.js";
import {
  getQrCode,
  getStatusConexao,
  inscreverMudancasConexao,
  listarGruposWhatsApp,
  solicitarReconexao,
  getNumeroConectado,
  desconectarWhatsApp,
  solicitarCodigoPareamento,
  getCodigoPareamento,
} from "../whatsapp/connection.js";
import { getConfig, setConfig } from "../db/queries.js";
import {
  reenviarManualIdempotente,
  statusHttpReenvioManual,
} from "../whatsapp/manual.js";
import {
  obterConfigScheduler,
  obterEstadoScheduler,
  salvarConfigScheduler,
  MAX_HORARIOS_SCHEDULER,
  type ConfigScheduler,
} from "../auto/scheduler.js";
import {
  configurarSessaoML,
  gerarLinkAfiliado,
  SessionExpiredError,
} from "../affiliate/mercadolivre/provider.js";

function statusApresentacao(p: Produto): string {
  if (p.enviado === 1 || p.status_fila === "sent") return "sent";
  if (p.status_fila === "ambiguous") return "needs_review";
  if (p.status_fila === "failed") return "failed";
  return "pending";
}

function produtoParaResposta(p: ProdutoComPlataforma) {
  const ultima = obterUltimaComissao(p.id);
  const valorComissao =
    p.source_key === "shopee" && ultima && ultima.comissao_valor !== null
      ? ultima.comissao_valor
      : null;

  return {
    id: p.id,
    plataforma: { key: p.source_key, nome: p.plataforma_nome },
    nome: p.nome,
    precoAtual: p.preco_atual,
    precoOriginal: p.preco_original,
    descontoPercentual: p.desconto_percentual,
    imagemUrl: p.imagem_url,
    linkOriginal: p.link_original,
    linkAfiliado: p.link_afiliado,
    linkAfiliadoValido:
      Boolean(p.link_afiliado.trim()) && p.link_afiliado !== p.link_original,
    status: statusApresentacao(p),
    needsReview: p.status_fila === "ambiguous",
    emAndamento: p.status_fila === "sending",
    selecionado: p.selecionado === 1,
    tentativas: p.tentativas_envio,
    ultimoErro: p.ultimo_erro_envio,
    ofertaExpiraEm: p.oferta_expira_em,
    criadoEm: formatarDataIso(p.criado_em),
    comissao: {
      valor: valorComissao,
      disponivel: valorComissao !== null && p.source_key === "shopee",
      estimada: true,
    },
  };
}

function tentativaParaResposta(t: TentativaEnvio) {
  return {
    id: t.id,
    origem: (t.origem as string) === "automatico" ? "auto" : t.origem,
    status: t.status,
    needsReview: t.status === "ambiguous",
    motivo: t.motivo,
    iniciadoEm: formatarDataIso(t.iniciado_em),
    finalizadoEm: formatarDataIso(t.finalizado_em),
    mensagem: {
      disponivel: Boolean(t.mensagem_snapshot),
      texto: t.mensagem_snapshot ?? null,
    },
    destino: { id: t.destino_id, nome: t.destino_nome },
    plataforma: t.plataforma,
    titulo: t.titulo,
  };
}

function compararCredenciaisSeguro(a: string, b: string): boolean {
  const chave = randomBytes(32);
  const hmacA = createHmac("sha256", chave).update(a).digest();
  const hmacB = createHmac("sha256", chave).update(b).digest();
  return timingSafeEqual(hmacA, hmacB);
}

const router = Router();

router.post("/auth/login", authLimiter, (req, res) => {
  const usuarioEsperado = process.env.PAINEL_USER;
  const senhaEsperada = process.env.PAINEL_SENHA;

  if (!usuarioEsperado || !senhaEsperada) {
    return enviarErro(res, 503, "AUTH_NAO_CONFIGURADA", "autenticação administrativa não configurada");
  }

  const { usuario, senha } = req.body ?? {};
  if (!usuario || !senha || typeof usuario !== "string" || typeof senha !== "string") {
    return enviarErro(res, 400, "REQUISICAO_INVALIDA", "usuário e senha são obrigatórios");
  }

  const usuarioValido = compararCredenciaisSeguro(usuario, usuarioEsperado);
  const senhaValida = compararCredenciaisSeguro(senha, senhaEsperada);

  if (!usuarioValido || !senhaValida) {
    return enviarErro(res, 401, "CREDENCIAS_INVALIDAS", "usuário ou senha incorretos");
  }

  const token = randomBytes(32).toString("hex");
  salvarSessao(token, usuarioEsperado);

  res.cookie("loot_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 15 * 24 * 60 * 60 * 1000,
  });

  res.json({ sucesso: true, usuario: usuarioEsperado });
});

router.post("/auth/logout", (req, res) => {
  const tokenCookie = (req as any).cookies?.loot_session;
  if (typeof tokenCookie === "string") {
    removerSessao(tokenCookie);
  }
  res.clearCookie("loot_session", {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });
  res.json({ sucesso: true });
});

router.get("/auth/me", (req, res) => {
  const tokenCookie = (req as any).cookies?.loot_session;
  if (tokenCookie) {
    const sessao = buscarSessaoValida(tokenCookie);
    if (sessao) {
      return res.json({ autenticado: true, usuario: sessao.usuario });
    }
  }

  // Fallback para header de teste
  const usuarioConfig = process.env.PAINEL_USER;
  const senhaConfig = process.env.PAINEL_SENHA;
  if (process.env.NODE_ENV === "test" && usuarioConfig && senhaConfig) {
    const autorizacao = req.header("authorization");
    const esperado = `Basic ${Buffer.from(`${usuarioConfig}:${senhaConfig}`).toString("base64")}`;
    if (autorizacao && compararCredenciaisSeguro(autorizacao, esperado)) {
      return res.json({ autenticado: true, usuario: usuarioConfig });
    }
  }

  return enviarErro(res, 401, "NAO_AUTENTICADO", "não autenticado");
});

const exigirAutenticacao: RequestHandler = (req, res, next) => {
  // 1. Validação via Cookie HttpOnly
  const tokenCookie = (req as any).cookies?.loot_session;
  if (tokenCookie) {
    const sessao = buscarSessaoValida(tokenCookie);
    if (sessao) {
      (req as any).usuario = sessao.usuario;
      return next();
    }
  }

  // 2. Fallback de compatibilidade para suíte de testes existente (Basic Auth)
  const usuarioConfig = process.env.PAINEL_USER;
  const senhaConfig = process.env.PAINEL_SENHA;
  if (process.env.NODE_ENV === "test" && usuarioConfig && senhaConfig) {
    const autorizacao = req.header("authorization");
    const esperado = `Basic ${Buffer.from(`${usuarioConfig}:${senhaConfig}`).toString("base64")}`;
    if (autorizacao && compararCredenciaisSeguro(autorizacao, esperado)) {
      return next();
    }
  }

  res.setHeader("WWW-Authenticate", "Basic realm=Loot");
  enviarErro(res, 401, "NAO_AUTENTICADO", "autenticação necessária");
};

router.use(exigirAutenticacao);

router.get("/health", healthLimiter, (req, res) => {
  res.json({ status: "ok" });
});

router.get("/dashboard", (req, res) => {
  const period = req.query.period;
  if (period !== undefined && period !== "7d") {
    return enviarErro(
      res,
      400,
      "PARAMETRO_INVALIDO",
      "Período inválido. Período suportado: 7d",
    );
  }

  const dados = obterDadosDashboard("7d");
  res.json(dados);
});

router.get("/produtos", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;

  const statusRaw =
    req.query.status !== undefined ? String(req.query.status) : "all";
  if (!ABAS_PRODUTOS.includes(statusRaw as AbaProdutos)) {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "status inválido");
  }
  const aba = statusRaw as AbaProdutos;

  let page = 1;
  if (req.query.page !== undefined) {
    const p = Number(req.query.page);
    if (!Number.isInteger(p) || p < 1) {
      return enviarErro(
        res,
        400,
        "PARAMETRO_INVALIDO",
        "page deve ser um inteiro >= 1",
      );
    }
    page = p;
  }

  let limit = 20;
  if (req.query.limit !== undefined) {
    const l = Number(req.query.limit);
    if (!Number.isInteger(l) || l < 1 || l > 100) {
      return enviarErro(
        res,
        400,
        "PARAMETRO_INVALIDO",
        "limit deve ser um inteiro entre 1 e 100",
      );
    }
    limit = l;
  }

  const { items, total, contagens } = listarProdutosPaginado({
    q,
    aba,
    page,
    limit,
  });
  res.json(
    envelopeLista(items.map(produtoParaResposta), page, limit, total, {
      counts: contagens,
    }),
  );
});

router.get("/produtos/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return enviarErro(
      res,
      400,
      "PARAMETRO_INVALIDO",
      "id deve ser um inteiro positivo",
    );
  }

  const p = buscarProdutoComPlataforma(id);
  if (!p) {
    return enviarErro(res, 404, "NAO_ENCONTRADO", "produto não encontrado");
  }

  const ultimaComissao = obterUltimaComissao(p.id);
  const comissao = ultimaComissao
    ? {
        valor: ultimaComissao.comissao_valor,
        percentual: ultimaComissao.comissao_percentual,
        disponivel: true,
        estimada: true,
        coletadaEm: ultimaComissao.coletado_em,
      }
    : {
        valor: null,
        percentual: null,
        disponivel: false,
        estimada: true,
        coletadaEm: null,
      };

  res.json({
    ...produtoParaResposta(p),
    comissao,
    pedidos: { disponivel: false, motivo: "fonte de dados não confirmada" },
    tentativas: listarTentativasEnvio(id).map(tentativaParaResposta),
  });
});

router.get(["/produtos/:id/tentativas", "/produtos/:id/attempts"], (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return enviarErro(
      res,
      400,
      "PARAMETRO_INVALIDO",
      "id deve ser um inteiro positivo",
    );
  }

  const p = buscarProdutoComPlataforma(id);
  if (!p) {
    return enviarErro(res, 404, "NAO_ENCONTRADO", "produto não encontrado");
  }

  const tentativas = listarTentativasEnvio(id).map(tentativaParaResposta);
  res.json(
    envelopeLista(tentativas, 1, tentativas.length || 1, tentativas.length),
  );
});

router.get("/activities", (req, res) => {
  let page = 1;
  if (req.query.page !== undefined) {
    const p = Number(req.query.page);
    if (!Number.isInteger(p) || p < 1) {
      return enviarErro(
        res,
        400,
        "PARAMETRO_INVALIDO",
        "page deve ser um inteiro >= 1",
      );
    }
    page = p;
  }

  let limit = 20;
  if (req.query.limit !== undefined) {
    const l = Number(req.query.limit);
    if (!Number.isInteger(l) || l < 1 || l > 100) {
      return enviarErro(
        res,
        400,
        "PARAMETRO_INVALIDO",
        "limit deve ser um inteiro entre 1 e 100",
      );
    }
    limit = l;
  }

  const tipo = typeof req.query.tipo === "string" ? req.query.tipo : undefined;
  const plataforma =
    typeof req.query.plataforma === "string" ? req.query.plataforma : undefined;

  const { items, total } = listarAtividades({ page, limit, tipo, plataforma });
  res.json(
    envelopeLista(
      items.map((a) => ({
        id: a.id,
        tipo: a.tipo,
        integracaoKey: a.integracao_key,
        plataforma: a.integracao_key,
        produtoId: a.produto_id,
        tentativaId: a.tentativa_id,
        titulo: a.titulo,
        detalhe: a.detalhe,
        criadoEm: formatarDataIso(a.criado_em),
      })),
      page,
      limit,
      total,
    ),
  );
});

inscreverMudancasConexao((status) => {
  gravarAtividade({
    tipo: "whatsapp_status",
    titulo: `WhatsApp: ${status.estado}`,
    detalhe: `Conectado: ${status.conectado}`,
  });
});

router.get("/whatsapp/status", (req, res) => {
  const status = getStatusConexao();
  res.json(status);
});

router.get("/whatsapp/qr", (_req, res) => {
  res.json(getQrCode());
});

router.get("/whatsapp/pairing-code", (_req, res) => {
  res.json(getCodigoPareamento());
});

router.post("/whatsapp/pairing-code", whatsappReconnectLimiter, async (req, res) => {
  const telefone = req.body?.telefone;
  if (typeof telefone !== "string" || !telefone.trim()) {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "Número de telefone é obrigatório");
  }
  try {
    const codigo = await solicitarCodigoPareamento(telefone);
    res.json({ sucesso: true, codigo });
  } catch (erro) {
    const msg = erro instanceof Error ? erro.message : String(erro);
    console.error("[API] Falha em /whatsapp/pairing-code:", erro);
    enviarErro(res, 400, "ERRO_PAREAMENTO", msg);
  }
});

router.post("/whatsapp/reconnect", whatsappReconnectLimiter, async (_req, res) => {
  const { forcarNovoQr } = _req.body as { forcarNovoQr?: unknown };

  try {
    await solicitarReconexao({ forcarNovoQr: forcarNovoQr === true });
    res.json(getStatusConexao());
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    if (mensagem.startsWith("sessão deslogada")) {
      return enviarErro(res, 409, "SESSAO_DESLOGADA", mensagem, {
        acao: "envie forcarNovoQr: true para gerar um novo QR Code",
      });
    }

    console.error("falha ao solicitar reconexão do WhatsApp:", erro);
    enviarErro(
      res,
      503,
      "WHATSAPP_OFFLINE",
      "não foi possível iniciar a conexão do WhatsApp",
    );
  }
});

router.post("/whatsapp/disconnect", async (_req, res) => {
  try {
    await desconectarWhatsApp();

    // Paralisa o envio automático e salva auto_envio_ativo = false
    const configAtual = obterConfigScheduler();
    salvarConfigScheduler({ ...configAtual, ativo: false });

    gravarAtividade({
      tipo: "whatsapp_status",
      titulo: "WhatsApp: desconectado",
      detalhe: "WhatsApp desconectado pelo painel; envio automático pausado",
    });

    res.json({
      sucesso: true,
      status: getStatusConexao(),
      autoEnvioAtivo: false,
    });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    console.error("falha ao desconectar WhatsApp:", erro);
    enviarErro(res, 500, "ERRO_INTERNO", `Falha ao desconectar WhatsApp: ${mensagem}`);
  }
});

router.get("/whatsapp/events", whatsappEventsLimiter, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const enviarStatus = () => {
    res.write(`event: status\ndata: ${JSON.stringify(getStatusConexao())}\n\n`);
  };

  enviarStatus();
  const removerListener = inscreverMudancasConexao(enviarStatus);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removerListener();
  });
});

router.get("/whatsapp/groups", async (_req, res) => {
  try {
    const grupos = await listarGruposWhatsApp();
    res.json({
      grupos,
      grupoSelecionadoId: getConfig("whatsapp_grupo_id") || null,
    });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    if (mensagem === "WhatsApp não está conectado") {
      return enviarErro(res, 503, "WHATSAPP_OFFLINE", mensagem);
    }

    console.error("falha ao listar grupos do WhatsApp:", erro);
    enviarErro(res, 502, "ERRO_INTERNO", "não foi possível listar os grupos");
  }
});

router.put("/whatsapp/group", async (req, res) => {
  const { groupId } = req.body as { groupId?: unknown };
  if (typeof groupId !== "string" || groupId.trim() === "") {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "groupId é obrigatório");
  }

  try {
    const grupos = await listarGruposWhatsApp();
    const grupo = grupos.find((item) => item.id === groupId);
    if (!grupo) {
      return enviarErro(res, 404, "NAO_ENCONTRADO", "grupo não encontrado no WhatsApp");
    }

    setConfig("whatsapp_grupo_id", grupo.id);
    setConfig("whatsapp_grupo_nome", grupo.nome);
    res.json({ sucesso: true, grupo });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    if (mensagem === "WhatsApp não está conectado") {
      return enviarErro(res, 503, "WHATSAPP_OFFLINE", mensagem);
    }

    console.error("falha ao selecionar grupo do WhatsApp:", erro);
    enviarErro(res, 502, "ERRO_INTERNO", "não foi possível validar o grupo");
  }
});

router.delete("/whatsapp/group", (_req, res) => {
  setConfig("whatsapp_grupo_id", "");
  setConfig("whatsapp_grupo_nome", "");
  const configAtual = obterConfigScheduler();
  if (configAtual.ativo) {
    salvarConfigScheduler({ ...configAtual, ativo: false });
  }
  res.json({ sucesso: true });
});

router.post("/whatsapp/test", whatsappTestLimiter, async (_req, res) => {
  const status = getStatusConexao();
  if (!status.conectado) {
    return enviarErro(res, 503, "WHATSAPP_OFFLINE", "WhatsApp não está conectado");
  }

  const destinoId = getConfig("whatsapp_grupo_id") || "";
  const destinoNomeConfig = getConfig("whatsapp_grupo_nome") || "";

  if (!destinoId) {
    return res.json({
      sucesso: false,
      conectado: true,
      grupoValido: false,
      status: "aviso",
      diagnostico: "WhatsApp conectado, mas nenhum grupo de destino está configurado.",
      destino: null,
    });
  }

  try {
    const grupos = await listarGruposWhatsApp();
    const grupoEncontrado = grupos.find((g) => g.id === destinoId);

    if (!grupoEncontrado) {
      return res.json({
        sucesso: false,
        conectado: true,
        grupoValido: false,
        status: "aviso",
        diagnostico: `WhatsApp conectado, mas o grupo configurado (${destinoNomeConfig || destinoId}) não foi encontrado na conta.`,
        destino: {
          id: destinoId,
          nome: destinoNomeConfig || null,
        },
      });
    }

    return res.json({
      sucesso: true,
      conectado: true,
      grupoValido: true,
      status: "ok",
      diagnostico: `WhatsApp conectado e grupo de destino "${grupoEncontrado.nome}" verificado com sucesso.`,
      destino: {
        id: grupoEncontrado.id,
        nome: grupoEncontrado.nome,
      },
    });
  } catch (erro) {
    return res.json({
      sucesso: false,
      conectado: true,
      grupoValido: false,
      status: "erro",
      diagnostico: `Erro ao verificar grupos do WhatsApp: ${erro instanceof Error ? erro.message : String(erro)}`,
      destino: {
        id: destinoId,
        nome: destinoNomeConfig || null,
      },
    });
  }
});


router.get("/config", (req, res) => {
  const config = {
    auto_envio_ativo: getConfig("auto_envio_ativo"),
    limite_diario: getConfig("limite_diario"),
    desconto_minimo_global: getConfig("desconto_minimo_global"),
  };
  res.json(config);
});

router.post("/config", (req, res) => {
  const { chave, valor } = req.body;

  if (!chave || !valor) {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "chave e valor são obrigatórios");
  }

  setConfig(chave, valor);
  res.json({ sucesso: true });
});

router.get("/scheduler", (_req, res) => {
  res.json(obterEstadoScheduler());
});

router.get("/integrations", (_req, res) => {
  res.json({ integrations: listarIntegracoes() });
});

router.put("/integrations/:key/active", (req, res) => {
  const active = req.body?.active;
  if (typeof active !== "boolean") {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "active deve ser booleano");
  }

  try {
    atualizarAtivacaoIntegracao(req.params.key, active);
    res.json({ integrations: listarIntegracoes() });
  } catch (erro) {
    return enviarErro(
      res,
      404,
      "NAO_ENCONTRADO",
      erro instanceof Error ? erro.message : String(erro),
    );
  }
});

function mascararAppId(appId: string | null | undefined): string | null {
  if (!appId) return null;
  const s = String(appId).trim();
  if (s.length <= 4) return "****";
  const prefixo = s.slice(0, 2);
  const sufixo = s.slice(-2);
  return `${prefixo}${"*".repeat(Math.max(2, s.length - 4))}${sufixo}`;
}

function mascararSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  return "********";
}

router.get("/platforms", (_req, res) => {
  res.json(listarPlataformas());
});

router.get("/platforms/:key", (req, res) => {
  const plat = obterEstadoPlataforma(req.params.key);
  if (!plat) {
    return enviarErro(res, 404, "PLATAFORMA_NAO_ENCONTRADA", "plataforma não encontrada");
  }
  res.json(plat);
});

router.put("/platforms/:key/active", (req, res) => {
  const activeRaw = req.body?.active ?? req.body?.ativo;
  if (typeof activeRaw !== "boolean") {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "active deve ser booleano");
  }

  const key = req.params.key;
  if (key === "tiktok_shop") {
    return enviarErro(res, 422, "PLATAFORMA_INDISPONIVEL", "Não disponível nesta versão");
  }

  try {
    const estado = atualizarAtivacaoIntegracao(key, activeRaw);
    if (!estado) {
      return enviarErro(res, 404, "PLATAFORMA_NAO_ENCONTRADA", "plataforma não encontrada");
    }
    res.json(estado);
  } catch (erro) {
    return enviarErro(
      res,
      404,
      "PLATAFORMA_NAO_ENCONTRADA",
      erro instanceof Error ? erro.message : String(erro),
    );
  }
});

router.post("/platforms/:key/sync", syncLimiter, async (req, res) => {
  const key = req.params.key as string;
  const plat = obterEstadoPlataforma(key);
  if (!plat) {
    return enviarErro(res, 404, "PLATAFORMA_NAO_ENCONTRADA", "plataforma não encontrada");
  }

  if (!plat.available) {
    return enviarErro(
      res,
      422,
      "PLATAFORMA_INDISPONIVEL",
      plat.motivo || "Não disponível nesta versão",
    );
  }

  const lockName = `sync_${key}`;
  const lockToken = randomUUID();
  if (!adquirirLockExecucao(lockName, lockToken, 60_000)) {
    return enviarErro(
      res,
      409,
      "SINCRONIZACAO_EM_ANDAMENTO",
      "sincronização já em andamento",
    );
  }

  gravarAtividade({
    tipo: "sincronizacao_inicio",
    integracao_key: key,
    titulo: `Sincronização iniciada: ${plat.nome}`,
    detalhe: "Início da sincronização manual",
  });

  try {
    const salvas = await sincronizarPlataforma(key);
    const agoraIso = new Date().toISOString();
    atualizarSincronizacaoPlataforma(key, {
      status: "connected",
      ultimaSincronizacao: agoraIso,
      ultimoErro: null,
    });
    gravarAtividade({
      tipo: "sincronizacao_sucesso",
      integracao_key: key,
      titulo: `Sincronização concluída: ${plat.nome}`,
      detalhe: `${salvas} ofertas salvas`,
    });
    const atualizado = obterEstadoPlataforma(key);
    res.json({ sucesso: true, ...atualizado });
  } catch (erro) {
    const mensagemRaw = erro instanceof Error ? erro.message : String(erro);
    const mensagem = sanitizarTextoAtividade(mensagemRaw) ?? "Falha na sincronização";
    atualizarSincronizacaoPlataforma(key, {
      status: "disconnected",
      ultimoErro: mensagem,
    });
    gravarAtividade({
      tipo: "sincronizacao_falha",
      integracao_key: key,
      titulo: `Falha na sincronização: ${plat.nome}`,
      detalhe: mensagem.slice(0, 200),
    });
    return enviarErro(
      res,
      502,
      "SINCRONIZACAO_FALHOU",
      `Falha na sincronização de ${plat.nome}: ${mensagem}`,
    );
  } finally {
    liberarLockExecucao(lockName, lockToken);
  }
});

router.get("/platforms/:key/config", (req, res) => {
  const key = req.params.key;
  if (key === "tiktok_shop") {
    return enviarErro(res, 422, "PLATAFORMA_INDISPONIVEL", "Não disponível nesta versão");
  }
  if (key === "mercado_livre") {
    return enviarErro(res, 400, "NAO_SUPORTADO", "Configuração manual não suportada para Mercado Livre");
  }
  if (key !== "shopee") {
    return enviarErro(res, 404, "PLATAFORMA_NAO_ENCONTRADA", "plataforma não encontrada");
  }

  const appIdRaw = getConfig("shopee_app_id") || process.env.SHOPEE_APP_ID || null;
  const secretRaw = getConfig("shopee_secret") || process.env.SHOPEE_SECRET || null;
  const plat = obterEstadoPlataforma("shopee");

  res.json({
    key: "shopee",
    nome: "Shopee",
    appId: mascararAppId(appIdRaw),
    apiKey: mascararSecret(secretRaw),
    apiKeyConfigurada: Boolean(secretRaw),
    status: plat?.status ?? "not_configured",
    ultimaSincronizacao: plat?.ultimaSincronizacao ?? null,
  });
});

router.put("/platforms/:key/config", (req, res) => {
  const key = req.params.key;
  if (key === "tiktok_shop") {
    return enviarErro(res, 422, "PLATAFORMA_INDISPONIVEL", "Não disponível nesta versão");
  }
  if (key === "mercado_livre") {
    return enviarErro(res, 400, "NAO_SUPORTADO", "Configuração manual não suportada para Mercado Livre");
  }
  if (key !== "shopee") {
    return enviarErro(res, 404, "PLATAFORMA_NAO_ENCONTRADA", "plataforma não encontrada");
  }

  const { appId, apiKey, secret } = req.body as {
    appId?: string | undefined;
    apiKey?: string | undefined;
    secret?: string | undefined;
  };

  if (appId !== undefined) {
    setConfig("shopee_app_id", appId.trim());
  }
  const novoSecret = apiKey ?? secret;
  if (novoSecret !== undefined) {
    setConfig("shopee_secret", novoSecret.trim());
  }

  const appIdSalvo = getConfig("shopee_app_id") || process.env.SHOPEE_APP_ID || null;
  const secretSalvo = getConfig("shopee_secret") || process.env.SHOPEE_SECRET || null;
  if (appIdSalvo && secretSalvo) {
    atualizarStatusIntegracao("shopee", "configured");
  }

  const plat = obterEstadoPlataforma("shopee");
  res.json({
    key: "shopee",
    nome: "Shopee",
    appId: mascararAppId(appIdSalvo),
    apiKey: mascararSecret(secretSalvo),
    apiKeyConfigurada: Boolean(secretSalvo),
    status: plat?.status ?? "configured",
    ultimaSincronizacao: plat?.ultimaSincronizacao ?? null,
  });
});


router.get("/queue/summary", (_req, res) => {
  res.json(obterResumoFila());
});

router.put("/scheduler", settingsLimiter, (req, res) => {
  const {
    ativo,
    horarios,
    limite_diario,
    quantidade_por_execucao,
    intervalo_entre_mensagens_ms,
  } =
    req.body as Partial<ConfigScheduler>;

  const horariosValidos =
    Array.isArray(horarios) &&
    horarios.every(
      (horario) =>
        typeof horario === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(horario),
    );

  if (
    typeof ativo !== "boolean" ||
    !horariosValidos ||
    horarios.length > MAX_HORARIOS_SCHEDULER
  ) {
    return enviarErro(
      res,
      400,
      "PARAMETRO_INVALIDO",
      `ativo deve ser booleano, horarios deve conter horários no formato HH:mm e ter no máximo ${MAX_HORARIOS_SCHEDULER} itens`,
    );
  }

  if (ativo === true) {
    const statusWhatsApp = getStatusConexao();
    if (!statusWhatsApp.conectado) {
      return enviarErro(
        res,
        400,
        "WHATSAPP_DESCONECTADO",
        "Não é possível ativar o envio automático com o WhatsApp desconectado. Conecte o WhatsApp primeiro.",
      );
    }
    const grupoId = getConfig("whatsapp_grupo_id");
    if (!grupoId || !grupoId.trim()) {
      return enviarErro(
        res,
        400,
        "WHATSAPP_SEM_GRUPO",
        "Não é possível ativar o envio automático sem um grupo de destino configurado.",
      );
    }
  }

  const configAtual = obterConfigScheduler();
  const limite =
    limite_diario === undefined
      ? configAtual.limite_diario
      : Number(limite_diario);
  if (!Number.isInteger(limite) || limite < 1 || limite > 100) {
    return enviarErro(
      res,
      400,
      "PARAMETRO_INVALIDO",
      "limite_diario deve ser um número inteiro entre 1 e 100",
    );
  }

  const quantidadeLegada =
    quantidade_por_execucao === undefined
      ? configAtual.quantidade_por_execucao
      : Number(quantidade_por_execucao);

  const intervalo =
    intervalo_entre_mensagens_ms === undefined
      ? configAtual.intervalo_entre_mensagens_ms
      : Number(intervalo_entre_mensagens_ms);
  if (!Number.isInteger(intervalo) || intervalo < 0 || intervalo > 600_000) {
    return enviarErro(
      res,
      400,
      "PARAMETRO_INVALIDO",
      "intervalo_entre_mensagens_ms deve ser um número inteiro entre 0 e 600000",
    );
  }

  const config: ConfigScheduler = {
    ativo,
    horarios: [...new Set(horarios)].sort(),
    limite_diario: limite,
    quantidade_por_execucao:
      Number.isInteger(quantidadeLegada) && quantidadeLegada > 0
        ? quantidadeLegada
        : configAtual.quantidade_por_execucao,
    intervalo_entre_mensagens_ms: intervalo,
  };

  salvarConfigScheduler(config);
  res.json(config);
});

router.get("/settings", async (_req, res) => {
  const config = obterConfigScheduler();
  const statusConexao = getStatusConexao();
  const destinoId = getConfig("whatsapp_grupo_id") || null;
  const destinoNome = getConfig("whatsapp_grupo_nome") || null;
  const janelaShopeeRaw = getConfig("janela_shopee_horas");
  const janelaShopee = janelaShopeeRaw ? Number(janelaShopeeRaw) : 12;

  let grupos: Array<{ id: string; nome: string }> = [];
  if (statusConexao.conectado) {
    try {
      const lista = await listarGruposWhatsApp();
      grupos = lista.map((g) => ({ id: g.id, nome: g.nome }));
    } catch {
      grupos = [];
    }
  }

  res.json({
    scheduler: {
      ativo: config.ativo,
      horarios: config.horarios,
      limiteDiario: config.limite_diario,
      quantidadePorExecucao: config.quantidade_por_execucao,
      intervaloEntreMensagensMs: config.intervalo_entre_mensagens_ms,
      proximoEnvio: calcularProximoEnvio(config.horarios, config.ativo),
      janelaShopeeHoras: Number.isInteger(janelaShopee) && janelaShopee >= 1 ? janelaShopee : 12,
    },
    whatsapp: {
      status: statusConexao.conectado ? "connected" : "disconnected",
      numero: statusConexao.conectado ? getNumeroConectado() : null,
      destino: destinoId ? { id: destinoId, nome: destinoNome } : null,
      grupos,
    },
    storage: {
      tipo: "sqlite",
      totalPromocoes: contarTotalProdutos(),
    },
  });
});

router.put("/settings", settingsLimiter, (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

  const proibidos = [
    "cookie",
    "cookies",
    "csrf",
    "token",
    "secret",
    "shopee_secret",
    "shopee_app_id",
    "app_id",
    "comissao",
    "comissao_valor",
    "tiktok",
    "tiktok_shop",
    "sessao",
    "session",
    "backup",
    "restauracao",
    "restore",
    "credentials",
    "credenciais",
    "senha",
    "password",
  ];

  const checarProibidos = (obj: Record<string, unknown>) => {
    for (const chave of Object.keys(obj)) {
      const normalizada = chave.toLowerCase();
      if (proibidos.some((p) => normalizada.includes(p))) {
        return true;
      }
    }
    return false;
  };

  if (checarProibidos(body)) {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "Parâmetro não permitido em configurações");
  }

  const schedulerInput = (
    body.scheduler && typeof body.scheduler === "object"
      ? (body.scheduler as Record<string, unknown>)
      : body
  ) as Record<string, unknown>;

  if (checarProibidos(schedulerInput)) {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "Parâmetro não permitido em configurações");
  }

  const configAtual = obterConfigScheduler();

  // 1. ativo
  const ativoRaw = schedulerInput.ativo ?? schedulerInput.auto_envio_ativo;
  let ativo = configAtual.ativo;
  if (ativoRaw !== undefined) {
    if (typeof ativoRaw !== "boolean") {
      return enviarErro(res, 400, "PARAMETRO_INVALIDO", "ativo deve ser booleano");
    }
    ativo = ativoRaw;
  }

  if (ativo === true) {
    const statusWhatsApp = getStatusConexao();
    if (!statusWhatsApp.conectado) {
      return enviarErro(
        res,
        400,
        "WHATSAPP_DESCONECTADO",
        "Não é possível ativar o envio automático com o WhatsApp desconectado. Conecte o WhatsApp primeiro.",
      );
    }
    const grupoId = getConfig("whatsapp_grupo_id");
    if (!grupoId || !grupoId.trim()) {
      return enviarErro(
        res,
        400,
        "WHATSAPP_SEM_GRUPO",
        "Não é possível ativar o envio automático sem um grupo de destino configurado.",
      );
    }
  }

  // 2. horarios
  const horariosRaw = schedulerInput.horarios;
  let horarios = configAtual.horarios;
  if (horariosRaw !== undefined) {
    if (
      !Array.isArray(horariosRaw) ||
      horariosRaw.length > MAX_HORARIOS_SCHEDULER ||
      !horariosRaw.every(
        (h) => typeof h === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(h),
      )
    ) {
      return enviarErro(
        res,
        400,
        "PARAMETRO_INVALIDO",
        `horarios deve conter no máximo ${MAX_HORARIOS_SCHEDULER} horários no formato HH:mm`,
      );
    }
    horarios = [...new Set(horariosRaw)].sort();
  }

  // 3. limite diário
  const limiteRaw = schedulerInput.limiteDiario ?? schedulerInput.limite_diario;
  let limite = configAtual.limite_diario;
  if (limiteRaw !== undefined) {
    const l = Number(limiteRaw);
    if (!Number.isInteger(l) || l < 1 || l > 100) {
      return enviarErro(
        res,
        400,
        "PARAMETRO_INVALIDO",
        "limiteDiario deve ser um inteiro entre 1 e 100",
      );
    }
    limite = l;
  }

  // 4. quantidade por execução
  const qtdRaw =
    schedulerInput.quantidadePorExecucao ?? schedulerInput.quantidade_por_execucao;
  let qtd = configAtual.quantidade_por_execucao;
  if (qtdRaw !== undefined) {
    const q = Number(qtdRaw);
    if (!Number.isInteger(q) || q < 1) {
      return enviarErro(
        res,
        400,
        "PARAMETRO_INVALIDO",
        "quantidadePorExecucao deve ser um inteiro positivo",
      );
    }
    qtd = q;
  }

  // 5. intervalo entre mensagens
  const intervaloRaw =
    schedulerInput.intervaloEntreMensagensMs ??
    schedulerInput.intervalo_entre_mensagens_ms;
  let intervalo = configAtual.intervalo_entre_mensagens_ms;
  if (intervaloRaw !== undefined) {
    const i = Number(intervaloRaw);
    if (!Number.isInteger(i) || i < 0 || i > 600_000) {
      return enviarErro(
        res,
        400,
        "PARAMETRO_INVALIDO",
        "intervaloEntreMensagensMs deve ser um inteiro entre 0 e 600000",
      );
    }
    intervalo = i;
  }

  // 6. janela shopee horas
  const janelaRaw =
    schedulerInput.janelaShopeeHoras ?? schedulerInput.janela_shopee_horas;
  let janela = getConfig("janela_shopee_horas")
    ? Number(getConfig("janela_shopee_horas"))
    : 12;
  if (janelaRaw !== undefined) {
    const j = Number(janelaRaw);
    if (!Number.isInteger(j) || j < 1 || j > 168) {
      return enviarErro(
        res,
        400,
        "PARAMETRO_INVALIDO",
        "janelaShopeeHoras deve ser um inteiro entre 1 e 168",
      );
    }
    janela = j;
    setConfig("janela_shopee_horas", String(janela));
  }

  const novaConfig: ConfigScheduler = {
    ativo,
    horarios,
    limite_diario: limite,
    quantidade_por_execucao: qtd,
    intervalo_entre_mensagens_ms: intervalo,
  };

  salvarConfigScheduler(novaConfig);

  res.json({
    sucesso: true,
    scheduler: {
      ativo: novaConfig.ativo,
      horarios: novaConfig.horarios,
      limiteDiario: novaConfig.limite_diario,
      quantidadePorExecucao: novaConfig.quantidade_por_execucao,
      intervaloEntreMensagensMs: novaConfig.intervalo_entre_mensagens_ms,
      proximoEnvio: calcularProximoEnvio(novaConfig.horarios, novaConfig.ativo),
      janelaShopeeHoras: janela,
    },
  });
});


router.post("/produtos/:id/selecionar", (req, res) => {
  const id = Number(req.params.id);
  const { selecionado } = req.body;

  alternarSelecao(id, selecionado);
  res.json({ sucesso: true });
});

router.post("/produtos/:id/reenviar", sendsLimiter, async (req, res) => {
  if (process.env.NODE_ENV !== "test" && !getStatusConexao().conectado) {
    return enviarErro(res, 503, "WHATSAPP_OFFLINE", "WhatsApp não está conectado. Conecte um número nas configurações.");
  }

  const id = Number(req.params.id);
  const chave = req.header("Idempotency-Key")?.trim();
  if (!chave || chave.length > 200) {
    return enviarErro(
      res,
      400,
      "PARAMETRO_INVALIDO",
      "header Idempotency-Key é obrigatório e deve ter no máximo 200 caracteres",
    );
  }

  try {
    const resultado = await reenviarManualIdempotente(id, chave);
    const status = statusHttpReenvioManual(resultado);
    if (resultado === "sent") {
      const produtoAtualizado = buscarProdutoComPlataforma(id);
      return res.status(status).json({
        sucesso: true,
        linkAfiliado: produtoAtualizado?.link_afiliado,
      });
    }
    if (resultado === "sending") return res.status(status).json({ status: resultado });
    if (resultado === "conflito") {
      return enviarErro(
        res,
        status,
        "CONFLITO",
        "Idempotency-Key já foi usada para outro produto",
      );
    }
    if (resultado === "ausente") {
      return enviarErro(res, status, "NAO_ENCONTRADO", "produto não encontrado");
    }

    const produtoAtualizado = buscarProdutoComPlataforma(id);
    const mensagemErro =
      produtoAtualizado?.ultimo_erro_envio ||
      "não foi possível confirmar o envio manual";

    return enviarErro(
      res,
      status,
      resultado === "failed" ? "REENVIO_FALHOU" : "REENVIO_AMBIGUO",
      mensagemErro,
      { status: resultado, needsReview: resultado === "ambiguous" },
    );
  } catch {
    enviarErro(res, 502, "ERRO_INTERNO", "não foi possível confirmar o envio manual");
  }
});

router.post("/produtos/:id/gerar-link", scrapingLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const produto = buscarProdutoComPlataforma(id);
  if (!produto) {
    return enviarErro(res, 404, "NAO_ENCONTRADO", "produto não encontrado");
  }

  if (!temAffiliateProvider(produto.source_key)) {
    return enviarErro(
      res,
      400,
      "NAO_SUPORTADO",
      "plataforma não possui provedor de afiliado configurado",
    );
  }

  if (!produto.link_original || !produto.link_original.trim()) {
    return enviarErro(
      res,
      400,
      "LINK_ORIGINAL_AUSENTE",
      "produto não possui URL original para gerar link de afiliado",
    );
  }

  try {
    const provider = getAffiliateProvider(produto.source_key as IntegrationKey);
    const linkGerado = await provider.generateLink(produto.link_original);
    if (!linkGerado.trim() || linkGerado === produto.link_original) {
      return enviarErro(
        res,
        502,
        "LINK_INVALIDO",
        "provedor retornou um link afiliado inválido",
      );
    }

    atualizarLinkAfiliadoPorFonte(
      produto.source_key,
      produto.external_product_id,
      linkGerado,
    );
    res.json({ sucesso: true, linkAfiliado: linkGerado });
  } catch (erro) {
    const msg = erro instanceof Error ? erro.message : String(erro);
    enviarErro(res, 500, "ERRO_GERAR_LINK", `Falha ao gerar link afiliado: ${msg}`);
  }
});

// ---------- Envios e Envio Manual Shopee ----------

router.post("/sends/manual/resolve", scrapingLimiter, async (req, res) => {
  const url = req.body?.url;
  try {
    const dados = await resolverLinkShopee(url);
    res.json(dados);
  } catch (err) {
    if (err instanceof ShopeeUrlError) {
      return enviarErro(res, err.status, err.code, err.message, err.extra);
    }
    const msg = err instanceof Error ? err.message : String(err);
    enviarErro(res, 500, "ERRO_INTERNO", msg);
  }
});

router.post("/sends/manual/preview", scrapingLimiter, async (req, res) => {
  try {
    const dados = await gerarPreviewManualShopee(req.body);
    res.json(dados);
  } catch (err) {
    if (err instanceof ShopeeUrlError) {
      return enviarErro(res, err.status, err.code, err.message, err.extra);
    }
    const msg = err instanceof Error ? err.message : String(err);
    enviarErro(res, 500, "ERRO_INTERNO", msg);
  }
});

router.post("/sends/manual", sendsLimiter, async (req, res) => {
  if (process.env.NODE_ENV !== "test" && !getStatusConexao().conectado) {
    return enviarErro(res, 503, "WHATSAPP_OFFLINE", "WhatsApp não está conectado. Conecte um número nas configurações.");
  }

  const chave = (
    req.header("Idempotency-Key") ??
    req.body?.idempotencyKey ??
    ""
  ).trim() || undefined;

  try {
    const resultado = await executarEnvioManualShopee(req.body, chave);
    if (!resultado.sucesso) {
      return res.status(502).json({
        ...resultado,
        error: {
          code: resultado.status === "failed" ? "ENVIO_FALHOU" : "ENVIO_AMBIGUO",
          message: resultado.motivo || "falha no envio",
          needsReview: resultado.needsReview,
          status: resultado.status,
        },
      });
    }
    return res.json(resultado);
  } catch (err) {
    if (err instanceof ShopeeUrlError) {
      return enviarErro(res, err.status, err.code, err.message, err.extra);
    }
    const msg = err instanceof Error ? err.message : String(err);
    enviarErro(res, 500, "ERRO_INTERNO", msg);
  }
});

router.get("/sends", (req, res) => {
  const page = req.query.page !== undefined ? Number(req.query.page) : 1;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const plataforma = typeof req.query.plataforma === "string" ? req.query.plataforma : undefined;

  const resultado = listarEnviosPaginado({ page, limit, status, plataforma });
  res.json({
    items: resultado.items.map(tentativaParaResposta),
    page: Math.max(1, page),
    limit: Math.max(1, Math.min(100, limit)),
    total: resultado.total,
  });
});

router.get("/sends/summary", (req, res) => {
  const config = obterConfigScheduler();
  const destinoId = getConfig("whatsapp_grupo_id") || null;
  const destinoNome = getConfig("whatsapp_grupo_nome") || null;

  res.json({
    ativo: config.ativo,
    proximoEnvio: calcularProximoEnvio(config.horarios, config.ativo),
    limiteDiario: config.limite_diario,
    enviadosHoje: enviosHoje(),
    intervaloMs: config.intervalo_entre_mensagens_ms,
    plataformasPermitidas: ["shopee", "mercado_livre"],
    destino: {
      id: destinoId,
      nome: destinoNome,
    },
    formatoMensagem: "padrao",
  });
});

router.get("/sends/:attemptId/message", (req, res) => {
  const attemptId = Number(req.params.attemptId);
  if (!Number.isInteger(attemptId) || attemptId <= 0) {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "attemptId inválido");
  }

  const tentativa = buscarTentativaEnvioPorId(attemptId);
  if (!tentativa) {
    return enviarErro(res, 404, "NAO_ENCONTRADO", "tentativa de envio não encontrada");
  }

  if (tentativa.mensagem_snapshot) {
    return res.json({
      disponivel: true,
      texto: tentativa.mensagem_snapshot,
    });
  }

  return res.json({
    disponivel: false,
    texto: null,
  });
});

router.post("/sends/:attemptId/retry", sendsLimiter, async (req, res) => {
  if (process.env.NODE_ENV !== "test" && !getStatusConexao().conectado) {
    return enviarErro(res, 503, "WHATSAPP_OFFLINE", "WhatsApp não está conectado. Conecte um número nas configurações.");
  }

  const attemptId = Number(req.params.attemptId);
  if (!Number.isInteger(attemptId) || attemptId <= 0) {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "attemptId inválido");
  }

  const tentativa = buscarTentativaEnvioPorId(attemptId);
  if (!tentativa) {
    return enviarErro(res, 404, "NAO_ENCONTRADO", "tentativa de envio não encontrada");
  }

  if (tentativa.status === "sent") {
    return enviarErro(
      res,
      400,
      "ENVIO_JA_REALIZADO",
      "Esta tentativa já foi enviada com sucesso",
    );
  }

  const chave = (
    req.header("Idempotency-Key") ??
    req.body?.idempotencyKey ??
    `retry_${attemptId}`
  ).trim();

  let produtoIdParaRetry = tentativa.produto_id;
  if (!produtoIdParaRetry && tentativa.url_original) {
    const info = await normalizarUrlShopee(tentativa.url_original).catch(() => null);
    if (info) {
      const prodSalvo = buscarProdutoPorExternalId("shopee", info.externalProductId);
      if (prodSalvo) produtoIdParaRetry = prodSalvo.id;
    }
  }

  if (produtoIdParaRetry) {
    try {
      const resultado = await reenviarManualIdempotente(produtoIdParaRetry, chave);
      const status = statusHttpReenvioManual(resultado);
      if (resultado === "sent") return res.status(status).json({ sucesso: true, status: "sent" });
      if (resultado === "sending") return res.status(status).json({ status: resultado });
      if (resultado === "conflito") {
        return enviarErro(
          res,
          status,
          "CONFLITO",
          "Idempotency-Key já foi usada para outro produto",
        );
      }
      if (resultado === "ausente") {
        return enviarErro(res, status, "NAO_ENCONTRADO", "produto não encontrado");
      }

      const produtoAtualizado = buscarProdutoComPlataforma(produtoIdParaRetry);
      const mensagemErro =
        produtoAtualizado?.ultimo_erro_envio ||
        "não foi possível confirmar o reenvio";

      return enviarErro(
        res,
        status,
        resultado === "failed" ? "REENVIO_FALHOU" : "REENVIO_AMBIGUO",
        mensagemErro,
        { status: resultado, needsReview: resultado === "ambiguous" },
      );
    } catch {
      return enviarErro(res, 502, "ERRO_INTERNO", "não foi possível confirmar o reenvio");
    }
  }

  if (tentativa.url_original && tentativa.plataforma === "shopee") {
    try {
      const resultado = await executarEnvioManualShopee(
        {
          url: tentativa.url_original,
          nome: tentativa.titulo ?? undefined,
          precoAtual: "1,00",
        },
        chave,
      );
      if (!resultado.sucesso) {
        return res.status(502).json({
          ...resultado,
          error: {
            code: resultado.status === "failed" ? "ENVIO_FALHOU" : "ENVIO_AMBIGUO",
            message: resultado.motivo || "falha no envio",
            needsReview: resultado.needsReview,
            status: resultado.status,
          },
        });
      }
      return res.json(resultado);
    } catch (err) {
      if (err instanceof ShopeeUrlError) {
        return enviarErro(res, err.status, err.code, err.message, err.extra);
      }
      return enviarErro(res, 502, "ERRO_INTERNO", "não foi possível confirmar o reenvio");
    }
  }

  return enviarErro(res, 400, "RETRY_INDISPONIVEL", "não foi possível reenviar esta tentativa");
});

// ---------- Afiliado Mercado Livre ----------

/**
 * POST /affiliate/ml/config
 * Body: { cookie: string, csrfToken: string, tag: string }
 *
 * Salva a sessão copiada manualmente do DevTools.
 * Cookie e csrfToken são tratados como segredos — não são logados.
 */
router.post("/affiliate/ml/config", (req, res) => {
  const { cookie, csrfToken, tag, apifyToken } = req.body as {
    cookie?: string;
    csrfToken?: string;
    tag?: string;
    apifyToken?: string;
  };

  const temCamposSessao = Boolean(cookie || csrfToken || tag);
  const temApify = Boolean(apifyToken && apifyToken.trim());

  if (!temCamposSessao && !temApify) {
    return enviarErro(
      res,
      400,
      "PARAMETRO_INVALIDO",
      "Pelo menos uma configuração (sessão ou token Apify) deve ser fornecida",
    );
  }

  if (temCamposSessao && (!cookie || !csrfToken || !tag)) {
    return enviarErro(
      res,
      400,
      "PARAMETRO_INVALIDO",
      "cookie, csrfToken e tag são obrigatórios para atualizar a sessão",
    );
  }

  if (cookie && csrfToken && tag) {
    configurarSessaoML(cookie, csrfToken, tag);
  }

  if (temApify && !apifyToken!.includes("*")) {
    setConfig("apify_api_token", apifyToken!.trim());
  }

  res.json({ sucesso: true, mensagem: "Configurações do Mercado Livre salvas." });
});

/**
 * GET /affiliate/ml/config
 * Retorna o status da sessão do Mercado Livre e do token da Apify sem expor dados confidenciais.
 */
router.get("/affiliate/ml/config", (_req, res) => {
  const sessao = buscarSessaoAfiliado("mercadolivre");
  const apifyRaw = getConfig("apify_api_token") || process.env.APIFY_API_TOKEN || null;

  res.json({
    configurado: Boolean(sessao),
    tag: sessao?.tag ?? null,
    atualizadoEm: sessao?.atualizado_em ?? null,
    apifyTokenConfigurado: Boolean(apifyRaw),
    apifyToken: mascararSecret(apifyRaw),
  });
});

/**
 * POST /affiliate/ml/link
 * Body: { url: string }
 *
 * Gera um link de afiliado para a URL do produto informada.
 * Renova a sessão automaticamente antes de chamar a API.
 */
router.post("/affiliate/ml/link", scrapingLimiter, async (req, res) => {
  const { url } = req.body as { url?: string };

  if (!url) {
    return enviarErro(res, 400, "PARAMETRO_INVALIDO", "url é obrigatório");
  }

  try {
    const linkAfiliado = await gerarLinkAfiliado(url);
    res.json({ sucesso: true, link: linkAfiliado });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return enviarErro(
        res,
        401,
        "SESSAO_ML_EXPIRADA",
        "Sessão expirada. Configure novamente via POST /affiliate/ml/config.",
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    enviarErro(res, 500, "ERRO_INTERNO", msg);
  }
});

export default router;
