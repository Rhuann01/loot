import { Router, type RequestHandler } from "express";
import { enviarErro } from "./respostas.js";
import {
  alternarSelecao,
  listarProdutos,
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

const router = Router();

const exigirAutenticacao: RequestHandler = (req, res, next) => {
  const usuario = process.env.PAINEL_USER;
  const senha = process.env.PAINEL_SENHA;

  if (!usuario || !senha) {
    enviarErro(
      res,
      503,
      "AUTH_NAO_CONFIGURADA",
      "autenticação administrativa não configurada",
    );
    return;
  }

  const autorizacao = req.header("authorization");
  const esperado = `Basic ${Buffer.from(`${usuario}:${senha}`).toString("base64")}`;
  if (autorizacao !== esperado) {
    res.setHeader("WWW-Authenticate", "Basic realm=Loot");
    enviarErro(res, 401, "NAO_AUTENTICADO", "autenticação necessária");
    return;
  }

  next();
};

router.use(exigirAutenticacao);

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

router.get("/queue/summary", (_req, res) => {
  res.json(obterResumoFila());
});

router.put("/scheduler", (req, res) => {
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

router.post("/produtos/:id/selecionar", (req, res) => {
  const id = Number(req.params.id);
  const { selecionado } = req.body;

  alternarSelecao(id, selecionado);
  res.json({ sucesso: true });
});

router.post("/produtos/:id/reenviar", async (req, res) => {
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
    if (resultado === "sent") return res.status(status).json({ sucesso: true });
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
    return enviarErro(
      res,
      status,
      "ERRO_INTERNO",
      "não foi possível confirmar o envio manual",
      { status: resultado },
    );
  } catch {
    enviarErro(res, 502, "ERRO_INTERNO", "não foi possível confirmar o envio manual");
  }
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
    return enviarErro(
      res,
      400,
      "PARAMETRO_INVALIDO",
      "cookie, csrfToken e tag são obrigatórios",
    );
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
