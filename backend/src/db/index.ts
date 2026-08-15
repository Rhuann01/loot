import Database from "better-sqlite3";

const db: Database.Database = new Database("loot.db");

db.pragma("foreign_kays=ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id_ml TEXT NOT NULL UNIQUE,
    nome TEXT NOT NULL,
    preco_atual TEXT NOT NULL,
    preco_original TEXT,
    desconto_percentual INTEGER DEFAULT 0,
    imagem_url TEXT,
    link_afiliado TEXT NOT NULL,
    categoria_id TEXT,
    selecionado INTEGER DEFAULT 0,
    enviado INTEGER DEFAULT 0,
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
`);

const defaults: Record<string, string> = {
  auto_envio_ativo: "true",
  limite_diario: "10",
  desconto_minimo_global: "20",
};

const inserirDefault = db.prepare(`
  INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)
`);

for (const [chave, valor] of Object.entries(defaults)) {
  inserirDefault.run(chave, valor);
}

console.log(
  "banco de dados pronto: 4 tabelas criadas, configs padrão aplicadas",
);

export default db;
