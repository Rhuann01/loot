import db from "./index.js";

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
  status_fila: "pending" | "sending" | "sent" | "failed";
  tentativas_envio: number;
  ultimo_erro_envio: string | null;
  envio_iniciado_em: string | null;
  criado_em: string;
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
}

export function salvarProduto(produto: NovoProduto) {
  const dados = {
    produto_id_ml: produto.source_key === "mercado_livre" ? produto.external_product_id : null,
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
  };

  const inserir = db.prepare(`
    INSERT INTO produtos 
      (produto_id_ml, source_key, external_product_id, marketplace_origem, nome, preco_atual, preco_original, desconto_percentual, imagem_url, link_original, link_afiliado, categoria_id)
    VALUES 
      (@produto_id_ml, @source_key, @external_product_id, @marketplace_origem, @nome, @preco_atual, @preco_original, @desconto_percentual, @imagem_url, @link_original, @link_afiliado, @categoria_id)
    ON CONFLICT(source_key, external_product_id) DO UPDATE SET
      produto_id_ml = excluded.produto_id_ml,
      marketplace_origem = excluded.marketplace_origem,
      preco_atual = excluded.preco_atual,
      preco_original = excluded.preco_original,
      desconto_percentual = excluded.desconto_percentual,
      imagem_url = excluded.imagem_url,
      link_original = COALESCE(excluded.link_original, produtos.link_original),
      criado_em = CURRENT_TIMESTAMP
  `);
  inserir.run(dados);
}

export function buscarProdutoPorCodigoML(produtoIdMl: string): Produto | undefined {
  return db
    .prepare(`SELECT * FROM produtos WHERE source_key = 'mercado_livre' AND external_product_id = ?`)
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

export function atualizarLinkAfiliado(produtoIdMl: string, linkAfiliado: string) {
  db.prepare(
    `UPDATE produtos
     SET link_afiliado = ?
     WHERE source_key = 'mercado_livre' AND external_product_id = ?`,
  ).run(linkAfiliado, produtoIdMl);
}

export function listarProdutos(): Produto[] {
  return db
    .prepare(`SELECT * FROM produtos ORDER BY criado_em DESC`)
    .all() as Produto[];
}

export function getMelhoresDescontos(limite: number): Produto[] {
  const janelaDias = Math.max(
    1,
    Number(getConfig("janela_fallback_dias") ?? 3) || 3,
  );

  return db
    .prepare(
      `
    SELECT * FROM produtos 
    WHERE enviado = 0
      AND status_fila IN ('pending', 'failed')
      AND tentativas_envio < 3
      AND datetime(criado_em) >= datetime('now', ?)
    ORDER BY desconto_percentual DESC 
    LIMIT ?
  `,
    )
    .all(`-${janelaDias} days`, limite) as Produto[];
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

export function marcarComoEnviado(produtoId: number) {
  const transacao = db.transaction(() => {
    db.prepare(`
      UPDATE produtos
      SET enviado = 1,
          status_fila = 'sent',
          envio_iniciado_em = NULL,
          ultimo_erro_envio = NULL
      WHERE id = ?
    `).run(produtoId);
    db.prepare(`INSERT INTO envios (produto_id) VALUES (?)`).run(produtoId);
  });
  transacao();
}

export function reservarProdutoParaEnvio(): Produto | undefined {
  return db.transaction(() => {
    const produto = db
      .prepare(`
        SELECT * FROM produtos
        WHERE enviado = 0
          AND status_fila IN ('pending', 'failed')
          AND tentativas_envio < 3
        ORDER BY desconto_percentual DESC
        LIMIT 1
      `)
      .get() as Produto | undefined;

    if (!produto) return undefined;

    db.prepare(`
      UPDATE produtos
      SET status_fila = 'sending',
          tentativas_envio = tentativas_envio + 1,
          envio_iniciado_em = CURRENT_TIMESTAMP,
          ultimo_erro_envio = NULL
      WHERE id = ? AND enviado = 0
    `).run(produto.id);

    return db
      .prepare(`SELECT * FROM produtos WHERE id = ?`)
      .get(produto.id) as Produto;
  })();
}

export function marcarFalhaEnvio(produtoId: number, erro: string) {
  db.prepare(`
    UPDATE produtos
    SET status_fila = 'failed',
        ultimo_erro_envio = ?,
        envio_iniciado_em = NULL
    WHERE id = ? AND enviado = 0
  `).run(erro.slice(0, 500), produtoId);
}

export function marcarEnvioAmbiguo(produtoId: number, erro: string) {
  db.prepare(`
    UPDATE produtos
    SET status_fila = 'sending',
        ultimo_erro_envio = ?
    WHERE id = ? AND enviado = 0
  `).run(erro.slice(0, 500), produtoId);
}

export function liberarReservaEnvio(produtoId: number) {
  db.prepare(`
    UPDATE produtos
    SET status_fila = 'pending', envio_iniciado_em = NULL
    WHERE id = ? AND enviado = 0 AND status_fila = 'sending'
  `).run(produtoId);
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
  const rows = db.prepare(`
    SELECT c.key, c.nome, c.available, s.active, s.status,
           c.capabilities, s.last_connected_at, s.last_checked_at, s.last_error
    FROM integration_catalog c
    JOIN store_integrations s ON s.integration_key = c.key
    ORDER BY c.key
  `).all() as Array<Omit<IntegrationView, "configured" | "capabilities"> & { capabilities: string }>;

  return rows.map((row) => ({
    ...row,
    configured: row.status !== "not_configured",
    available: Boolean(row.available),
    active: Boolean(row.active),
    capabilities: JSON.parse(row.capabilities) as string[],
  }));
}

export function atualizarAtivacaoIntegracao(key: string, active: boolean) {
  const result = db.prepare(`
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
  `).run(active ? 1 : 0, active ? 1 : 0, active ? 1 : 0, key);

  if (result.changes === 0) throw new Error("integração não encontrada");
}

export function atualizarStatusIntegracao(
  key: string,
  status: string,
  detalhes: { erro?: string; conectadoEm?: string } = {},
) {
  const result = db.prepare(`
    UPDATE store_integrations
    SET status = ?,
        last_error = ?,
        last_connected_at = COALESCE(?, last_connected_at),
        last_checked_at = CURRENT_TIMESTAMP,
        atualizado_em = CURRENT_TIMESTAMP
    WHERE integration_key = ?
  `).run(
    status,
    detalhes.erro ?? null,
    detalhes.conectadoEm ?? null,
    key,
  );

  if (result.changes === 0) throw new Error("integração não encontrada");
}

export function integracaoEstaAtiva(key: string): boolean {
  const row = db.prepare(`
    SELECT active FROM store_integrations WHERE integration_key = ?
  `).get(key) as { active: number } | undefined;
  return row?.active === 1;
}

export function obterResumoFila() {
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status_fila = 'pending' AND enviado = 0 THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status_fila = 'sending' AND enviado = 0 THEN 1 ELSE 0 END), 0) AS sending,
      COALESCE(SUM(CASE WHEN status_fila = 'sent' OR enviado = 1 THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN status_fila = 'failed' AND enviado = 0 THEN 1 ELSE 0 END), 0) AS failed
    FROM produtos
  `).get() as { pending: number; sending: number; sent: number; failed: number };
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
