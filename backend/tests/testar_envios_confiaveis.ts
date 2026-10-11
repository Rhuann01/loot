import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const diretorioOriginal = process.cwd();
const diretorioTeste = mkdtempSync(join(tmpdir(), "loot-envios-"));
process.chdir(diretorioTeste);

const { default: db } = await import("../src/db/index.js");
const {
  buscarProdutoPorId,
  adquirirLockExecucao,
  liberarLockExecucao,
  iniciarEnvioManual,
  iniciarEnvioManualIdempotente,
  listarTentativasEnvio,
  marcarComoEnviado,
  marcarFalhaEnvio,
  marcarEnvioAmbiguo,
  obterResumoFila,
  recuperarEnviosAbandonados,
  renovarLockExecucao,
  reservarProdutoParaEnvio,
  salvarProduto,
  setConfig,
} = await import("../src/db/queries.js");
const { executarEnvioProtegido, tentarExecutarLoteAutomatico } =
  await import("../src/whatsapp/dispatch.js");
const { enviarLote, obterConfigScheduler, salvarConfigScheduler } =
  await import("../src/auto/scheduler.js");
const { reenviarManualIdempotente, statusHttpReenvioManual } =
  await import("../src/whatsapp/manual.js");

function limparBanco() {
  db.exec(
    "DELETE FROM idempotencias_reenvio_manual; DELETE FROM tentativas_de_envio; DELETE FROM envios; DELETE FROM produtos;",
  );
  setConfig("desconto_minimo_global", "20");
  setConfig("janela_fallback_dias", "3");
  setConfig("limite_diario", "1");
  setConfig("intervalo_entre_mensagens_ms", "0");
  setConfig("auto_envio_ativo", "false");
}

function criarProduto(codigo: string): number {
  salvarProduto({
    source_key: "mercado_livre",
    external_product_id: codigo,
    nome: `Produto ${codigo}`,
    preco_atual: "80",
    preco_original: "100",
    desconto_percentual: 50,
    link_afiliado: `https://example.test/${codigo}`,
  });
  return (
    db
      .prepare("SELECT id FROM produtos WHERE external_product_id = ?")
      .get(codigo) as { id: number }
  ).id;
}

function criarProdutoComLinks(
  codigo: string,
  linkOriginal: string,
  linkAfiliado: string,
): number {
  salvarProduto({
    source_key: "mercado_livre",
    external_product_id: codigo,
    nome: `Produto ${codigo}`,
    preco_atual: "80",
    preco_original: "100",
    desconto_percentual: 50,
    link_original: linkOriginal,
    link_afiliado: linkAfiliado,
  });
  return (
    db
      .prepare("SELECT id FROM produtos WHERE external_product_id = ?")
      .get(codigo) as { id: number }
  ).id;
}

