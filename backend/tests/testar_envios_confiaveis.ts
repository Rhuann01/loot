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
const { montarMensagemDoProduto } =
  await import("../src/whatsapp/sender.js");

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

function criarProdutoShopee(
  codigo: string,
  linkOriginal: string,
  linkAfiliado: string,
): number {
  salvarProduto({
    source_key: "shopee",
    external_product_id: codigo,
    nome: `Produto ${codigo}`,
    preco_atual: "80,00",
    preco_original: "100,00",
    desconto_percentual: 50,
    link_original: linkOriginal,
    link_afiliado: linkAfiliado,
  });
  return (
    db
      .prepare(
        "SELECT id FROM produtos WHERE source_key = 'shopee' AND external_product_id = ?",
      )
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

  // Caso A: Shopee com link igual ao original e sem credencial – bloqueado
  delete process.env.SHOPEE_APP_ID;
  delete process.env.SHOPEE_SECRET;
  limparBanco();
  setConfig("auto_envio_ativo", "true");
  criarProdutoShopee(
    "1_1",
    "https://shopee.com.br/product/1/1",
    "https://shopee.com.br/product/1/1",
  );
  let shopeeEnviosA = 0;
  await enviarLote(1, async () => {
    shopeeEnviosA += 1;
  });
  assert.equal(shopeeEnviosA, 0, "Shopee com link igual ao original não deve ser enviada");
  {
    const prodShopeeA = db
      .prepare(
        "SELECT * FROM produtos WHERE source_key = 'shopee' AND external_product_id = '1_1'",
      )
      .get() as { id: number; status_fila: string; ultimo_erro_envio: string | null };
    assert.equal(prodShopeeA.status_fila, "failed");
    assert.equal(listarTentativasEnvio(prodShopeeA.id)[0]?.status, "failed");
    assert.match(prodShopeeA.ultimo_erro_envio ?? "", /link afiliado/i);
  }

  // Caso B: Shopee com link de afiliado já válido é enviada com esse link
  delete process.env.SHOPEE_APP_ID;
  delete process.env.SHOPEE_SECRET;
  limparBanco();
  setConfig("auto_envio_ativo", "true");
  criarProdutoShopee(
    "2_2",
    "https://shopee.com.br/product/2/2",
    "https://shope.ee/abc123",
  );
  let shopeeLinkEnviadoB: string | undefined;
  await enviarLote(
    1,
    async (produto) => {
      shopeeLinkEnviadoB = produto.link_afiliado;
    },
    async () => ({
      decisao: {
        enviar: true as const,
        precoAtual: 80,
        descontoPercentual: 50,
      },
      atual: { precoAtual: 80, descontoPercentual: 50 },
    }),
  );
  assert.equal(shopeeLinkEnviadoB, "https://shope.ee/abc123");
  {
    const prodShopeeB = db
      .prepare(
        "SELECT * FROM produtos WHERE source_key = 'shopee' AND external_product_id = '2_2'",
      )
      .get() as { status_fila: string };
    assert.equal(prodShopeeB.status_fila, "sent");
  }

  // Caso C: reenvio manual de Shopee com link igual ao original é bloqueado
  delete process.env.SHOPEE_APP_ID;
  delete process.env.SHOPEE_SECRET;
  limparBanco();
  const shopeeIdC = criarProdutoShopee(
    "3_3",
    "https://shopee.com.br/product/3/3",
    "https://shopee.com.br/product/3/3",
  );
  let shopeeEnviosC = 0;
  assert.equal(
    await reenviarManualIdempotente(
      shopeeIdC,
      "manual-shopee-original",
      async () => {
        shopeeEnviosC += 1;
      },
    ),
    "failed",
  );
  assert.equal(shopeeEnviosC, 0);
  assert.equal(buscarProdutoPorId(shopeeIdC)?.status_fila, "failed");

  // ---- Recheca de preço da Shopee ----
  function prepararCasoRecheca() {
    limparBanco();
    setConfig("auto_envio_ativo", "true");
    setConfig("limite_diario", "5");
  }

  const rechecaOk = (preco: number, desconto: number) => async () => ({
    decisao: {
      enviar: true as const,
      precoAtual: preco,
      descontoPercentual: desconto,
    },
    atual: { precoAtual: preco, descontoPercentual: desconto },
  });

  // T1: preço igual
  {
    prepararCasoRecheca();
    const id = criarProdutoShopee(
      "10_10",
      "https://shopee.com.br/product/10/10",
      "https://s.shopee.com.br/abc10",
    );
    const enviados: string[] = [];
    await enviarLote(
      1,
      async (produto) => {
        enviados.push(produto.preco_atual);
      },
      rechecaOk(80, 50),
    );
    assert.deepEqual(enviados, ["80,00"]);
    assert.equal(buscarProdutoPorId(id)?.status_fila, "sent");
  }

  // T2: preço caiu
  {
    prepararCasoRecheca();
    const id = criarProdutoShopee(
      "11_11",
      "https://shopee.com.br/product/11/11",
      "https://s.shopee.com.br/abc11",
    );
    const enviados: Array<{ atual: string; original: string | null | undefined }> = [];
    await enviarLote(
      1,
      async (produto) => {
        enviados.push({
          atual: produto.preco_atual,
          original: produto.preco_original,
        });
      },
      rechecaOk(64, 60),
    );
    assert.deepEqual(enviados, [{ atual: "64,00", original: null }]);
    const p = buscarProdutoPorId(id);
    assert.equal(p?.preco_atual, "64,00");
    assert.equal(p?.desconto_percentual, 60);
    assert.equal(p?.status_fila, "sent");
  }

  // T3: preço subiu => descarta; depois reenvia com o preço novo
  {
    prepararCasoRecheca();
    const id = criarProdutoShopee(
      "12_12",
      "https://shopee.com.br/product/12/12",
      "https://s.shopee.com.br/abc12",
    );
    let chamadas = 0;
    const rechecar = async () => {
      chamadas += 1;
      return chamadas === 1
        ? {
            decisao: {
              enviar: false as const,
              motivo: "Preço subiu desde a coleta",
            },
            atual: { precoAtual: 90, descontoPercentual: 40 },
          }
        : {
            decisao: {
              enviar: true as const,
              precoAtual: 90,
              descontoPercentual: 40,
            },
            atual: { precoAtual: 90, descontoPercentual: 40 },
          };
    };
    const enviados: string[] = [];
    const capturar = async (produto: { preco_atual: string }) => {
      enviados.push(produto.preco_atual);
    };

    await enviarLote(1, capturar, rechecar);
    assert.deepEqual(enviados, []);
    const apos1 = buscarProdutoPorId(id);
    assert.equal(apos1?.status_fila, "failed");
    assert.match(apos1?.ultimo_erro_envio ?? "", /Preço subiu/);
    assert.equal(apos1?.preco_atual, "90,00");
    assert.equal(apos1?.desconto_percentual, 40);
    assert.equal(apos1?.tentativas_envio, 1);
    assert.equal(listarTentativasEnvio(id)[0]?.status, "failed");

    await enviarLote(1, capturar, rechecar);
    assert.deepEqual(enviados, ["90,00"]);
    assert.equal(buscarProdutoPorId(id)?.status_fila, "sent");
  }

  // T4: desconto caiu abaixo do mínimo
  {
    prepararCasoRecheca();
    const id = criarProdutoShopee(
      "13_13",
      "https://shopee.com.br/product/13/13",
      "https://s.shopee.com.br/abc13",
    );
    let enviosT4 = 0;
    await enviarLote(
      1,
      async () => {
        enviosT4 += 1;
      },
      async () => ({
        decisao: {
          enviar: false as const,
          motivo: "Desconto atual abaixo do mínimo",
        },
        atual: { precoAtual: 80, descontoPercentual: 10 },
      }),
    );
    assert.equal(enviosT4, 0);
    const p = buscarProdutoPorId(id);
    assert.equal(p?.desconto_percentual, 10);
    assert.equal(p?.status_fila, "failed");
    assert.equal(reservarProdutoParaEnvio(), undefined);
  }

  // T5: oferta sumiu
  {
    prepararCasoRecheca();
    const id = criarProdutoShopee(
      "14_14",
      "https://shopee.com.br/product/14/14",
      "https://s.shopee.com.br/abc14",
    );
    let enviosT5 = 0;
    await enviarLote(
      1,
      async () => {
        enviosT5 += 1;
      },
      async () => ({
        decisao: {
          enviar: false as const,
          motivo: "Oferta não encontrada na Shopee",
        },
        atual: null,
      }),
    );
    assert.equal(enviosT5, 0);
    const p = buscarProdutoPorId(id);
    assert.equal(p?.tentativas_envio, 3);
    assert.equal(p?.status_fila, "failed");
    assert.equal(reservarProdutoParaEnvio(), undefined);
  }

  // T6: API fora do ar => devolve à fila sem consumir tentativa e encerra o lote
  {
    prepararCasoRecheca();
    criarProdutoShopee(
      "15_15",
      "https://shopee.com.br/product/15/15",
      "https://s.shopee.com.br/abc15",
    );
    criarProdutoShopee(
      "16_16",
      "https://shopee.com.br/product/16/16",
      "https://s.shopee.com.br/abc16",
    );
    let chamadasT6 = 0;
    let enviosT6 = 0;
    await enviarLote(
      2,
      async () => {
        enviosT6 += 1;
      },
      async () => {
        chamadasT6 += 1;
        throw new Error("rede caiu");
      },
    );
    assert.equal(chamadasT6, 1);
    assert.equal(enviosT6, 0);
    const alterados = db
      .prepare(
        "SELECT COUNT(*) AS n FROM produtos WHERE status_fila != 'pending' OR tentativas_envio != 0",
      )
      .get() as { n: number };
    assert.equal(alterados.n, 0);
    const canceladas = db
      .prepare(
        "SELECT COUNT(*) AS n FROM tentativas_de_envio WHERE status = 'cancelled'",
      )
      .get() as { n: number };
    assert.equal(canceladas.n, 1);
  }

  // T7: descarte não interrompe o lote e o Mercado Livre não passa pela recheca
  {
    prepararCasoRecheca();
    const idMl = criarProdutoComLinks(
      "MLB-T7",
      "https://example.test/original-t7",
      "https://example.test/afiliado-t7",
    );
    const idShopee = criarProdutoShopee(
      "17_17",
      "https://shopee.com.br/product/17/17",
      "https://s.shopee.com.br/abc17",
    );
    let chamadasT7 = 0;
    const linksEnviados: string[] = [];
    await enviarLote(
      2,
      async (produto) => {
        linksEnviados.push(produto.link_afiliado);
      },
      async () => {
        chamadasT7 += 1;
        return {
          decisao: {
            enviar: false as const,
            motivo: "Oferta não encontrada na Shopee",
          },
          atual: null,
        };
      },
    );
    assert.equal(chamadasT7, 1);
    assert.deepEqual(linksEnviados, ["https://example.test/afiliado-t7"]);
    const shopeeT7 = buscarProdutoPorId(idShopee);
    assert.equal(shopeeT7?.tentativas_envio, 3);
    assert.equal(shopeeT7?.status_fila, "failed");
    assert.equal(buscarProdutoPorId(idMl)?.status_fila, "sent");
  }

  // ---- Recheca no reenvio manual (Shopee) ----
  limparBanco();
  {
    const idOk = criarProdutoShopee(
      "20_20",
      "https://shopee.com.br/product/20/20",
      "https://s.shopee.com.br/abc20",
    );
    const enviadosManual: string[] = [];
    assert.equal(
      await reenviarManualIdempotente(
        idOk,
        "manual-shopee-preco-caiu",
        async (p) => {
          enviadosManual.push(p.preco_atual);
        },
        async () => ({ precoAtual: 64, descontoPercentual: 60 }),
      ),
      "sent",
    );
    assert.deepEqual(enviadosManual, ["64,00"]);
    assert.equal(buscarProdutoPorId(idOk)?.preco_atual, "64,00");

    const idSobe = criarProdutoShopee(
      "21_21",
      "https://shopee.com.br/product/21/21",
      "https://s.shopee.com.br/abc21",
    );
    let enviosSobe = 0;
    assert.equal(
      await reenviarManualIdempotente(
        idSobe,
        "manual-shopee-preco-subiu",
        async () => {
          enviosSobe += 1;
        },
        async () => ({ precoAtual: 95, descontoPercentual: 40 }),
      ),
      "failed",
    );
    assert.equal(enviosSobe, 0);
    assert.match(buscarProdutoPorId(idSobe)?.ultimo_erro_envio ?? "", /Preço subiu/);

    const idFora = criarProdutoShopee(
      "22_22",
      "https://shopee.com.br/product/22/22",
      "https://s.shopee.com.br/abc22",
    );
    let enviosFora = 0;
    assert.equal(
      await reenviarManualIdempotente(
        idFora,
        "manual-shopee-api-fora",
        async () => {
          enviosFora += 1;
        },
        async () => {
          throw new Error("rede caiu");
        },
      ),
      "failed",
    );
    assert.equal(enviosFora, 0);
    assert.match(
      buscarProdutoPorId(idFora)?.ultimo_erro_envio ?? "",
      /Não foi possível conferir o preço/,
    );
    assert.equal(listarTentativasEnvio(idFora)[0]?.status, "failed");

    const idMl = criarProdutoComLinks(
      "MLB-MANUAL-SEM-RECHECA",
      "https://example.test/original-ml-manual",
      "https://example.test/afiliado-ml-manual",
    );
    assert.equal(
      await reenviarManualIdempotente(
        idMl,
        "manual-ml-sem-recheca",
        async () => {},
        async () => {
          throw new Error("ML não deve consultar a Shopee");
        },
      ),
      "sent",
    );
  }

  // ---- Testes de Snapshot de Tentativa ----

  // (a) PRAGMA table_info e schema_migrations
  {
    const colunas = (
      db.prepare("PRAGMA table_info(tentativas_de_envio)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    for (const col of [
      "mensagem_snapshot",
      "destino_id",
      "destino_nome",
      "plataforma",
      "titulo",
      "url_original",
    ]) {
      assert.ok(colunas.includes(col), `coluna ${col} deve existir`);
    }

    const versoes = (
      db.prepare("SELECT versao FROM schema_migrations").all() as Array<{
        versao: number;
      }>
    ).map((r) => r.versao);
    assert.ok(versoes.includes(1), "versao 1 deve existir");
    assert.ok(versoes.includes(2), "versao 2 deve existir");
  }

  // (b) Envio automático Shopee
  {
    limparBanco();
    setConfig("auto_envio_ativo", "true");
    setConfig("limite_diario", "5");
    setConfig("whatsapp_grupo_id", "123@g.us");
    setConfig("whatsapp_grupo_nome", "Grupo Teste");

    const id = criarProdutoShopee(
      "30_30",
      "https://shopee.com.br/product/30/30",
      "https://s.shopee.com.br/abc30",
    );
    let capturado: any = null;
    await enviarLote(
      1,
      async (produto) => {
        capturado = produto;
      },
      rechecaOk(80, 50),
    );

    const tentativa = listarTentativasEnvio(id)[0];
    assert.ok(tentativa);
    assert.ok(tentativa.mensagem_snapshot?.includes("Por: *R$ 80,00*"));
    assert.ok(tentativa.mensagem_snapshot?.includes("50% OFF"));
    assert.ok(
      tentativa.mensagem_snapshot?.includes("https://s.shopee.com.br/abc30"),
    );
    assert.ok(!tentativa.mensagem_snapshot?.includes("De:"));
    assert.equal(tentativa.destino_id, "123@g.us");
    assert.equal(tentativa.destino_nome, "Grupo Teste");
    assert.equal(tentativa.plataforma, "shopee");
    assert.equal(tentativa.titulo, "Produto 30_30");
    assert.equal(tentativa.origem, "auto");
    assert.ok(capturado);
    assert.equal(
      tentativa.mensagem_snapshot,
      montarMensagemDoProduto(capturado),
    );
  }

  // (c) Envio automático ML
  {
    limparBanco();
    setConfig("auto_envio_ativo", "true");
    setConfig("limite_diario", "5");
    setConfig("whatsapp_grupo_id", "123@g.us");
    setConfig("whatsapp_grupo_nome", "Grupo Teste");

    const idMl = criarProdutoComLinks(
      "MLB-SNAP",
      "https://example.test/original-snap",
      "https://example.test/afiliado-snap",
    );
    await enviarLote(1, async () => {});

    const tentativa = listarTentativasEnvio(idMl)[0];
    assert.ok(tentativa);
    assert.ok(tentativa.mensagem_snapshot?.includes("De: ~R$ 100~"));
    assert.ok(tentativa.mensagem_snapshot?.includes("Por: *R$ 80*"));
  }

  // (d) Reenvio manual Shopee
  {
    limparBanco();
    setConfig("whatsapp_grupo_id", "123@g.us");
    setConfig("whatsapp_grupo_nome", "Grupo Teste");

    const id = criarProdutoShopee(
      "31_31",
      "https://shopee.com.br/product/31/31",
      "https://s.shopee.com.br/abc31",
    );
    let capturadoManual: any = null;
    const resultado = await reenviarManualIdempotente(
      id,
      "snap-manual-1",
      async (produto) => {
        capturadoManual = produto;
      },
      async () => ({ precoAtual: 80, descontoPercentual: 50 }),
    );
    assert.equal(resultado, "sent");
    const tentativa = listarTentativasEnvio(id)[0];
    assert.ok(tentativa);
    assert.equal(tentativa.origem, "manual");
    assert.ok(capturadoManual);
    assert.equal(
      tentativa.mensagem_snapshot,
      montarMensagemDoProduto(capturadoManual),
    );
  }

  // (e) Tentativa sem snapshot (legado)
  {
    const id = criarProduto("MLB-LEGADO-SNAP");
    const res = db
      .prepare(
        "INSERT INTO tentativas_de_envio (produto_id, origem, status) VALUES (?, 'auto', 'sent') RETURNING *",
      )
      .get(id) as any;
    assert.equal(res.mensagem_snapshot, null);
    const doBanco = listarTentativasEnvio(id)[0];
    assert.equal(doBanco?.mensagem_snapshot, null);
  }

  console.log("Resultado: envios confiáveis passou");
} finally {
  db.close();
  process.chdir(diretorioOriginal);
  rmSync(diretorioTeste, { recursive: true, force: true });
}
