import { Router, type RequestHandler } from "express";
import {
  alternarSelecao,
  buscarProdutoPorId,
  listarProdutos,
  marcarComoEnviado,
  listarIntegracoes,
  atualizarAtivacaoIntegracao,
  obterResumoFila,
} from "../db/queries.js";
import {
  getQrCode,
  getStatusConexao,
  inscreverMudancasConexao,
  listarGruposWhatsApp,
  solicitarReconexao,
} from "../whatsapp/connection.js";
import { getConfig, setConfig } from "../db/queries.js";
import { enviarProduto } from "../whatsapp/sender.js";
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

const router = Router();

const exigirAutenticacao: RequestHandler = (req, res, next) => {
  const usuario = process.env.PAINEL_USER;
  const senha = process.env.PAINEL_SENHA;

  if (!usuario || !senha) {
    res.status(503).json({ erro: "autenticação administrativa não configurada" });
    return;
  }

  const autorizacao = req.header("authorization");
  const esperado = `Basic ${Buffer.from(`${usuario}:${senha}`).toString("base64")}`;
  if (autorizacao !== esperado) {
    res.setHeader("WWW-Authenticate", "Basic realm=Loot");
    res.status(401).json({ erro: "autenticação necessária" });
    return;
  }

  next();
};

router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

router.get("/produtos", (req, res) => {
  const produtos = listarProdutos();
  res.json(produtos);
});

router.get("/whatsapp/status", (req, res) => {
  const status = getStatusConexao();
  res.json(status);
});

// A partir daqui começam as rotas administrativas.
router.use(exigirAutenticacao);

router.get("/whatsapp/qr", (_req, res) => {
  res.json(getQrCode());
});

router.post("/whatsapp/reconnect", async (_req, res) => {
  const { forcarNovoQr } = _req.body as { forcarNovoQr?: unknown };

  try {
    await solicitarReconexao({ forcarNovoQr: forcarNovoQr === true });
    res.json(getStatusConexao());
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    if (mensagem.startsWith("sessão deslogada")) {
      return res.status(409).json({
        erro: mensagem,
        acao: "envie forcarNovoQr: true para gerar um novo QR Code",
      });
    }

    console.error("falha ao solicitar reconexão do WhatsApp:", erro);
    res.status(503).json({
      erro: "não foi possível iniciar a conexão do WhatsApp",
    });
  }
});

router.get("/whatsapp/events", (req, res) => {
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
      return res.status(503).json({ erro: mensagem });
    }

    console.error("falha ao listar grupos do WhatsApp:", erro);
    res.status(502).json({ erro: "não foi possível listar os grupos" });
  }
});

router.put("/whatsapp/group", async (req, res) => {
  const { groupId } = req.body as { groupId?: unknown };
  if (typeof groupId !== "string" || groupId.trim() === "") {
    return res.status(400).json({ erro: "groupId é obrigatório" });
  }

  try {
    const grupos = await listarGruposWhatsApp();
    const grupo = grupos.find((item) => item.id === groupId);
    if (!grupo) {
      return res.status(404).json({ erro: "grupo não encontrado no WhatsApp" });
    }

    setConfig("whatsapp_grupo_id", grupo.id);
    res.json({ sucesso: true, grupo });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    if (mensagem === "WhatsApp não está conectado") {
      return res.status(503).json({ erro: mensagem });
    }

    console.error("falha ao selecionar grupo do WhatsApp:", erro);
    res.status(502).json({ erro: "não foi possível validar o grupo" });
  }
});

router.delete("/whatsapp/group", (_req, res) => {
  setConfig("whatsapp_grupo_id", "");
  res.json({ sucesso: true });
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
    return res.status(400).json({ erro: "chave e valor são obrigatórios" });
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
    return res.status(400).json({ erro: "active deve ser booleano" });
  }

  try {
    atualizarAtivacaoIntegracao(req.params.key, active);
    res.json({ integrations: listarIntegracoes() });
  } catch (erro) {
    res.status(404).json({ erro: erro instanceof Error ? erro.message : String(erro) });
  }
});

router.get("/queue/summary", (_req, res) => {
  res.json(obterResumoFila());
});

router.put("/scheduler", (req, res) => {
  const {
    ativo,
    horarios,
    limite_diario,
    quantidade_por_execucao,
  } = req.body as Partial<ConfigScheduler>;

  const horariosValidos = Array.isArray(horarios) && horarios.every(
    (horario) => typeof horario === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(horario),
  );

  if (
    typeof ativo !== "boolean" ||
    !horariosValidos ||
    horarios.length > MAX_HORARIOS_SCHEDULER
  ) {
    return res.status(400).json({
      erro: `ativo deve ser booleano, horarios deve conter horários no formato HH:mm e ter no máximo ${MAX_HORARIOS_SCHEDULER} itens`,
    });
  }

  const configAtual = obterConfigScheduler();
  const limite = limite_diario === undefined
    ? configAtual.limite_diario
    : Number(limite_diario);
  if (!Number.isInteger(limite) || limite < 1 || limite > 100) {
    return res.status(400).json({
      erro: "limite_diario deve ser um número inteiro entre 1 e 100",
    });
  }

  const quantidadeLegada = quantidade_por_execucao === undefined
    ? configAtual.quantidade_por_execucao
    : Number(quantidade_por_execucao);

  const config: ConfigScheduler = {
    ativo,
    horarios: [...new Set(horarios)].sort(),
    limite_diario: limite,
    quantidade_por_execucao: Number.isInteger(quantidadeLegada) && quantidadeLegada > 0
      ? quantidadeLegada
      : configAtual.quantidade_por_execucao,
  };

  salvarConfigScheduler(config);
  res.json(config);
});

router.post("/produtos/:id/selecionar", (req, res) => {
  const id = Number(req.params.id);
  const { selecionado } = req.body;

  alternarSelecao(id, selecionado);
  res.json({ sucesso: true });
});

router.post("/produtos/:id/reenviar", async (req, res) => {
  const id = Number(req.params.id);
  const produto = buscarProdutoPorId(id);

  if (!produto) {
    return res.status(404).json({ erro: "produto não encontrado" });
  }

  await enviarProduto({
    nome: produto.nome,
    preco_atual: produto.preco_atual,
    preco_original: produto.preco_original,
    link_afiliado: produto.link_afiliado,
    imagem_url: produto.imagem_url,
  });

  marcarComoEnviado(produto.id);

  res.json({ sucesso: true });
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
  const { cookie, csrfToken, tag } = req.body as {
    cookie?: string;
    csrfToken?: string;
    tag?: string;
  };

  if (!cookie || !csrfToken || !tag) {
    return res
      .status(400)
      .json({ erro: "cookie, csrfToken e tag são obrigatórios" });
  }

  configurarSessaoML(cookie, csrfToken, tag);
  res.json({ sucesso: true, mensagem: "Sessão do Mercado Livre configurada." });
});

/**
 * POST /affiliate/ml/link
 * Body: { url: string }
 *
 * Gera um link de afiliado para a URL do produto informada.
 * Renova a sessão automaticamente antes de chamar a API.
 */
router.post("/affiliate/ml/link", async (req, res) => {
  const { url } = req.body as { url?: string };

  if (!url) {
    return res.status(400).json({ erro: "url é obrigatório" });
  }

  try {
    const linkAfiliado = await gerarLinkAfiliado(url);
    res.json({ sucesso: true, link: linkAfiliado });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return res.status(401).json({
        erro: "Sessão expirada. Configure novamente via POST /affiliate/ml/config.",
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ erro: msg });
  }
});

export default router;
