import db from "./index.js";
import { randomUUID } from "node:crypto";

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

export type OrigemEnvio = "manual" | "automatico";

export interface TentativaEnvio {
  id: number;
  produto_id: number;
  origem: OrigemEnvio;
  status: "sending" | "sent" | "failed" | "ambiguous" | "cancelled";
  motivo: string | null;
  iniciado_em: string;
  finalizado_em: string | null;
}
interface NovoProduto {
  source_key?: string;
  external_product_id: string;
  nome: string;
  preco_atual: string;
  preco_original?: string;
  desconto_percentual?: number;
  imagem_url?: string;
  link_original?: string;
  link_afiliado: string;
  categoria_id?: string;
  oferta_expira_em?: number;
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
  const { descontoMinimo, janelaDias } = obterCriteriosDaFila();

  return db
    .prepare(
      `
    SELECT * FROM produtos 
    WHERE enviado = 0
      AND status_fila IN ('pending', 'failed')
      AND tentativas_envio < 3
      AND desconto_percentual >= ?
      AND datetime(criado_em) >= datetime('now', ?)
      AND (oferta_expira_em IS NULL OR oferta_expira_em > CAST(strftime('%s','now') AS INTEGER))
    ORDER BY selecionado DESC, desconto_percentual DESC, datetime(criado_em) DESC, id DESC
    LIMIT ?
  `,
    )
    .all(descontoMinimo, `-${janelaDias} days`, limite) as Produto[];
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

  return { descontoMinimo, janelaDias };
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
  });
  transacao();
}

export interface ReservaEnvio {
  produto: Produto;
  tentativa: TentativaEnvio;
}

export function reservarProdutoParaEnvioComTentativa(): ReservaEnvio | undefined {
  const { descontoMinimo, janelaDias } = obterCriteriosDaFila();
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
          AND datetime(c.criado_em) >= datetime('now', ?)
          AND (c.oferta_expira_em IS NULL OR c.oferta_expira_em > CAST(strftime('%s','now') AS INTEGER))
        ORDER BY c.selecionado DESC,
          (
            (SELECT COUNT(*) FROM envios e
               JOIN produtos pe ON pe.id = e.produto_id
              WHERE date(e.enviado_em) = date('now')
                AND pe.source_key = c.source_key)
            +
            (SELECT COUNT(*) FROM produtos ps
              WHERE ps.enviado = 0
                AND ps.status_fila = 'sending'
                AND date(ps.envio_iniciado_em) = date('now')
                AND ps.source_key = c.source_key)
          ) ASC,
          c.desconto_percentual DESC, datetime(c.criado_em) DESC, c.id DESC
        LIMIT 1
      )
      AND (
        (SELECT COUNT(*) FROM envios WHERE date(enviado_em) = date('now')) +
        (SELECT COUNT(*) FROM produtos
         WHERE enviado = 0
           AND status_fila = 'sending'
           AND date(envio_iniciado_em) = date('now'))
      ) < ?
      RETURNING *
    `,
      )
      .get(descontoMinimo, `-${janelaDias} days`, limiteDiario) as
      | Produto
      | undefined;
    if (!produto) return undefined;

    db.prepare(
      `UPDATE produtos SET origem_envio_em_andamento = 'automatico' WHERE id = ?`,
    ).run(produto.id);
    const tentativa = db
      .prepare(
        `INSERT INTO tentativas_de_envio (produto_id, origem, status)
         VALUES (?, 'automatico', 'sending') RETURNING *`,
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
}

export function atualizarPrecoProduto(
  produtoId: number,
  precos: {
    preco_atual: string;
    preco_original: string;
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
          ).run(produto.id, produto.origem_envio_em_andamento ?? "automatico", motivo);
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
    SELECT COUNT(*) as total FROM envios WHERE date(enviado_em) = date('now')
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
