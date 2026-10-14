import db from "./index.js";
import { randomUUID } from "node:crypto";
import { SQL_HOJE_BRASILIA, sqlDiaBrasilia } from "../lib/time.js";

export interface Produto {
  id: number;
  produto_id_ml: string | null;
  source_key: string;
  external_product_id: string;
  nome: string;
  preco_atual: string;
  preco_original: string | null;
  desconto_percentual: number;
  imagem_url: string | null;
  link_original: string | null;
  link_afiliado: string;
  categoria_id: string | null;
  selecionado: number;
  enviado: number;
  status_fila: "pending" | "sending" | "sent" | "failed" | "ambiguous";
  tentativas_envio: number;
  ultimo_erro_envio: string | null;
  envio_iniciado_em: string | null;
  origem_envio_em_andamento: OrigemEnvio | null;
  oferta_expira_em: number | null;
  criado_em: string;
}

export type OrigemEnvio = "manual" | "auto" | "retry";

export interface TentativaEnvio {
  id: number;
  produto_id: number;
  origem: OrigemEnvio;
  status: "sending" | "sent" | "failed" | "ambiguous" | "cancelled";
  motivo: string | null;
  iniciado_em: string;
  finalizado_em: string | null;
  mensagem_snapshot: string | null;
  destino_id: string | null;
  destino_nome: string | null;
  plataforma: string | null;
  titulo: string | null;
  url_original: string | null;
  erro_codigo: string | null;
  erro_mensagem: string | null;
}
export interface NovoProduto {
  source_key?: string;
  external_product_id: string;
  nome: string;
  preco_atual: string;
  preco_original?: string | null;
  desconto_percentual?: number;
  imagem_url?: string;
  link_original?: string;
  link_afiliado: string;
  categoria_id?: string;
  oferta_expira_em?: number;
  comissao_valor?: number | null;
  comissao_percentual?: number | null;
}

export function salvarProduto(produto: NovoProduto) {
  const dados = {
    produto_id_ml:
      produto.source_key === "mercado_livre"
        ? produto.external_product_id
        : null,
    source_key: produto.source_key ?? "mercado_livre",
    external_product_id: produto.external_product_id,
    marketplace_origem: produto.source_key ?? "mercado_livre",
    nome: produto.nome,
    preco_atual: produto.preco_atual,
    preco_original: produto.preco_original ?? null,
    desconto_percentual: produto.desconto_percentual ?? 0,
    imagem_url: produto.imagem_url ?? null,
    link_original: produto.link_original ?? null,
    link_afiliado: produto.link_afiliado,
    categoria_id: produto.categoria_id ?? null,
    oferta_expira_em: produto.oferta_expira_em ?? null,
  };

  const inserir = db.prepare(`
    INSERT INTO produtos 
      (produto_id_ml, source_key, external_product_id, marketplace_origem, nome, preco_atual, preco_original, desconto_percentual, imagem_url, link_original, link_afiliado, categoria_id, oferta_expira_em)
    VALUES 
      (@produto_id_ml, @source_key, @external_product_id, @marketplace_origem, @nome, @preco_atual, @preco_original, @desconto_percentual, @imagem_url, @link_original, @link_afiliado, @categoria_id, @oferta_expira_em)
    ON CONFLICT(source_key, external_product_id) DO UPDATE SET
      produto_id_ml = excluded.produto_id_ml,
      marketplace_origem = excluded.marketplace_origem,
      preco_atual = excluded.preco_atual,
      preco_original = excluded.preco_original,
      desconto_percentual = excluded.desconto_percentual,
      imagem_url = excluded.imagem_url,
      link_original = COALESCE(excluded.link_original, produtos.link_original),
      oferta_expira_em = excluded.oferta_expira_em,
      criado_em = CURRENT_TIMESTAMP
  `);
  inserir.run(dados);

  if (
    dados.source_key === "shopee" &&
    (produto.comissao_valor != null || produto.comissao_percentual != null)
  ) {
    const salvo = db
      .prepare(
        "SELECT id FROM produtos WHERE source_key = ? AND external_product_id = ?",
      )
      .get(dados.source_key, dados.external_product_id) as { id: number } | undefined;
    if (salvo) {
      gravarSnapshotComissao({
        produto_id: salvo.id,
        integracao_key: "shopee",
        comissao_valor: produto.comissao_valor,
        comissao_percentual: produto.comissao_percentual,
      });
    }
  }
}

export function limparProdutosAntigos(): number {
  const resultado = db
    .prepare(
      `
      DELETE FROM produtos
      WHERE status_fila IN ('sent', 'failed')
        AND datetime(criado_em) < datetime('now', '-30 days')
        AND NOT EXISTS (
          SELECT 1 FROM envios WHERE envios.produto_id = produtos.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM tentativas_de_envio
          WHERE tentativas_de_envio.produto_id = produtos.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM idempotencias_reenvio_manual
          WHERE idempotencias_reenvio_manual.produto_id = produtos.id
        )
    `,
    )
    .run();
  return resultado.changes;
}

