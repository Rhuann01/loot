import assert from "node:assert/strict";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";

const api = await iniciarApiDeTeste();
const { db } = api;

try {
  const {
    aplicarMigracao,
  } = await import("../src/db/index.js");

  const {
    salvarProduto,
    buscarProdutoPorExternalId,
    gravarSnapshotComissao,
    listarSnapshotsComissao,
    obterUltimaComissao,
    consultarComissaoDoDia,
    gravarAtividade,
    listarAtividades,
  } = await import("../src/db/queries.js");

  // 1. Migração versão 3 idempotente
  const mig3 = db
    .prepare("SELECT * FROM schema_migrations WHERE versao = 3")
    .get() as { versao: number; nome: string } | undefined;
  assert.ok(mig3, "Migração 3 deve ter sido aplicada");
  assert.equal(mig3.versao, 3);
  assert.equal(mig3.nome, "historico_comissao_atividades");

  // Chamar novamente deve ser idempotente (devolve false e não lança erro)
  const reaplicada = aplicarMigracao(3, "historico_comissao_atividades", () => {
    throw new Error("Não deveria rodar novamente");
  });
  assert.equal(reaplicada, false, "Migração 3 deve ser idempotente");

  const tabelas = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('comissao_snapshots', 'atividades')",
      )
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
  assert.ok(tabelas.includes("comissao_snapshots"), "Tabela comissao_snapshots deve existir");
  assert.ok(tabelas.includes("atividades"), "Tabela atividades deve existir");

  // 2. Snapshot Shopee com valor/taxa confirmado e estimada = 1
  salvarProduto({
    source_key: "shopee",
    external_product_id: "123_456",
    nome: "Produto Shopee Teste",
    preco_atual: "31,99",
    desconto_percentual: 45,
    link_afiliado: "https://shopee.com.br/product/123/456",
  });
  const pShopee = buscarProdutoPorExternalId("shopee", "123_456");
  assert.ok(pShopee, "Produto Shopee deve ter sido salvo");

  const snap1 = gravarSnapshotComissao({
    produto_id: pShopee.id,
    integracao_key: "shopee",
    comissao_valor: 12.34,
    comissao_percentual: 0.08,
  });
  assert.ok(snap1, "Snapshot deve ter sido criado");
  assert.equal(snap1.estimada, 1);
  assert.equal(snap1.comissao_valor, 12.34);
  assert.equal(snap1.comissao_percentual, 0.08);
  assert.equal(snap1.integracao_key, "shopee");
  assert.equal(snap1.produto_id, pShopee.id);

  // 3. Ausência de comissão não cria snapshot e não vira zero
  salvarProduto({
    source_key: "shopee",
    external_product_id: "123_789",
    nome: "Produto Shopee Sem Comissão",
    preco_atual: "20,00",
    desconto_percentual: 10,
    link_afiliado: "https://shopee.com.br/product/123/789",
  });
  const pSemComissao = buscarProdutoPorExternalId("shopee", "123_789");
  assert.ok(pSemComissao);

  const snapVazio = gravarSnapshotComissao({
    produto_id: pSemComissao.id,
    integracao_key: "shopee",
    comissao_valor: null,
    comissao_percentual: null,
  });
  assert.equal(snapVazio, null, "Snapshot com valores nulos não deve ser criado");

  const listaVazia = listarSnapshotsComissao(pSemComissao.id);
  assert.equal(listaVazia.length, 0, "Não deve haver snapshots para produto sem comissão");

  const ultimaVazia = obterUltimaComissao(pSemComissao.id);
  assert.equal(ultimaVazia, null, "Última comissão sem snapshot deve ser null (não zero fabricado)");

  // 4. Dois snapshots são preservados
  const snap2 = gravarSnapshotComissao({
    produto_id: pShopee.id,
    integracao_key: "shopee",
    comissao_valor: 15.5,
    comissao_percentual: 0.1,
  });
  assert.ok(snap2);

  const snapsShopee = listarSnapshotsComissao(pShopee.id);
  assert.equal(snapsShopee.length, 2, "Dois snapshots devem ser preservados");
  assert.equal(snapsShopee[0]!.id, snap2.id, "Mais recente deve vir primeiro");
  assert.equal(snapsShopee[0]!.comissao_valor, 15.5);
  assert.equal(snapsShopee[1]!.id, snap1.id);
  assert.equal(snapsShopee[1]!.comissao_valor, 12.34);

  const ultima = obterUltimaComissao(pShopee.id);
  assert.ok(ultima);
  assert.equal(ultima.id, snap2.id);
  assert.equal(ultima.comissao_valor, 15.5);

  // 5. Mercado Livre não cria snapshot de comissão
  salvarProduto({
    source_key: "mercado_livre",
    external_product_id: "MLB999888",
    nome: "Produto Mercado Livre",
    preco_atual: "99,90",
    desconto_percentual: 20,
    link_afiliado: "https://mercadolivre.com.br/...",
  });
  const pMl = buscarProdutoPorExternalId("mercado_livre", "MLB999888");
  assert.ok(pMl);

  const snapMl = gravarSnapshotComissao({
    produto_id: pMl.id,
    integracao_key: "mercado_livre",
    comissao_valor: 10.0,
    comissao_percentual: 0.1,
  });
  assert.equal(snapMl, null, "Mercado Livre não deve criar snapshot de comissão");

  const snapsMl = listarSnapshotsComissao(pMl.id);
  assert.equal(snapsMl.length, 0, "Mercado Livre não deve ter snapshots");

  // 6. Detalhe do produto devolve comissão estimada quando existe e null/indisponível quando não existe
  const resShopee = await api.req(`/api/produtos/${pShopee.id}`);
  assert.equal(resShopee.status, 200);
  const jsonShopee = resShopee.json as {
    comissao: {
      valor: number | null;
      percentual: number | null;
      disponivel: boolean;
      estimada: boolean;
      coletadaEm: string | null;
    };
  };
  assert.deepEqual(jsonShopee.comissao, {
    valor: 15.5,
    percentual: 0.1,
    disponivel: true,
    estimada: true,
    coletadaEm: snap2.coletado_em,
  });

  const resMl = await api.req(`/api/produtos/${pMl.id}`);
  assert.equal(resMl.status, 200);
  const jsonMl = resMl.json as {
    comissao: {
      valor: number | null;
      percentual: number | null;
      disponivel: boolean;
      estimada: boolean;
      coletadaEm: string | null;
    };
  };
  assert.deepEqual(jsonMl.comissao, {
    valor: null,
    percentual: null,
    disponivel: false,
    estimada: true,
    coletadaEm: null,
  });

  // 7. Atividades são gravadas, paginadas e filtradas
  gravarAtividade({
    tipo: "coleta_sucesso",
    integracao_key: "shopee",
    titulo: "Coleta Shopee de Teste",
    detalhe: "10 ofertas salvas",
  });
  gravarAtividade({
    tipo: "envio_sucesso",
    integracao_key: "mercado_livre",
    titulo: "Envio de Teste ML",
    detalhe: "Produto enviado",
  });
  gravarAtividade({
    tipo: "recheca_descarte",
    integracao_key: "shopee",
    produto_id: pShopee.id,
    titulo: "Produto descartado pela recheca Shopee",
    detalhe: "Preço subiu",
  });

  // Listar todas com paginação
  const resAtividades = await api.req("/api/activities?page=1&limit=2");
  assert.equal(resAtividades.status, 200);
  const jsonAtiv = resAtividades.json as {
    items: Array<{
      id: number;
      tipo: string;
      integracaoKey: string | null;
      plataforma: string | null;
      titulo: string;
      detalhe: string | null;
      criadoEm: string;
    }>;
    page: number;
    limit: number;
    total: number;
  };
  assert.equal(jsonAtiv.page, 1);
  assert.equal(jsonAtiv.limit, 2);
  assert.equal(jsonAtiv.items.length, 2);
  assert.ok(jsonAtiv.total >= 5, "Total de atividades registradas deve ser >= 5");

  // Filtro por tipo
  const resFiltroTipo = await api.req("/api/activities?tipo=recheca_descarte");
  assert.equal(resFiltroTipo.status, 200);
  const jsonFiltroTipo = resFiltroTipo.json as { items: Array<{ tipo: string }> };
  assert.ok(jsonFiltroTipo.items.length >= 1);
  for (const item of jsonFiltroTipo.items) {
    assert.equal(item.tipo, "recheca_descarte");
  }

  // Filtro por plataforma
  const resFiltroPlataforma = await api.req("/api/activities?plataforma=shopee");
  assert.equal(resFiltroPlataforma.status, 200);
  const jsonFiltroPlat = resFiltroPlataforma.json as {
    items: Array<{ integracaoKey: string | null; plataforma: string | null }>;
  };
  assert.ok(jsonFiltroPlat.items.length >= 1);
  for (const item of jsonFiltroPlat.items) {
    assert.equal(item.integracaoKey, "shopee");
    assert.equal(item.plataforma, "shopee");
  }

  // 8. Respostas não contêm segredos nem palavras relacionadas a cookie/csrf
  const corpoResShopee = JSON.stringify(resShopee.json).toLowerCase();
  assert.ok(!corpoResShopee.includes("cookie"), "Resposta de produto não deve conter cookie");
  assert.ok(!corpoResShopee.includes("csrf"), "Resposta de produto não deve conter csrf");

  const corpoResAtiv = JSON.stringify(resAtividades.json).toLowerCase();
  assert.ok(!corpoResAtiv.includes("cookie"), "Resposta de atividades não deve conter cookie");
  assert.ok(!corpoResAtiv.includes("csrf"), "Resposta de atividades não deve conter csrf");

  // Sanitização de segredos em atividade
  const ativSegredo = gravarAtividade({
    tipo: "teste_sanitizacao",
    titulo: "Atividade com cookie_sec e csrf_val",
    detalhe: "cookie_sessao=xyz; csrf_token=abc; secret_token=123",
  });
  assert.ok(!ativSegredo.detalhe?.toLowerCase().includes("cookie"), "Detalhe não deve conter 'cookie'");
  assert.ok(!ativSegredo.detalhe?.toLowerCase().includes("csrf"), "Detalhe não deve conter 'csrf'");
  assert.ok(!ativSegredo.detalhe?.toLowerCase().includes("token"), "Detalhe não deve conter 'token'");
  assert.ok(!ativSegredo.detalhe?.toLowerCase().includes("secret"), "Detalhe não deve conter 'secret'");

  // Comissão do dia em Brasília
  const comissaoDiaShopee = consultarComissaoDoDia("shopee");
  assert.equal(comissaoDiaShopee.disponivel, true);
  assert.equal(comissaoDiaShopee.estimada, true);
  assert.equal(typeof comissaoDiaShopee.valor, "number");

  const comissaoDiaMl = consultarComissaoDoDia("mercado_livre");
  assert.equal(comissaoDiaMl.disponivel, false);
  assert.equal(comissaoDiaMl.valor, null);

  console.log("Resultado: historico comissao passou");
} finally {
  await api.encerrar();
}
