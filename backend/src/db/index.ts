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
    ultima_sincronizacao TEXT,
    ultimo_erro TEXT,
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

  CREATE TABLE IF NOT EXISTS tentativas_de_envio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER,
    origem TEXT NOT NULL,
    status TEXT NOT NULL,
    motivo TEXT,
    iniciado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    finalizado_em TEXT,
    FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS idempotencias_reenvio_manual (
    chave TEXT PRIMARY KEY,
    produto_id INTEGER,
    tentativa_id INTEGER NOT NULL UNIQUE,
    payload_hash TEXT,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE SET NULL,
    FOREIGN KEY (tentativa_id) REFERENCES tentativas_de_envio(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS locks_execucao (
    nome TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    expira_em_ms INTEGER NOT NULL,
    adquirido_em TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessao_afiliado (
    provedor TEXT PRIMARY KEY,
    cookie TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    tag TEXT NOT NULL,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token TEXT PRIMARY KEY,
    usuario TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    expira_em TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessoes_token ON sessoes(token);
  CREATE INDEX IF NOT EXISTS idx_sessoes_expira_em ON sessoes(expira_em);
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
  UPDATE integration_catalog SET available = 1 WHERE key IN ('mercado_livre', 'shopee');
  UPDATE integration_catalog SET available = 0 WHERE key = 'tiktok_shop';
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
  ["origem_envio_em_andamento", "TEXT"],
  ["oferta_expira_em", "INTEGER"],
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
  janela_shopee_horas: "12",
  intervalo_entre_mensagens_ms: "3000",
  whatsapp_ultima_mensagem_em_ms: "0",
  scraper_ultima_tentativa: "",
  scraper_ultima_sucesso: "",
  scraper_ultimo_resultado: "",
  scraper_ultimo_erro: "",
  whatsapp_grupo_id: process.env.WHATSAPP_GROUP_ID ?? "",
  whatsapp_grupo_nome: "",
  retencao_dias: "90",
};

const inserirDefault = db.prepare(`
  INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)
`);

for (const [chave, valor] of Object.entries(defaults)) {
  inserirDefault.run(chave, valor);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    versao INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    aplicada_em TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

export function aplicarMigracao(versao: number, nome: string, aplicar: () => void): boolean {
  const ja = db.prepare("SELECT 1 FROM schema_migrations WHERE versao = ?").get(versao);
  if (ja) return false;
  db.transaction(() => {
    aplicar();
    db.prepare("INSERT INTO schema_migrations (versao, nome) VALUES (?, ?)").run(versao, nome);
  })();
  return true;
}

// Migração 1: o schema ad hoc acima passa a ser a linha de base versionada.
aplicarMigracao(1, "baseline", () => {});

aplicarMigracao(2, "tentativas_snapshot", () => {
  for (const coluna of ["mensagem_snapshot","destino_id","destino_nome","erro_codigo","erro_mensagem","plataforma","titulo","url_original"]) {
    const existentes = db.prepare("PRAGMA table_info(tentativas_de_envio)").all() as Array<{ name: string }>;
    if (!existentes.some((c) => c.name === coluna)) {
      db.exec(`ALTER TABLE tentativas_de_envio ADD COLUMN ${coluna} TEXT`);
    }
  }
  db.exec("UPDATE tentativas_de_envio SET origem = 'auto' WHERE origem = 'automatico'");
  db.exec("UPDATE produtos SET origem_envio_em_andamento = 'auto' WHERE origem_envio_em_andamento = 'automatico'");
  // Dado inventado: a Shopee nunca informou preço original.
  db.exec("UPDATE produtos SET preco_original = NULL WHERE source_key = 'shopee'");
});

aplicarMigracao(3, "historico_comissao_atividades", () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comissao_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER,
      integracao_key TEXT NOT NULL,
      comissao_valor REAL,
      comissao_percentual REAL,
      estimada INTEGER NOT NULL DEFAULT 1,
      coletado_em TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS atividades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      integracao_key TEXT,
      produto_id INTEGER,
      tentativa_id INTEGER,
      titulo TEXT NOT NULL,
      detalhe TEXT,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE SET NULL,
      FOREIGN KEY (tentativa_id) REFERENCES tentativas_de_envio(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_comissao_snapshots_coletado_em
      ON comissao_snapshots(coletado_em);
    CREATE INDEX IF NOT EXISTS idx_comissao_snapshots_integracao
      ON comissao_snapshots(integracao_key);
    CREATE INDEX IF NOT EXISTS idx_atividades_criado_em
      ON atividades(criado_em);
    CREATE INDEX IF NOT EXISTS idx_atividades_integracao
      ON atividades(integracao_key);
  `);
});

aplicarMigracao(4, "plataformas_sincronizacao", () => {
  const colunas = db
    .prepare("PRAGMA table_info(store_integrations)")
    .all() as Array<{ name: string }>;
  const nomes = new Set(colunas.map((c) => c.name));
  if (!nomes.has("ultima_sincronizacao")) {
    db.exec("ALTER TABLE store_integrations ADD COLUMN ultima_sincronizacao TEXT");
  }
  if (!nomes.has("ultimo_erro")) {
    db.exec("ALTER TABLE store_integrations ADD COLUMN ultimo_erro TEXT");
  }
});

aplicarMigracao(5, "idempotencias_manual_hash", () => {
  const colunas = db
    .prepare("PRAGMA table_info(idempotencias_reenvio_manual)")
    .all() as Array<{ name: string }>;
  const nomes = new Set(colunas.map((c) => c.name));
  if (!nomes.has("payload_hash")) {
    db.exec("ALTER TABLE idempotencias_reenvio_manual ADD COLUMN payload_hash TEXT");
  }
});

console.log(
  "banco de dados pronto: tabelas criadas, configs padrão aplicadas",
);

export default db;