export function buscarProdutoPorCodigoML(
  produtoIdMl: string,
): Produto | undefined {
  return db
    .prepare(
      `SELECT * FROM produtos WHERE source_key = 'mercado_livre' AND external_product_id = ?`,
    )
    .get(produtoIdMl) as Produto | undefined;
}

export function buscarProdutosPorCodigosML(produtoIds: string[]): Produto[] {
  if (produtoIds.length === 0) return [];

  const placeholders = produtoIds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM produtos
       WHERE source_key = 'mercado_livre' AND external_product_id IN (${placeholders})`,
    )
    .all(...produtoIds) as Produto[];
}

export function atualizarLinkAfiliado(
  produtoIdMl: string,
  linkAfiliado: string,
) {
  db.prepare(
    `UPDATE produtos
     SET link_afiliado = ?
     WHERE source_key = 'mercado_livre' AND external_product_id = ?`,
  ).run(linkAfiliado, produtoIdMl);
}

export function atualizarLinkAfiliadoPorFonte(
  sourceKey: string,
  externalProductId: string,
  linkAfiliado: string,
) {
  db.prepare(
    `UPDATE produtos
     SET link_afiliado = ?
     WHERE source_key = ? AND external_product_id = ?`,
  ).run(linkAfiliado, sourceKey, externalProductId);
}

export function listarProdutos(): Produto[] {
  return db
    .prepare(`SELECT * FROM produtos ORDER BY criado_em DESC`)
    .all() as Produto[];
}

export function getMelhoresDescontos(limite: number): Produto[] {
  const { descontoMinimo, janelaDias, janelaShopeeHoras } = obterCriteriosDaFila();

  return db
    .prepare(
      `
    SELECT * FROM produtos 
    WHERE enviado = 0
      AND status_fila IN ('pending', 'failed')
      AND tentativas_envio < 3
      AND desconto_percentual >= ?
      AND datetime(criado_em) >= datetime('now', CASE WHEN source_key = 'shopee' THEN ? ELSE ? END)
      AND (oferta_expira_em IS NULL OR oferta_expira_em > CAST(strftime('%s','now') AS INTEGER))
    ORDER BY selecionado DESC, desconto_percentual DESC, datetime(criado_em) DESC, id DESC
    LIMIT ?
  `,
    )
    .all(
      descontoMinimo,
      `-${janelaShopeeHoras} hours`,
      `-${janelaDias} days`,
      limite,
    ) as Produto[];
}

function obterCriteriosDaFila() {
  const descontoMinimo = Math.max(
    0,
    Number(getConfig("desconto_minimo_global") ?? 20) || 0,
  );
  const janelaDias = Math.max(
    1,
    Number(getConfig("janela_fallback_dias") ?? 3) || 3,
  );
  const janelaShopeeHoras = Math.max(
    1,
    Number(getConfig("janela_shopee_horas") ?? 12) || 12,
  );

  return { descontoMinimo, janelaDias, janelaShopeeHoras };
}

export function getProdutosSelecionadosManualmente(): Produto[] {
  return db
    .prepare(
      `
    SELECT * FROM produtos WHERE selecionado = 1 AND enviado = 0
  `,
    )
    .all() as Produto[];
}

export function alternarSelecao(id: number, selecionado: boolean) {
  db.prepare(`UPDATE produtos SET selecionado = ? WHERE id = ?`).run(
    selecionado ? 1 : 0,
    id,
  );
}

export function getConfig(chave: string): string | undefined {
  const linha = db
    .prepare(`SELECT valor FROM config WHERE chave = ?`)
    .get(chave) as { valor: string } | undefined;
  return linha?.valor;
}

export function setConfig(chave: string, valor: string) {
  db.prepare(
    `
    INSERT INTO config (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `,
  ).run(chave, valor);
}

export function listarCategoriasMonitoradas() {
  return db
    .prepare(`SELECT * FROM categorias_monitoradas WHERE ativa = 1`)
    .all();
}

export function adicionarCategoriaMonitorada(
  categoria_id: string,
  categoria_nome: string,
) {
  db.prepare(
    `
    INSERT OR IGNORE INTO categorias_monitoradas (categoria_id, categoria_nome)
    VALUES (?, ?)
  `,
  ).run(categoria_id, categoria_nome);
}

export function marcarComoEnviado(produtoId: number, tentativaId?: number) {
  const transacao = db.transaction(() => {
    db.prepare(
      `
      UPDATE produtos
      SET enviado = 1,
          status_fila = 'sent',
          envio_iniciado_em = NULL,
          origem_envio_em_andamento = NULL,
          ultimo_erro_envio = NULL
      WHERE id = ?
    `,
    ).run(produtoId);
    if (tentativaId !== undefined) {
      db.prepare(
        `UPDATE tentativas_de_envio
         SET status = 'sent', motivo = NULL, finalizado_em = CURRENT_TIMESTAMP
         WHERE id = ? AND produto_id = ? AND status = 'sending'`,
      ).run(tentativaId, produtoId);
    }
    db.prepare(`INSERT INTO envios (produto_id) VALUES (?)`).run(produtoId);

    const prod = produtoId ? buscarProdutoPorId(produtoId) : undefined;
    gravarAtividade({
      tipo: "envio_sucesso",
      integracao_key: prod?.source_key ?? null,
      produto_id: produtoId || null,
      tentativa_id: tentativaId ?? null,
      titulo: `Envio concluído: ${prod?.nome ? prod.nome.slice(0, 50) : `Produto ${produtoId}`}`,
      detalhe: "Mensagem enviada com sucesso",
    });
  });
  transacao();
}

export interface ReservaEnvio {
  produto: Produto;
  tentativa: TentativaEnvio;
}

export function reservarProdutoParaEnvioComTentativa(): ReservaEnvio | undefined {
  const { descontoMinimo, janelaDias, janelaShopeeHoras } = obterCriteriosDaFila();
  const limiteDiario = Math.max(
    0,
    Number(getConfig("limite_diario") ?? 12) || 0,
  );

  return db.transaction(() => {
    const produto = db
      .prepare(
      `
      UPDATE produtos
      SET status_fila = 'sending',
          tentativas_envio = tentativas_envio + 1,
          envio_iniciado_em = CURRENT_TIMESTAMP,
          ultimo_erro_envio = NULL
      WHERE id = (
        SELECT c.id FROM produtos AS c
        WHERE c.enviado = 0
          AND c.status_fila IN ('pending', 'failed')
          AND c.tentativas_envio < 3
          AND c.desconto_percentual >= ?
          AND datetime(c.criado_em) >= datetime('now', CASE WHEN c.source_key = 'shopee' THEN ? ELSE ? END)
          AND (c.oferta_expira_em IS NULL OR c.oferta_expira_em > CAST(strftime('%s','now') AS INTEGER))
        ORDER BY c.selecionado DESC,
          (
            (SELECT COUNT(*) FROM envios e
               JOIN produtos pe ON pe.id = e.produto_id
              WHERE ${sqlDiaBrasilia("e.enviado_em")} = ${SQL_HOJE_BRASILIA}
                AND pe.source_key = c.source_key)
            +
            (SELECT COUNT(*) FROM produtos ps
              WHERE ps.enviado = 0
                AND ps.status_fila = 'sending'
                AND ${sqlDiaBrasilia("ps.envio_iniciado_em")} = ${SQL_HOJE_BRASILIA}
                AND ps.source_key = c.source_key)
          ) ASC,
          c.desconto_percentual DESC, datetime(c.criado_em) DESC, c.id DESC
        LIMIT 1
      )
      AND (
        (SELECT COUNT(*) FROM envios WHERE ${sqlDiaBrasilia("enviado_em")} = ${SQL_HOJE_BRASILIA}) +
        (SELECT COUNT(*) FROM produtos
         WHERE enviado = 0
           AND status_fila = 'sending'
           AND ${sqlDiaBrasilia("envio_iniciado_em")} = ${SQL_HOJE_BRASILIA})
      ) < ?
      RETURNING *
    `,
      )
      .get(
        descontoMinimo,
        `-${janelaShopeeHoras} hours`,
        `-${janelaDias} days`,
        limiteDiario,
      ) as
      | Produto
      | undefined;
    if (!produto) return undefined;

    db.prepare(
      `UPDATE produtos SET origem_envio_em_andamento = 'auto' WHERE id = ?`,
    ).run(produto.id);
    const tentativa = db
      .prepare(
        `INSERT INTO tentativas_de_envio (produto_id, origem, status)
         VALUES (?, 'auto', 'sending') RETURNING *`,
      )
      .get(produto.id) as TentativaEnvio;
    return {
      produto: buscarProdutoPorId(produto.id) as Produto,
      tentativa,
    };
  })();
}

export function reservarProdutoParaEnvio(): Produto | undefined {
  return reservarProdutoParaEnvioComTentativa()?.produto;
}

export function marcarFalhaEnvio(
  produtoId: number,
  erro: string,
  tentativaId?: number,
  preservarProdutoEnviado = false,
) {
  db.prepare(
    `
    UPDATE produtos
    SET status_fila = CASE
          WHEN ? = 1 AND enviado = 1 THEN 'sent'
          ELSE 'failed'
        END,
        ultimo_erro_envio = ?,
        envio_iniciado_em = NULL,
        origem_envio_em_andamento = NULL
    WHERE id = ?
  `,
  ).run(preservarProdutoEnviado ? 1 : 0, erro.slice(0, 500), produtoId);
  if (tentativaId !== undefined) {
    db.prepare(
      `UPDATE tentativas_de_envio
       SET status = 'failed', motivo = ?, finalizado_em = CURRENT_TIMESTAMP
       WHERE id = ? AND produto_id = ? AND status = 'sending'`,
    ).run(erro.slice(0, 500), tentativaId, produtoId);
  }

  const prod = produtoId ? buscarProdutoPorId(produtoId) : undefined;
  gravarAtividade({
    tipo: "envio_falha",
    integracao_key: prod?.source_key ?? null,
    produto_id: produtoId || null,
    tentativa_id: tentativaId ?? null,
    titulo: `Falha no envio: ${prod?.nome ? prod.nome.slice(0, 50) : `Produto ${produtoId}`}`,
    detalhe: erro ? erro.slice(0, 200) : "Falha desconhecida",
  });
}

export function marcarEnvioAmbiguo(
  produtoId: number,
  erro: string,
  tentativaId?: number,
) {
  db.prepare(
    `
    UPDATE produtos
    SET status_fila = 'ambiguous',
        ultimo_erro_envio = ?,
        envio_iniciado_em = NULL,
        origem_envio_em_andamento = NULL
    WHERE id = ?
  `,
  ).run(erro.slice(0, 500), produtoId);
  if (tentativaId !== undefined) {
    db.prepare(
      `UPDATE tentativas_de_envio
       SET status = 'ambiguous', motivo = ?, finalizado_em = CURRENT_TIMESTAMP
       WHERE id = ? AND produto_id = ? AND status = 'sending'`,
    ).run(erro.slice(0, 500), tentativaId, produtoId);
  }

  const prod = produtoId ? buscarProdutoPorId(produtoId) : undefined;
  gravarAtividade({
    tipo: "envio_ambiguo",
    integracao_key: prod?.source_key ?? null,
    produto_id: produtoId || null,
    tentativa_id: tentativaId ?? null,
    titulo: `Envio com status ambíguo: ${prod?.nome ? prod.nome.slice(0, 50) : `Produto ${produtoId}`}`,
    detalhe: erro ? erro.slice(0, 200) : "Status de entrega incerto",
  });
}

export function atualizarPrecoProduto(
  produtoId: number,
  precos: {
    preco_atual: string;
    preco_original: string | null;
    desconto_percentual: number;
  },
) {
  db.prepare(
    `UPDATE produtos
     SET preco_atual = ?, preco_original = ?, desconto_percentual = ?
     WHERE id = ?`,
  ).run(
    precos.preco_atual,
    precos.preco_original,
    precos.desconto_percentual,
    produtoId,
  );
}

// Oferta que não existe mais: impede que o produto volte à fila automática.
export function esgotarTentativasProduto(produtoId: number) {
  db.prepare(
    `UPDATE produtos SET tentativas_envio = 3 WHERE id = ? AND enviado = 0`,
  ).run(produtoId);
}

// A recheca não pôde ser feita (rede/API): devolve o produto à fila sem
// consumir a tentativa e registra a tentativa como cancelada.
export function cancelarReservaSemConsumirTentativa(
  produtoId: number,
  tentativaId: number,
  motivo: string,
) {
  const texto = motivo.slice(0, 500);
  db.transaction(() => {
    db.prepare(
      `UPDATE produtos
       SET status_fila = 'pending',
           tentativas_envio = MAX(tentativas_envio - 1, 0),
           envio_iniciado_em = NULL,
           origem_envio_em_andamento = NULL,
           ultimo_erro_envio = ?
       WHERE id = ? AND enviado = 0 AND status_fila = 'sending'`,
    ).run(texto, produtoId);
    db.prepare(
      `UPDATE tentativas_de_envio
       SET status = 'cancelled', motivo = ?, finalizado_em = CURRENT_TIMESTAMP
       WHERE id = ? AND produto_id = ? AND status = 'sending'`,
    ).run(texto, tentativaId, produtoId);
  })();
}

export function liberarReservaEnvio(produtoId: number) {
  db.prepare(
    `
    UPDATE produtos
    SET status_fila = 'pending', envio_iniciado_em = NULL,
        origem_envio_em_andamento = NULL
    WHERE id = ? AND enviado = 0 AND status_fila = 'sending'
  `,
  ).run(produtoId);
}

export function iniciarEnvioManual(produtoId: number): ReservaEnvio | undefined {
  return db.transaction(() => {
    const existente = buscarProdutoPorId(produtoId);
    if (!existente) return undefined;
    db.prepare(
      `UPDATE produtos
       SET status_fila = 'sending', envio_iniciado_em = CURRENT_TIMESTAMP,
           origem_envio_em_andamento = 'manual', ultimo_erro_envio = NULL
       WHERE id = ?`,
    ).run(produtoId);
    const tentativa = db
      .prepare(
        `INSERT INTO tentativas_de_envio (produto_id, origem, status)
         VALUES (?, 'manual', 'sending') RETURNING *`,
      )
      .get(produtoId) as TentativaEnvio;
    return { produto: buscarProdutoPorId(produtoId) as Produto, tentativa };
  })();
}

export type InicioEnvioManualIdempotente =
  | { tipo: "nova"; reserva: ReservaEnvio }
  | { tipo: "existente"; tentativa: TentativaEnvio }
  | { tipo: "conflito" }
  | { tipo: "ausente" };

export function iniciarEnvioManualIdempotente(
  produtoId: number,
  chave: string,
): InicioEnvioManualIdempotente {
  const transacao = db.transaction(() => {
    const existente = db
      .prepare(
        `SELECT produto_id, tentativa_id
         FROM idempotencias_reenvio_manual WHERE chave = ?`,
      )
      .get(chave) as { produto_id: number; tentativa_id: number } | undefined;
    if (existente) {
      if (existente.produto_id !== produtoId) return { tipo: "conflito" } as const;
      const tentativa = db
        .prepare(`SELECT * FROM tentativas_de_envio WHERE id = ?`)
        .get(existente.tentativa_id) as TentativaEnvio;
      return { tipo: "existente", tentativa } as const;
    }

    const produto = buscarProdutoPorId(produtoId);
    if (!produto) return { tipo: "ausente" } as const;
    db.prepare(
      `UPDATE produtos
       SET status_fila = 'sending', envio_iniciado_em = CURRENT_TIMESTAMP,
           origem_envio_em_andamento = 'manual', ultimo_erro_envio = NULL
       WHERE id = ?`,
    ).run(produtoId);
    const tentativa = db
      .prepare(
        `INSERT INTO tentativas_de_envio (produto_id, origem, status)
         VALUES (?, 'manual', 'sending') RETURNING *`,
      )
      .get(produtoId) as TentativaEnvio;
    db.prepare(
      `INSERT INTO idempotencias_reenvio_manual (chave, produto_id, tentativa_id)
       VALUES (?, ?, ?)`,
    ).run(chave, produtoId, tentativa.id);
    return {
      tipo: "nova",
      reserva: { produto: buscarProdutoPorId(produtoId) as Produto, tentativa },
    } as const;
  });

  return transacao.immediate();
}

export function listarTentativasEnvio(produtoId: number): TentativaEnvio[] {
  return db
    .prepare(
      `SELECT * FROM tentativas_de_envio WHERE produto_id = ? ORDER BY id DESC`,
    )
    .all(produtoId) as TentativaEnvio[];
}

export function buscarTentativaEnvioPorId(id: number): TentativaEnvio | undefined {
  return db
    .prepare(`SELECT * FROM tentativas_de_envio WHERE id = ?`)
    .get(id) as TentativaEnvio | undefined;
}

export function gravarSnapshotTentativa(tentativaId: number, d: {
  mensagem: string; destinoId: string | null; destinoNome: string | null;
  plataforma: string; titulo: string; urlOriginal: string | null;
}) {
  db.prepare(
    `UPDATE tentativas_de_envio
     SET mensagem_snapshot = ?, destino_id = ?, destino_nome = ?, plataforma = ?, titulo = ?, url_original = ?
     WHERE id = ?`,
  ).run(d.mensagem, d.destinoId, d.destinoNome, d.plataforma, d.titulo, d.urlOriginal, tentativaId);
}

export function recuperarEnviosAbandonados(): number {
  const token = randomUUID();
  if (!adquirirLockExecucao("whatsapp_envio", token, 30_000)) return 0;
  const motivo = "Envio interrompido sem confirmação; revisão manual necessária.";
  try {
    return db.transaction(() => {
      const produtos = db
        .prepare(`SELECT * FROM produtos WHERE status_fila = 'sending'`)
        .all() as Produto[];
      for (const produto of produtos) {
        db.prepare(
          `UPDATE produtos
           SET status_fila = 'ambiguous', ultimo_erro_envio = ?,
               envio_iniciado_em = NULL, origem_envio_em_andamento = NULL
           WHERE id = ?`,
        ).run(motivo, produto.id);
        const atualizada = db
          .prepare(
            `UPDATE tentativas_de_envio
             SET status = 'ambiguous', motivo = ?, finalizado_em = CURRENT_TIMESTAMP
             WHERE id = (
               SELECT id FROM tentativas_de_envio
               WHERE produto_id = ? AND status = 'sending' ORDER BY id DESC LIMIT 1
             )`,
          )
          .run(motivo, produto.id);
        if (atualizada.changes === 0) {
          db.prepare(
            `INSERT INTO tentativas_de_envio
             (produto_id, origem, status, motivo, finalizado_em)
             VALUES (?, ?, 'ambiguous', ?, CURRENT_TIMESTAMP)`,
          ).run(produto.id, produto.origem_envio_em_andamento ?? "auto", motivo);
        }
      }
      return produtos.length;
    })();
  } finally {
    liberarLockExecucao("whatsapp_envio", token);
  }
}

export function adquirirLockExecucao(
  nome: string,
  token: string,
  duracaoMs: number,
): boolean {
  const agora = Date.now();
  const resultado = db
    .prepare(
      `INSERT INTO locks_execucao (nome, token, expira_em_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(nome) DO UPDATE SET token = excluded.token,
         expira_em_ms = excluded.expira_em_ms, adquirido_em = CURRENT_TIMESTAMP
       WHERE locks_execucao.expira_em_ms <= ?`,
    )
    .run(nome, token, agora + duracaoMs, agora);
  return resultado.changes === 1;
}

export function renovarLockExecucao(
  nome: string,
  token: string,
  duracaoMs: number,
): boolean {
  const resultado = db.prepare(
    `UPDATE locks_execucao SET expira_em_ms = ? WHERE nome = ? AND token = ?`,
  ).run(Date.now() + duracaoMs, nome, token);
  return resultado.changes === 1;
}

export function liberarLockExecucao(nome: string, token: string) {
  db.prepare(`DELETE FROM locks_execucao WHERE nome = ? AND token = ?`).run(nome, token);
}

export function enviosHoje(): number {
  const resultado = db
    .prepare(
      `
    SELECT COUNT(*) as total FROM envios WHERE ${sqlDiaBrasilia("enviado_em")} = ${SQL_HOJE_BRASILIA}
  `,
    )
    .get() as { total: number };
  return resultado.total;
}

export function podeEnviarMais(): boolean {
  const autoAtivo = getConfig("auto_envio_ativo") === "true";
  const limite = Number(getConfig("limite_diario") ?? 10);
  return autoAtivo && enviosHoje() < limite;
}

export interface IntegrationView {
  key: string;
  nome: string;
  available: boolean;
  active: boolean;
  configured: boolean;
  status: string;
  capabilities: string[];
  last_connected_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
}

export function listarIntegracoes(): IntegrationView[] {
  const rows = db
    .prepare(
      `
    SELECT c.key, c.nome, c.available, s.active, s.status,
           c.capabilities, s.last_connected_at, s.last_checked_at, s.last_error
    FROM integration_catalog c
    JOIN store_integrations s ON s.integration_key = c.key
    ORDER BY c.key
  `,
    )
    .all() as Array<
    Omit<IntegrationView, "configured" | "capabilities"> & {
      capabilities: string;
    }
  >;

  return rows.map((row) => ({
    ...row,
    configured: row.status !== "not_configured",
    available: Boolean(row.available),
    active: Boolean(row.active),
    capabilities: JSON.parse(row.capabilities) as string[],
  }));
}

export function atualizarAtivacaoIntegracao(key: string, active: boolean) {
  const result = db
    .prepare(
      `
    UPDATE store_integrations
    SET active = ?,
    previous_status = CASE WHEN ? = 0 THEN status ELSE previous_status END,
    status = CASE
      WHEN ? = 0 THEN 'disabled'
      WHEN status = 'disabled' THEN COALESCE(previous_status, 'not_configured')
      ELSE status
    END,
    atualizado_em = CURRENT_TIMESTAMP
    WHERE integration_key = ?
  `,
    )
    .run(active ? 1 : 0, active ? 1 : 0, active ? 1 : 0, key);

  if (result.changes === 0) throw new Error("integração não encontrada");
}

export function atualizarStatusIntegracao(
  key: string,
  status: string,
  detalhes: { erro?: string; conectadoEm?: string } = {},
) {
  const result = db
    .prepare(
      `
    UPDATE store_integrations
    SET status = ?,
        last_error = ?,
        last_connected_at = COALESCE(?, last_connected_at),
        last_checked_at = CURRENT_TIMESTAMP,
        atualizado_em = CURRENT_TIMESTAMP
    WHERE integration_key = ?
  `,
    )
    .run(status, detalhes.erro ?? null, detalhes.conectadoEm ?? null, key);

  if (result.changes === 0) throw new Error("integração não encontrada");
}

export function integracaoEstaAtiva(key: string): boolean {
  const row = db
    .prepare(
      `
    SELECT active FROM store_integrations WHERE integration_key = ?
  `,
    )
    .get(key) as { active: number } | undefined;
  return row?.active === 1;
}

export function obterResumoFila() {
  return db
    .prepare(
      `
    SELECT
      COALESCE(SUM(CASE WHEN status_fila = 'pending' AND enviado = 0 THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status_fila = 'sending' AND enviado = 0 THEN 1 ELSE 0 END), 0) AS sending,
      COALESCE(SUM(CASE WHEN status_fila = 'sent' OR enviado = 1 THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN status_fila = 'failed' AND enviado = 0 THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status_fila = 'ambiguous' AND enviado = 0 THEN 1 ELSE 0 END), 0) AS ambiguous
    FROM produtos
  `,
    )
    .get() as {
    pending: number;
    sending: number;
    sent: number;
    failed: number;
    ambiguous: number;
  };
}

export function buscarProdutoPorId(id: number): Produto | undefined {
  return db.prepare(`SELECT * FROM produtos WHERE id = ?`).get(id) as
    | Produto
    | undefined;
}

// ---------- SESSÃO DE AFILIADO (cookie manual) ----------

export interface SessaoAfiliado {
  provedor: string;
  cookie: string;
  csrf_token: string;
  tag: string;
  atualizado_em: string;
}

export function salvarSessaoAfiliado(
  provedor: string,
  cookie: string,
  csrfToken: string,
  tag: string,
) {
  db.prepare(
    `
    INSERT INTO sessao_afiliado (provedor, cookie, csrf_token, tag)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provedor) DO UPDATE SET
      cookie = excluded.cookie,
      csrf_token = excluded.csrf_token,
      tag = excluded.tag,
      atualizado_em = CURRENT_TIMESTAMP
  `,
  ).run(provedor, cookie, csrfToken, tag);
}

export function buscarSessaoAfiliado(
  provedor: string,
): SessaoAfiliado | undefined {
  return db
    .prepare(`SELECT * FROM sessao_afiliado WHERE provedor = ?`)
    .get(provedor) as SessaoAfiliado | undefined;
}

export function atualizarCookieSessao(provedor: string, cookie: string) {
  db.prepare(
    `
    UPDATE sessao_afiliado
    SET cookie = ?, atualizado_em = CURRENT_TIMESTAMP
    WHERE provedor = ?
  `,
  ).run(cookie, provedor);
}

export type AbaProdutos = "all" | "pending" | "sent" | "failed" | "ambiguous" | "not_sent";
export const ABAS_PRODUTOS: readonly AbaProdutos[] = ["all","pending","sent","failed","ambiguous","not_sent"];

const CONDICAO_ABA: Record<AbaProdutos, string> = {
  all: "1 = 1",
  pending: "p.enviado = 0 AND p.status_fila IN ('pending','sending')",
  sent: "(p.status_fila = 'sent' OR p.enviado = 1)",
  failed: "p.status_fila = 'failed' AND p.enviado = 0",
  ambiguous: "p.status_fila = 'ambiguous' AND p.enviado = 0",
  not_sent: "p.enviado = 0",
};

export interface ProdutoComPlataforma extends Produto { plataforma_nome: string }

function filtroBusca(q: string | undefined) {
  const termo = q?.trim();
  if (!termo) return { sql: "", params: [] as string[] };
  const escapado = termo.replace(/[\\%_]/g, (c) => `\\${c}`);
  return { sql: " AND p.nome LIKE ? ESCAPE '\\'", params: [`%${escapado}%`] };
}

export function listarProdutosPaginado(opcoes: { q?: string | undefined; aba: AbaProdutos; page: number; limit: number }) {
  const busca = filtroBusca(opcoes.q);
  const where = `${CONDICAO_ABA[opcoes.aba]}${busca.sql}`;
  const items = db.prepare(
    `SELECT p.*, COALESCE(c.nome, p.source_key) AS plataforma_nome
     FROM produtos p LEFT JOIN integration_catalog c ON c.key = p.source_key
     WHERE ${where}
     ORDER BY datetime(p.criado_em) DESC, p.id DESC
     LIMIT ? OFFSET ?`,
  ).all(...busca.params, opcoes.limit, (opcoes.page - 1) * opcoes.limit) as ProdutoComPlataforma[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM produtos p WHERE ${where}`).get(...busca.params) as { n: number }).n;
  const contagens = {} as Record<AbaProdutos, number>;
  for (const aba of ABAS_PRODUTOS) {
    contagens[aba] = (db.prepare(
      `SELECT COUNT(*) AS n FROM produtos p WHERE ${CONDICAO_ABA[aba]}${busca.sql}`,
    ).get(...busca.params) as { n: number }).n;
  }
  return { items, total, contagens };
}

