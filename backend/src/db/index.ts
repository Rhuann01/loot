import Database from "better-sqlite3";

const db: Database.Database = new Database("loot.db");

db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS integration_catalog (
    key TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    available INTEGER NOT NULL DEFAULT 1,
    capabilities TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS store_integrations (
    integration_key TEXT PRIMARY KEY,
    active INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'not_configured',
    previous_status TEXT,
    last_connected_at TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (integration_key) REFERENCES integration_catalog(key)
  );

  CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id_ml TEXT,
  source_key TEXT NOT NULL DEFAULT 'mercado_livre',
  external_product_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  preco_atual TEXT NOT NULL,
  preco_original TEXT,
  desconto_percentual INTEGER DEFAULT 0,
  comissao_valor REAL DEFAULT 0,
  comissao_percentual REAL DEFAULT 0,
  imagem_url TEXT,
  link_original TEXT,
  link_afiliado TEXT NOT NULL,
  categoria_id TEXT,
  marketplace_origem TEXT DEFAULT 'mercado_livre',
  selecionado INTEGER DEFAULT 0,
  enviado INTEGER DEFAULT 0,
  status_fila TEXT NOT NULL DEFAULT 'pending',
  tentativas_envio INTEGER NOT NULL DEFAULT 0,
  ultimo_erro_envio TEXT,
  envio_iniciado_em TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);

  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categorias_monitoradas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria_id TEXT NOT NULL UNIQUE,
    categoria_nome TEXT NOT NULL,
    ativa INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS envios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL,
    enviado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (produto_id) REFERENCES produtos(id)
  );

  CREATE TABLE IF NOT EXISTS sessao_afiliado (
    provedor TEXT PRIMARY KEY,
    cookie TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    tag TEXT NOT NULL,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const colunasIntegracoes = db
  .prepare(`PRAGMA table_info(store_integrations)`)
  .all() as Array<{ name: string }>;
if (!colunasIntegracoes.some((coluna) => coluna.name === "previous_status")) {
  db.exec(`ALTER TABLE store_integrations ADD COLUMN previous_status TEXT`);
}

const colunasProdutosIniciais = db
  .prepare(`PRAGMA table_info(produtos)`)
  .all() as Array<{ name: string }>;
const nomesColunasProdutosIniciais = new Set(
  colunasProdutosIniciais.map((coluna) => coluna.name),
);

for (const [nome, definicao] of [
  ["source_key", "TEXT NOT NULL DEFAULT 'mercado_livre'"],
  ["marketplace_origem", "TEXT DEFAULT 'mercado_livre'"],
  ["comissao_valor", "REAL DEFAULT 0"],
  ["comissao_percentual", "REAL DEFAULT 0"],
  ["external_product_id", "TEXT"],
  ["link_original", "TEXT"],
] as const) {
  if (!nomesColunasProdutosIniciais.has(nome)) {
    db.exec(`ALTER TABLE produtos ADD COLUMN ${nome} ${definicao}`);
  }
}

db.exec(`
  UPDATE produtos
  SET source_key = COALESCE(NULLIF(marketplace_origem, ''), 'mercado_livre'),
      external_product_id = COALESCE(external_product_id, produto_id_ml)
  WHERE external_product_id IS NULL OR source_key IS NULL OR source_key = ''
`);

const indicesProdutos = db
  .prepare(`PRAGMA index_list('produtos')`)
  .all() as Array<{ name: string; unique: number }>;
const possuiUnicidadeLegada = indicesProdutos.some(
  (indice) => indice.unique === 1 && indice.name.startsWith("sqlite_autoindex"),
);

// Bancos criados pela versão antiga tinham UNIQUE(produto_id_ml). Essa
// restrição precisa ser removida para permitir o mesmo ID externo em lojas
// diferentes; a nova unicidade é (source_key, external_product_id).
if (possuiUnicidadeLegada) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE produtos_novo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id_ml TEXT,
      source_key TEXT NOT NULL DEFAULT 'mercado_livre',
      external_product_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      preco_atual TEXT NOT NULL,
      preco_original TEXT,
      desconto_percentual INTEGER DEFAULT 0,
      comissao_valor REAL DEFAULT 0,
      comissao_percentual REAL DEFAULT 0,
      imagem_url TEXT,
      link_original TEXT,
      link_afiliado TEXT NOT NULL,
      categoria_id TEXT,
      marketplace_origem TEXT DEFAULT 'mercado_livre',
      selecionado INTEGER DEFAULT 0,
      enviado INTEGER DEFAULT 0,
      status_fila TEXT NOT NULL DEFAULT 'pending',
      tentativas_envio INTEGER NOT NULL DEFAULT 0,
      ultimo_erro_envio TEXT,
      envio_iniciado_em TEXT,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO produtos_novo (
      id, produto_id_ml, source_key, external_product_id, nome, preco_atual,
      preco_original, desconto_percentual, comissao_valor,
      comissao_percentual, imagem_url, link_original, link_afiliado, categoria_id,
      marketplace_origem, selecionado, enviado, status_fila,
      tentativas_envio, ultimo_erro_envio, envio_iniciado_em, criado_em
    )
    SELECT id, produto_id_ml, source_key, external_product_id, nome, preco_atual,
      preco_original, desconto_percentual, comissao_valor,
      comissao_percentual, imagem_url, link_original, link_afiliado, categoria_id,
      marketplace_origem, selecionado, enviado, status_fila,
      tentativas_envio, ultimo_erro_envio, envio_iniciado_em, criado_em
    FROM produtos;

    DROP TABLE produtos;
    ALTER TABLE produtos_novo RENAME TO produtos;
    PRAGMA foreign_keys = ON;
  `);
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS uq_produtos_source_external
  ON produtos (source_key, external_product_id)
`);