async function esperarArquivo(caminho: string) {
  for (let tentativa = 0; tentativa < 100; tentativa++) {
    if (existsSync(caminho)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`processo de teste não ficou pronto: ${caminho}`);
}

function executarEnvioEmProcesso(
  prontoEm: string,
  iniciarEm: string,
  resultadoEm: string,
): Promise<void> {
  const worker = new URL("./envio-protegido-worker.js", import.meta.url)
    .pathname;
  const processo = spawn(process.execPath, [worker], {
    cwd: diretorioTeste,
    env: {
      ...process.env,
      LOOT_ENVIO_PRONTO_EM: prontoEm,
      LOOT_ENVIO_INICIAR_EM: iniciarEm,
      LOOT_ENVIO_RESULTADO_EM: resultadoEm,
    },
  });
  return new Promise((resolve, reject) => {
    processo.once("error", reject);
    processo.once("close", (codigo) => {
      if (codigo === 0) resolve();
      else reject(new Error(`worker de envio falhou (${codigo})`));
    });
  });
}

function executarLoteEmProcesso(
  prontoEm: string,
  iniciarEm: string,
  resultadoEm: string,
): Promise<void> {
  const worker = new URL("./lote-automatico-worker.js", import.meta.url)
    .pathname;
  const processo = spawn(process.execPath, [worker], {
    cwd: diretorioTeste,
    env: {
      ...process.env,
      LOOT_LOTE_PRONTO_EM: prontoEm,
      LOOT_LOTE_INICIAR_EM: iniciarEm,
      LOOT_LOTE_RESULTADO_EM: resultadoEm,
    },
  });
  return new Promise((resolve, reject) => {
    processo.once("error", reject);
    processo.once("close", (codigo) => {
      if (codigo === 0) resolve();
      else reject(new Error(`worker de lote falhou (${codigo})`));
    });
  });
}

function executarReenvioIdempotenteEmProcesso(
  prontoEm: string,
  iniciarEm: string,
  resultadoEm: string,
  produtoId: number,
  chave: string,
): Promise<void> {
  const worker = new URL("./reenvio-idempotente-worker.js", import.meta.url)
    .pathname;
  const processo = spawn(process.execPath, [worker], {
    cwd: diretorioTeste,
    env: {
      ...process.env,
      LOOT_REENVIO_PRONTO_EM: prontoEm,
      LOOT_REENVIO_INICIAR_EM: iniciarEm,
      LOOT_REENVIO_RESULTADO_EM: resultadoEm,
      LOOT_REENVIO_PRODUTO_ID: String(produtoId),
      LOOT_REENVIO_CHAVE: chave,
    },
  });
  return new Promise((resolve, reject) => {
    processo.once("error", reject);
    processo.once("close", (codigo) => {
      if (codigo === 0) resolve();
      else
        reject(new Error(`worker de reenvio idempotente falhou (${codigo})`));
    });
  });
}

try {
  limparBanco();
  const abandonadoId = criarProduto("MLB-ABANDONADO");
  db.prepare(
    "UPDATE produtos SET status_fila = 'sending', envio_iniciado_em = datetime('now', '-1 hour') WHERE id = ?",
  ).run(abandonadoId);

  assert.equal(recuperarEnviosAbandonados(), 1);
  const abandonado = buscarProdutoPorId(abandonadoId);
  assert.equal(abandonado?.status_fila, "ambiguous");
  assert.match(abandonado?.ultimo_erro_envio ?? "", /sem confirmação/i);
  assert.equal(reservarProdutoParaEnvio(), undefined);
  assert.equal(listarTentativasEnvio(abandonadoId)[0]?.status, "ambiguous");

  limparBanco();
  const interrompidoId = criarProduto("MLB-INTERRUPTIDO-COM-TENTATIVA");
  const interrupcao = iniciarEnvioManual(interrompidoId);
  assert.ok(interrupcao, "a tentativa deve ser registrada antes do despacho");
  assert.equal(recuperarEnviosAbandonados(), 1);
  assert.equal(buscarProdutoPorId(interrompidoId)?.status_fila, "ambiguous");
  assert.equal(
    listarTentativasEnvio(interrompidoId)[0]?.id,
    interrupcao.tentativa.id,
    "a recuperação deve finalizar a tentativa que já existia, sem criar outra",
  );
  assert.equal(listarTentativasEnvio(interrompidoId)[0]?.status, "ambiguous");

  limparBanco();
  const manualId = criarProduto("MLB-MANUAL");
  db.prepare("UPDATE produtos SET tentativas_envio = 3 WHERE id = ?").run(
    manualId,
  );
  const manual = iniciarEnvioManual(manualId);
  assert.equal(manual?.produto.tentativas_envio, 3);
  assert.equal(manual?.produto.status_fila, "sending");
  assert.equal(manual?.tentativa.origem, "manual");

  db.prepare(
    "UPDATE produtos SET enviado = 1, status_fila = 'sent' WHERE id = ?",
  ).run(manualId);
  const reenvioManual = iniciarEnvioManual(manualId);
  marcarFalhaEnvio(
    manualId,
    "WhatsApp não está conectado",
    reenvioManual?.tentativa.id,
    true,
  );
  assert.equal(buscarProdutoPorId(manualId)?.status_fila, "sent");
  assert.equal(listarTentativasEnvio(manualId)[0]?.status, "failed");

  limparBanco();
  const falhaId = criarProduto("MLB-FALHA-CONHECIDA");
  const falha = iniciarEnvioManual(falhaId);
  assert.ok(falha);
  marcarFalhaEnvio(falhaId, "WhatsApp não está conectado", falha.tentativa.id);
  assert.equal(buscarProdutoPorId(falhaId)?.status_fila, "failed");
  assert.equal(listarTentativasEnvio(falhaId)[0]?.status, "failed");

  limparBanco();
  const ambiguoId = criarProduto("MLB-FALHA-AMBIGUA");
  const ambiguo = iniciarEnvioManual(ambiguoId);
  assert.ok(ambiguo);
  marcarEnvioAmbiguo(
    ambiguoId,
    "socket fechou após o despacho",
    ambiguo.tentativa.id,
  );
  assert.equal(buscarProdutoPorId(ambiguoId)?.status_fila, "ambiguous");
  assert.equal(listarTentativasEnvio(ambiguoId)[0]?.status, "ambiguous");
  assert.equal(
    reservarProdutoParaEnvio(),
    undefined,
    "ambiguous não pode voltar à fila automática",
  );
  assert.deepEqual(obterResumoFila(), {
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    ambiguous: 1,
  });

  limparBanco();
  setConfig("auto_envio_ativo", "true");
  const falhaAutomaticaId = criarProduto("MLB-AUTO-FALHA-CONHECIDA");
  await enviarLote(1, async () => {
    throw new Error("WhatsApp não está conectado");
  });
  assert.equal(buscarProdutoPorId(falhaAutomaticaId)?.status_fila, "failed");
  assert.equal(listarTentativasEnvio(falhaAutomaticaId)[0]?.status, "failed");

  limparBanco();
  setConfig("auto_envio_ativo", "true");
  const linkOriginalSemAfiliacao =
    "https://example.test/original-sem-afiliacao";
  const falhaLinkAfiliadoId = criarProdutoComLinks(
    "MLB-AUTO-LINK-AFILIADO-FALHOU",
    linkOriginalSemAfiliacao,
    linkOriginalSemAfiliacao,
  );
  let enviosComFalhaDeLink = 0;
  await enviarLote(1, async () => {
    enviosComFalhaDeLink += 1;
  });
  assert.equal(
    enviosComFalhaDeLink,
    0,
    "não deve enviar usando o link original",
  );
  assert.equal(buscarProdutoPorId(falhaLinkAfiliadoId)?.status_fila, "failed");
  assert.equal(listarTentativasEnvio(falhaLinkAfiliadoId)[0]?.status, "failed");
  assert.match(
    buscarProdutoPorId(falhaLinkAfiliadoId)?.ultimo_erro_envio ?? "",
    /link afiliado/i,
  );

  limparBanco();
  setConfig("auto_envio_ativo", "true");

  const linkOriginalVazio = "https://example.test/original-vazio";
  const linkVazioId = criarProdutoComLinks(
    "MLB-AUTO-LINK-VAZIO",
    linkOriginalVazio,
    "",
  );

  let enviosComLinkVazio = 0;

  await enviarLote(1, async () => {
    enviosComLinkVazio += 1;
  });

  assert.equal(enviosComLinkVazio, 0);
  assert.equal(buscarProdutoPorId(linkVazioId)?.status_fila, "failed");
  assert.equal(listarTentativasEnvio(linkVazioId)[0]?.status, "failed");
  limparBanco();
  setConfig("auto_envio_ativo", "true");
  const linkAfiliadoAutomaticoValido =
    "https://example.test/afiliado-automatico-valido";
  const envioAutomaticoValidoId = criarProdutoComLinks(
    "MLB-AUTO-LINK-AFILIADO-VALIDO",
    "https://example.test/original-automatico-valido",
    linkAfiliadoAutomaticoValido,
  );
  let linkAfiliadoAutomaticoEnviado: string | undefined;
  await enviarLote(1, async (produto) => {
    linkAfiliadoAutomaticoEnviado = produto.link_afiliado;
  });
  assert.equal(linkAfiliadoAutomaticoEnviado, linkAfiliadoAutomaticoValido);
  assert.equal(
    buscarProdutoPorId(envioAutomaticoValidoId)?.status_fila,
    "sent",
  );

  limparBanco();
  const linkOriginalReenvio = "https://example.test/original-reenvio";
  const reenvioSemLinkAfiliadoId = criarProdutoComLinks(
    "MLB-MANUAL-SEM-LINK-AFILIADO",
    linkOriginalReenvio,
    "",
  );
  let enviosManuaisBloqueados = 0;
  assert.equal(
    await reenviarManualIdempotente(
      reenvioSemLinkAfiliadoId,
      "manual-sem-link-afiliado",
      async () => {
        enviosManuaisBloqueados += 1;
      },
    ),
    "failed",
  );
  assert.equal(
    enviosManuaisBloqueados,
    0,
    "reenvio inválido não deve chegar ao WhatsApp",
  );
  assert.equal(
    buscarProdutoPorId(reenvioSemLinkAfiliadoId)?.status_fila,
    "failed",
  );
  assert.equal(
    listarTentativasEnvio(reenvioSemLinkAfiliadoId)[0]?.status,
    "failed",
  );

  limparBanco();
  const reenvioComLinkAfiliadoEmBrancoId = criarProdutoComLinks(
    "MLB-MANUAL-LINK-AFILIADO-EM-BRANCO",
    "https://example.test/original-em-branco",
    "   ",
  );
  let enviosManuaisComLinkEmBranco = 0;
  assert.equal(
    await reenviarManualIdempotente(
      reenvioComLinkAfiliadoEmBrancoId,
      "manual-link-afiliado-em-branco",
      async () => {
        enviosManuaisComLinkEmBranco += 1;
      },
    ),
    "failed",
  );
  assert.equal(
    enviosManuaisComLinkEmBranco,
    0,
    "link em branco não pode ser reenviado",
  );
  assert.equal(
    buscarProdutoPorId(reenvioComLinkAfiliadoEmBrancoId)?.status_fila,
    "failed",
  );
  assert.equal(
    listarTentativasEnvio(reenvioComLinkAfiliadoEmBrancoId)[0]?.status,
    "failed",
  );

  limparBanco();
  const linkOriginalIgualAoAfiliado = "https://example.test/original-igual";
  const reenvioComLinkOriginalId = criarProdutoComLinks(
    "MLB-MANUAL-LINK-ORIGINAL",
    linkOriginalIgualAoAfiliado,
    linkOriginalIgualAoAfiliado,
  );
  let enviosManuaisComLinkOriginal = 0;
  assert.equal(
    await reenviarManualIdempotente(
      reenvioComLinkOriginalId,
      "manual-link-original",
      async () => {
        enviosManuaisComLinkOriginal += 1;
      },
    ),
    "failed",
  );
  assert.equal(
    enviosManuaisComLinkOriginal,
    0,
    "link original não pode ser reenviado",
  );
  assert.equal(
    buscarProdutoPorId(reenvioComLinkOriginalId)?.status_fila,
    "failed",
  );
  assert.equal(
    listarTentativasEnvio(reenvioComLinkOriginalId)[0]?.status,
    "failed",
  );

  limparBanco();
  const linkAfiliadoValido = "https://example.test/afiliado-valido";
  const reenvioComLinkAfiliadoId = criarProdutoComLinks(
    "MLB-MANUAL-LINK-AFILIADO-VALIDO",
    "https://example.test/original-valido",
    linkAfiliadoValido,
  );
  let linkEnviado: string | undefined;
  assert.equal(
    await reenviarManualIdempotente(
      reenvioComLinkAfiliadoId,
      "manual-link-afiliado-valido",
      async (produto) => {
        linkEnviado = produto.link_afiliado;
      },
    ),
    "sent",
  );
  assert.equal(linkEnviado, linkAfiliadoValido);
  assert.equal(
    buscarProdutoPorId(reenvioComLinkAfiliadoId)?.status_fila,
    "sent",
  );

  limparBanco();
  setConfig("auto_envio_ativo", "true");
  const ambiguoAutomaticoId = criarProduto("MLB-AUTO-FALHA-AMBIGUA");
  await enviarLote(1, async () => {
    throw new Error("socket fechou após o despacho");
  });
  assert.equal(
    buscarProdutoPorId(ambiguoAutomaticoId)?.status_fila,
    "ambiguous",
  );
  assert.equal(
    listarTentativasEnvio(ambiguoAutomaticoId)[0]?.status,
    "ambiguous",
  );
  assert.equal(reservarProdutoParaEnvio(), undefined);

  limparBanco();
  const envioManualDuplicadoId = criarProduto("MLB-MANUAL-DUPLICADO");
  const primeiraTentativa = iniciarEnvioManual(envioManualDuplicadoId);
  assert.ok(primeiraTentativa);
  marcarComoEnviado(envioManualDuplicadoId, primeiraTentativa.tentativa.id);
  const segundaTentativa = iniciarEnvioManual(envioManualDuplicadoId);
  assert.ok(
    segundaTentativa,
    "a política atual permite um reenvio manual posterior, inclusive após sucesso",
  );
  assert.equal(listarTentativasEnvio(envioManualDuplicadoId).length, 2);

  limparBanco();
  const idempotenteId = criarProduto("MLB-IDEMPOTENTE");
  const inicioIdempotente = iniciarEnvioManualIdempotente(
    idempotenteId,
    "reenvio-1",
  );
  assert.equal(inicioIdempotente.tipo, "nova");
  if (inicioIdempotente.tipo !== "nova")
    throw new Error("tentativa nova esperada");
  const repeticaoEmAndamento = iniciarEnvioManualIdempotente(
    idempotenteId,
    "reenvio-1",
  );
  assert.equal(repeticaoEmAndamento.tipo, "existente");
  if (repeticaoEmAndamento.tipo !== "existente") {
    throw new Error("tentativa existente esperada");
  }
  assert.equal(repeticaoEmAndamento.tentativa.status, "sending");
  assert.equal(listarTentativasEnvio(idempotenteId).length, 1);

  marcarComoEnviado(idempotenteId, inicioIdempotente.reserva.tentativa.id);
  const repeticaoComSucesso = iniciarEnvioManualIdempotente(
    idempotenteId,
    "reenvio-1",
  );
  assert.equal(repeticaoComSucesso.tipo, "existente");
  if (repeticaoComSucesso.tipo !== "existente") {
    throw new Error("resultado existente esperado");
  }
  assert.equal(repeticaoComSucesso.tentativa.status, "sent");
  assert.equal(listarTentativasEnvio(idempotenteId).length, 1);

  const outroProdutoId = criarProduto("MLB-IDEMPOTENTE-OUTRO");
  assert.equal(
    iniciarEnvioManualIdempotente(outroProdutoId, "reenvio-1").tipo,
    "conflito",
  );

  limparBanco();
  const falhaIdempotenteId = criarProduto("MLB-IDEMPOTENTE-FALHA");
  const inicioFalha = iniciarEnvioManualIdempotente(
    falhaIdempotenteId,
    "reenvio-falha",
  );
  assert.equal(inicioFalha.tipo, "nova");
  if (inicioFalha.tipo !== "nova") throw new Error("tentativa nova esperada");
  marcarFalhaEnvio(
    falhaIdempotenteId,
    "WhatsApp não está conectado",
    inicioFalha.reserva.tentativa.id,
  );
  const repeticaoFalha = iniciarEnvioManualIdempotente(
    falhaIdempotenteId,
    "reenvio-falha",
  );
  assert.equal(repeticaoFalha.tipo, "existente");
  if (repeticaoFalha.tipo !== "existente")
    throw new Error("resultado existente esperado");
  assert.equal(repeticaoFalha.tentativa.status, "failed");

  limparBanco();
  const ambiguoIdempotenteId = criarProduto("MLB-IDEMPOTENTE-AMBIGUO");
  const inicioAmbiguo = iniciarEnvioManualIdempotente(
    ambiguoIdempotenteId,
    "reenvio-ambiguo",
  );
  assert.equal(inicioAmbiguo.tipo, "nova");
  if (inicioAmbiguo.tipo !== "nova") throw new Error("tentativa nova esperada");
  marcarEnvioAmbiguo(
    ambiguoIdempotenteId,
    "confirmação interrompida",
    inicioAmbiguo.reserva.tentativa.id,
  );
  const repeticaoAmbigua = iniciarEnvioManualIdempotente(
    ambiguoIdempotenteId,
    "reenvio-ambiguo",
  );
  assert.equal(repeticaoAmbigua.tipo, "existente");
  if (repeticaoAmbigua.tipo !== "existente") {
    throw new Error("resultado existente esperado");
  }
  assert.equal(repeticaoAmbigua.tentativa.status, "ambiguous");
  assert.equal(listarTentativasEnvio(ambiguoIdempotenteId).length, 1);

  limparBanco();
  const concorrenteId = criarProduto("MLB-IDEMPOTENTE-CONCORRENTE");
  const iniciarReenviosEm = join(
    diretorioTeste,
    "iniciar-reenvios-idempotentes",
  );
  const reenvioProntoA = join(diretorioTeste, "reenvio-a-pronto");
  const reenvioProntoB = join(diretorioTeste, "reenvio-b-pronto");
  const reenvioResultadoA = join(diretorioTeste, "reenvio-a-resultado");
  const reenvioResultadoB = join(diretorioTeste, "reenvio-b-resultado");
  const reenvioA = executarReenvioIdempotenteEmProcesso(
    reenvioProntoA,
    iniciarReenviosEm,
    reenvioResultadoA,
    concorrenteId,
    "reenvio-concorrente",
  );
  const reenvioB = executarReenvioIdempotenteEmProcesso(
    reenvioProntoB,
    iniciarReenviosEm,
    reenvioResultadoB,
    concorrenteId,
    "reenvio-concorrente",
  );
  await Promise.all([
    esperarArquivo(reenvioProntoA),
    esperarArquivo(reenvioProntoB),
  ]);
  writeFileSync(iniciarReenviosEm, "iniciar");
  await Promise.all([reenvioA, reenvioB]);
  const reenvios = [reenvioResultadoA, reenvioResultadoB].map(
    (resultadoEm) =>
      JSON.parse(readFileSync(resultadoEm, "utf8")) as {
        tipo: string;
        tentativaId: number;
      },
  );
  assert.equal(reenvios.filter((reenvio) => reenvio.tipo === "nova").length, 1);
  assert.equal(
    reenvios.filter((reenvio) => reenvio.tipo === "existente").length,
    1,
  );
  assert.equal(new Set(reenvios.map((reenvio) => reenvio.tentativaId)).size, 1);
  assert.equal(listarTentativasEnvio(concorrenteId).length, 1);

  limparBanco();
  const manualIdempotenteId = criarProduto("MLB-REENVIO-MANUAL-IDEMPOTENTE");
  assert.equal(
    await reenviarManualIdempotente(
      manualIdempotenteId,
      "manual-sucesso",
      async () => {},
    ),
    "sent",
  );
  assert.equal(
    await reenviarManualIdempotente(
      manualIdempotenteId,
      "manual-sucesso",
      async () => {
        throw new Error("não deve enviar novamente");
      },
    ),
    "sent",
  );
  assert.equal(listarTentativasEnvio(manualIdempotenteId).length, 1);

  limparBanco();
  const manualFalhaId = criarProduto("MLB-REENVIO-MANUAL-FALHA");
  assert.equal(
    await reenviarManualIdempotente(manualFalhaId, "manual-falha", async () => {
      throw new Error("WhatsApp não está conectado");
    }),
    "failed",
  );
  assert.equal(
    await reenviarManualIdempotente(
      manualFalhaId,
      "manual-falha",
      async () => {},
    ),
    "failed",
  );

  limparBanco();
  const manualAmbiguoId = criarProduto("MLB-REENVIO-MANUAL-AMBIGUO");
  assert.equal(
    await reenviarManualIdempotente(
      manualAmbiguoId,
      "manual-ambiguo",
      async () => {
        throw new Error("conexão interrompida após o despacho");
      },
    ),
    "ambiguous",
  );
  assert.equal(
    await reenviarManualIdempotente(
      manualAmbiguoId,
      "manual-ambiguo",
      async () => {},
    ),
    "ambiguous",
  );

  limparBanco();
  const manualEmAndamentoId = criarProduto("MLB-REENVIO-MANUAL-EM-ANDAMENTO");
  let liberarEnvio: (() => void) | undefined;
  const envioBloqueado = reenviarManualIdempotente(
    manualEmAndamentoId,
    "manual-em-andamento",
    async () => {
      await new Promise<void>((resolve) => {
        liberarEnvio = resolve;
      });
    },
  );
  while (!liberarEnvio) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(
    await reenviarManualIdempotente(
      manualEmAndamentoId,
      "manual-em-andamento",
      async () => {},
    ),
    "sending",
  );
  liberarEnvio();
  assert.equal(await envioBloqueado, "sent");
  assert.equal(statusHttpReenvioManual("sent"), 200);
  assert.equal(statusHttpReenvioManual("sending"), 202);
  assert.equal(statusHttpReenvioManual("failed"), 502);
  assert.equal(statusHttpReenvioManual("ambiguous"), 502);
  assert.equal(statusHttpReenvioManual("conflito"), 409);
  assert.equal(statusHttpReenvioManual("ausente"), 404);

  limparBanco();
  const agoraOriginal = Date.now;
  let agora = 10_000;
  Date.now = () => agora;
  try {
    assert.equal(adquirirLockExecucao("teste-lock", "token-a", 100), true);
    assert.equal(adquirirLockExecucao("teste-lock", "token-b", 100), false);
    assert.equal(renovarLockExecucao("teste-lock", "token-a", 100), true);
    agora = 10_101;
    assert.equal(adquirirLockExecucao("teste-lock", "token-b", 100), true);
    assert.equal(renovarLockExecucao("teste-lock", "token-a", 100), false);
    liberarLockExecucao("teste-lock", "token-a");
    assert.equal(renovarLockExecucao("teste-lock", "token-b", 100), true);
    liberarLockExecucao("teste-lock", "token-b");
    assert.equal(adquirirLockExecucao("teste-lock", "token-c", 100), true);
    liberarLockExecucao("teste-lock", "token-c");
  } finally {
    Date.now = agoraOriginal;
  }

  limparBanco();
  setConfig("intervalo_entre_mensagens_ms", "25");
  const inicios: number[] = [];
  let emExecucao = 0;
  let maximoEmExecucao = 0;
  await Promise.all(
    [1, 2].map(() =>
      executarEnvioProtegido(async ({ aguardarIntervaloAntesDaMensagem }) => {
        await aguardarIntervaloAntesDaMensagem();
        emExecucao += 1;
        maximoEmExecucao = Math.max(maximoEmExecucao, emExecucao);
        inicios.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 5));
        emExecucao -= 1;
      }),
    ),
  );
  assert.equal(maximoEmExecucao, 1);
  assert.ok(inicios[1]! - inicios[0]! >= 20);

  limparBanco();
  setConfig("intervalo_entre_mensagens_ms", "25");
  const iniciarEm = join(diretorioTeste, "iniciar-envios");
  const prontoA = join(diretorioTeste, "envio-a-pronto");
  const prontoB = join(diretorioTeste, "envio-b-pronto");
  const resultadoA = join(diretorioTeste, "envio-a-resultado");
  const resultadoB = join(diretorioTeste, "envio-b-resultado");
  const envioA = executarEnvioEmProcesso(prontoA, iniciarEm, resultadoA);
  const envioB = executarEnvioEmProcesso(prontoB, iniciarEm, resultadoB);
  await Promise.all([esperarArquivo(prontoA), esperarArquivo(prontoB)]);
  writeFileSync(iniciarEm, "iniciar");
  await Promise.all([envioA, envioB]);
  const execucoes = [resultadoA, resultadoB]
    .map(
      (resultadoEm) =>
        JSON.parse(readFileSync(resultadoEm, "utf8")) as {
          inicio: number;
          fim: number;
        },
    )
    .sort((a, b) => a.inicio - b.inicio);
  assert.ok(execucoes[1]!.inicio >= execucoes[0]!.fim);
  assert.ok(execucoes[1]!.inicio - execucoes[0]!.inicio >= 20);

  limparBanco();
  const iniciarLotesEm = join(diretorioTeste, "iniciar-lotes");
  const loteProntoA = join(diretorioTeste, "lote-a-pronto");
  const loteProntoB = join(diretorioTeste, "lote-b-pronto");
  const loteResultadoA = join(diretorioTeste, "lote-a-resultado");
  const loteResultadoB = join(diretorioTeste, "lote-b-resultado");
  const loteA = executarLoteEmProcesso(
    loteProntoA,
    iniciarLotesEm,
    loteResultadoA,
  );
  const loteB = executarLoteEmProcesso(
    loteProntoB,
    iniciarLotesEm,
    loteResultadoB,
  );
  await Promise.all([esperarArquivo(loteProntoA), esperarArquivo(loteProntoB)]);
  writeFileSync(iniciarLotesEm, "iniciar");
  await Promise.all([loteA, loteB]);
  const lotes = [loteResultadoA, loteResultadoB].map(
    (resultadoEm) =>
      JSON.parse(readFileSync(resultadoEm, "utf8")) as { executou: boolean },
  );
  assert.equal(
    lotes.filter((lote) => lote.executou).length,
    1,
    "apenas um lote automático concorrente entre processos pode executar",
  );

  assert.equal(
    await tentarExecutarLoteAutomatico(async () => true),
    true,
    "um lote deve liberar o lock após concluir",
  );

  salvarConfigScheduler({
    ...obterConfigScheduler(),
    intervalo_entre_mensagens_ms: 750,
  });
  assert.equal(obterConfigScheduler().intervalo_entre_mensagens_ms, 750);

  console.log("Resultado: envios confiáveis passou");
} finally {
  db.close();
  process.chdir(diretorioOriginal);
  rmSync(diretorioTeste, { recursive: true, force: true });
}