export function buscarProdutoComPlataforma(id: number): ProdutoComPlataforma | undefined {
  return db.prepare(
    `SELECT p.*, COALESCE(c.nome, p.source_key) AS plataforma_nome
     FROM produtos p LEFT JOIN integration_catalog c ON c.key = p.source_key WHERE p.id = ?`,
  ).get(id) as ProdutoComPlataforma | undefined;
}

export function buscarProdutoPorExternalId(
  sourceKey: string,
  externalProductId: string,
): Produto | undefined {
  return db
    .prepare(
      `SELECT * FROM produtos WHERE source_key = ? AND external_product_id = ?`,
    )
    .get(sourceKey, externalProductId) as Produto | undefined;
}

export interface ComissaoSnapshot {
  id: number;
  produto_id: number | null;
  integracao_key: string;
  comissao_valor: number | null;
  comissao_percentual: number | null;
  estimada: number;
  coletado_em: string;
}

export interface NovoSnapshotComissao {
  produto_id?: number | null | undefined;
  integracao_key: string;
  comissao_valor?: number | null | undefined;
  comissao_percentual?: number | null | undefined;
  estimada?: number | undefined;
}

export function gravarSnapshotComissao(
  dados: NovoSnapshotComissao,
): ComissaoSnapshot | null {
  // Mercado Livre não possui fonte confirmada de comissão
  if (dados.integracao_key === "mercado_livre") {
    return null;
  }

  const valor =
    dados.comissao_valor !== undefined &&
    dados.comissao_valor !== null &&
    !Number.isNaN(dados.comissao_valor)
      ? Number(dados.comissao_valor)
      : null;

  const percentual =
    dados.comissao_percentual !== undefined &&
    dados.comissao_percentual !== null &&
    !Number.isNaN(dados.comissao_percentual)
      ? Number(dados.comissao_percentual)
      : null;

  // Não gravar snapshot vazio
  if (valor === null && percentual === null) {
    return null;
  }

  const estimada = 1; // Sempre estimativa

  const snapshot = db
    .prepare(
      `INSERT INTO comissao_snapshots (produto_id, integracao_key, comissao_valor, comissao_percentual, estimada)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      dados.produto_id ?? null,
      dados.integracao_key,
      valor,
      percentual,
      estimada,
    ) as ComissaoSnapshot;

  gravarAtividade({
    tipo: "comissao_snapshot",
    integracao_key: dados.integracao_key,
    produto_id: dados.produto_id ?? null,
    titulo: "Snapshot de comissão registrado",
    detalhe: `Valor: ${valor !== null ? valor : "n/a"}, Taxa: ${percentual !== null ? percentual : "n/a"}`,
  });

  return snapshot;
}

export function listarSnapshotsComissao(produtoId: number): ComissaoSnapshot[] {
  return db
    .prepare(
      `SELECT * FROM comissao_snapshots WHERE produto_id = ? ORDER BY id DESC`,
    )
    .all(produtoId) as ComissaoSnapshot[];
}

export function obterUltimaComissao(produtoId: number): ComissaoSnapshot | null {
  const row = db
    .prepare(
      `SELECT * FROM comissao_snapshots WHERE produto_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(produtoId) as ComissaoSnapshot | undefined;
  return row ?? null;
}

export interface ResumoComissaoDia {
  valor: number | null;
  disponivel: boolean;
  estimada: true;
}

export function consultarComissaoDoDia(
  integracaoKey: string = "shopee",
): ResumoComissaoDia {
  const row = db
    .prepare(
      `SELECT SUM(comissao_valor) as total_valor, COUNT(*) as qtd
       FROM comissao_snapshots
       WHERE integracao_key = ?
         AND ${sqlDiaBrasilia("coletado_em")} = ${SQL_HOJE_BRASILIA}
         AND comissao_valor IS NOT NULL`,
    )
    .get(integracaoKey) as { total_valor: number | null; qtd: number } | undefined;

  if (!row || row.qtd === 0 || row.total_valor === null) {
    return {
      valor: null,
      disponivel: false,
      estimada: true,
    };
  }

  return {
    valor: Number(row.total_valor.toFixed(2)),
    disponivel: true,
    estimada: true,
  };
}

export interface Atividade {
  id: number;
  tipo: string;
  integracao_key: string | null;
  produto_id: number | null;
  tentativa_id: number | null;
  titulo: string;
  detalhe: string | null;
  criado_em: string;
}

export function sanitizarTextoAtividade(
  texto: string | null | undefined,
): string | null {
  if (!texto) return null;
  let limpo = texto;
  limpo = limpo.replace(/cookie[^\s,;]*/gi, "[redigido]");
  limpo = limpo.replace(/csrf[^\s,;]*/gi, "[redigido]");
  limpo = limpo.replace(/token[^\s,;]*/gi, "[redigido]");
  limpo = limpo.replace(/secret[^\s,;]*/gi, "[redigido]");
  return limpo.slice(0, 500);
}

export function gravarAtividade(dados: {
  tipo: string;
  integracao_key?: string | null | undefined;
  produto_id?: number | null | undefined;
  tentativa_id?: number | null | undefined;
  titulo: string;
  detalhe?: string | null | undefined;
}): Atividade {
  const tituloLimpo = sanitizarTextoAtividade(dados.titulo) ?? dados.tipo;
  const detalheLimpo = sanitizarTextoAtividade(dados.detalhe);

  const row = db
    .prepare(
      `INSERT INTO atividades (tipo, integracao_key, produto_id, tentativa_id, titulo, detalhe)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      dados.tipo,
      dados.integracao_key ?? null,
      dados.produto_id ?? null,
      dados.tentativa_id ?? null,
      tituloLimpo,
      detalheLimpo,
    ) as Atividade;

  return row;
}

export interface FiltroAtividades {
  page?: number | undefined;
  limit?: number | undefined;
  tipo?: string | undefined;
  integracao_key?: string | undefined;
  plataforma?: string | undefined;
}

export function listarAtividades(filtro: FiltroAtividades = {}): {
  items: Atividade[];
  total: number;
} {
  const page = Math.max(1, filtro.page ?? 1);
  const limit = Math.max(1, Math.min(100, filtro.limit ?? 20));
  const offset = (page - 1) * limit;

  const condicoes: string[] = [];
  const params: unknown[] = [];

  if (filtro.tipo) {
    condicoes.push("tipo = ?");
    params.push(filtro.tipo);
  }

  const integracao = filtro.plataforma || filtro.integracao_key;
  if (integracao) {
    condicoes.push("integracao_key = ?");
    params.push(integracao);
  }

  const whereClause =
    condicoes.length > 0 ? `WHERE ${condicoes.join(" AND ")}` : "";

  const total = (
    db
      .prepare(`SELECT COUNT(*) as n FROM atividades ${whereClause}`)
      .get(...params) as { n: number }
  ).n;

  const items = db
    .prepare(
      `SELECT * FROM atividades ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Atividade[];

  return { items, total };
}

