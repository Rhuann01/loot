import db from "./index.js";

export interface Produto {
  id: number;
  produto_id_ml: string;
  nome: string;
  preco_atual: string;
  preco_original: string | null;
  desconto_percentual: number;
  imagem_url: string | null;
  link_afiliado: string;
  categoria_id: string | null;
  selecionado: number;
  enviado: number;
  criado_em: string;
}
interface NovoProduto {
  produto_id_ml: string;
  nome: string;
  preco_atual: string;
  preco_original?: string;
  desconto_percentual?: number;
  imagem_url?: string;
  link_afiliado: string;
  categoria_id?: string;
}

export function salvarProduto(produto: NovoProduto) {
  const dados = {
    produto_id_ml: produto.produto_id_ml,
    nome: produto.nome,
    preco_atual: produto.preco_atual,
    preco_original: produto.preco_original ?? null,
    desconto_percentual: produto.desconto_percentual ?? 0,
    imagem_url: produto.imagem_url ?? null,
    link_afiliado: produto.link_afiliado,
    categoria_id: produto.categoria_id ?? null,
  };

  const inserir = db.prepare(`
    INSERT INTO produtos 
      (produto_id_ml, nome, preco_atual, preco_original, desconto_percentual, imagem_url, link_afiliado, categoria_id)
    VALUES 
      (@produto_id_ml, @nome, @preco_atual, @preco_original, @desconto_percentual, @imagem_url, @link_afiliado, @categoria_id)
    ON CONFLICT(produto_id_ml) DO UPDATE SET
      preco_atual = excluded.preco_atual,
      preco_original = excluded.preco_original,
      desconto_percentual = excluded.desconto_percentual,
      imagem_url = excluded.imagem_url,
      enviado = 0,
      criado_em = CURRENT_TIMESTAMP
  `);
  inserir.run(dados);
}

export function listarProdutos(): Produto[] {
  return db
    .prepare(`SELECT * FROM produtos ORDER BY criado_em DESC`)
    .all() as Produto[];
}

export function getMelhoresDescontos(limite: number): Produto[] {
  return db
    .prepare(
      `
    SELECT * FROM produtos 
    WHERE enviado = 0 
      AND date(criado_em) = date('now')
    ORDER BY desconto_percentual DESC 
    LIMIT ?
  `,
    )
    .all(limite) as Produto[];
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
