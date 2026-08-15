import db from "./index.js";

interface NovoProduto {
  produto_id_ml: string;
  name: string;
  preco_atual: string;
  link_afiliado: string;
}

export function salvarProduto(produto: NovoProduto) {
  const inserir = db.prepare(`
        INSERT OR IGNORE INTO produtos (produtos_id_ml, nome, preco_atual, link_afiliado) 
        VALUES (@produtos_id_ml, @nome, @preco_atual, @link_afiliado)
        `);

  inserir.run(produto);
}

export function listarProdutos() {
  return db.prepare(`SELECT * FROM produtos ORDER BY criado_em DESC`).all();
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
    db.prepare(`UPDATE produtos SET enviado = 1 WHERE id = ?`).run(produtoId);
    db.prepare(`INSERT INTO envios (produto_id) VALUES (?)`).run(produtoId);
  });
  transacao();
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