const integrations = [
  ["mercado_livre", "Mercado Livre", 1, '["products","affiliate_links"]'],
  ["shopee", "Shopee", 0, '["products","affiliate_links"]'],
  ["tiktok_shop", "TikTok Shop", 0, '["products","affiliate_links"]'],
] as const;

const inserirIntegracao = db.prepare(`
  INSERT OR IGNORE INTO integration_catalog (key, nome, available, capabilities)
  VALUES (?, ?, ?, ?)
`);

for (const integracao of integrations) inserirIntegracao.run(...integracao);

db.exec(`
  UPDATE integration_catalog SET available = 1 WHERE key = 'mercado_livre';
  UPDATE integration_catalog SET available = 0 WHERE key IN ('shopee', 'tiktok_shop');
`);

db.exec(`
  INSERT OR IGNORE INTO store_integrations (integration_key, active, status)
  VALUES ('mercado_livre', 1, 'not_configured');
  INSERT OR IGNORE INTO store_integrations (integration_key, active, status)
  VALUES ('shopee', 0, 'not_configured');
  INSERT OR IGNORE INTO store_integrations (integration_key, active, status)
  VALUES ('tiktok_shop', 0, 'not_configured');
`);

const colunasProdutos = db
  .prepare(`PRAGMA table_info(produtos)`)
  .all() as Array<{ name: string }>;
const nomesColunasProdutos = new Set(colunasProdutos.map((coluna) => coluna.name));

const colunasNovas = [
  ["status_fila", "TEXT NOT NULL DEFAULT 'pending'"],
  ["tentativas_envio", "INTEGER NOT NULL DEFAULT 0"],
  ["ultimo_erro_envio", "TEXT"],
  ["envio_iniciado_em", "TEXT"],
] as const;

for (const [nome, definicao] of colunasNovas) {
  if (!nomesColunasProdutos.has(nome)) {
    db.exec(`ALTER TABLE produtos ADD COLUMN ${nome} ${definicao}`);
  }
}

db.exec(`
  UPDATE produtos
  SET status_fila = 'sent'
  WHERE enviado = 1 AND status_fila = 'pending'
`);

const defaults: Record<string, string> = {
  auto_envio_ativo: "true",
  limite_diario: "12",
  desconto_minimo_global: "20",
  horarios_envio: JSON.stringify(["05:00", "12:00", "15:00", "20:00"]),
  quantidade_por_execucao: "3",
  janela_fallback_dias: "3",
  scraper_ultima_tentativa: "",
  scraper_ultima_sucesso: "",
  scraper_ultimo_resultado: "",
  scraper_ultimo_erro: "",
  whatsapp_grupo_id: process.env.WHATSAPP_GROUP_ID ?? "",
};

const inserirDefault = db.prepare(`
  INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)
`);

for (const [chave, valor] of Object.entries(defaults)) {
  inserirDefault.run(chave, valor);
}

console.log(
  "banco de dados pronto: tabelas criadas, configs padrão aplicadas",
);

export default db;
