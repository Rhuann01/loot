import assert from "node:assert/strict";
import { iniciarApiDeTeste } from "./helpers/api-harness.js";
import type { AbaProdutos } from "../src/db/queries.js";

const api = await iniciarApiDeTeste();

try {
  const { ABAS_PRODUTOS, salvarProduto } = await import(
    "../src/db/queries.js"
  );

  // Criar 25 produtos (mistura de ML e Shopee)
  const ids: number[] = [];
  for (let i = 1; i <= 25; i++) {
    const isShopee = i % 2 === 0;
    const nome =
      i === 13 ? "Produto Especial 50%_off Promocao" : `Produto Teste ${i}`;
    const linkOriginal = `https://example.test/orig-${i}`;
    const linkAfiliado =
      i === 25 ? linkOriginal : `https://example.test/afil-${i}`;

    salvarProduto({
      source_key: isShopee ? "shopee" : "mercado_livre",
      external_product_id: `PROD-${i}`,
      nome,
      preco_atual: "80.00",
      preco_original: "100.00",
      desconto_percentual: 20,
      link_original: linkOriginal,
      link_afiliado: linkAfiliado,
    });

    const linha = api.db
      .prepare(
        "SELECT id FROM produtos WHERE source_key = ? AND external_product_id = ?",
      )
      .get(isShopee ? "shopee" : "mercado_livre", `PROD-${i}`) as { id: number };
    ids.push(linha.id);
  }

  // Distribuir status:
  // 1..10: pending (enviado = 0, status_fila = 'pending')
  // 11..15: sent (enviado = 1, status_fila = 'sent')
  // 16..20: failed (enviado = 0, status_fila = 'failed')
  // 21..25: ambiguous (enviado = 0, status_fila = 'ambiguous')
  for (let idx = 0; idx < ids.length; idx++) {
    const i = idx + 1;
    const id = ids[idx]!;
    if (i <= 10) {
      api.db
        .prepare(
          "UPDATE produtos SET status_fila = 'pending', enviado = 0 WHERE id = ?",
        )
        .run(id);
    } else if (i <= 15) {
      api.db
        .prepare(
          "UPDATE produtos SET status_fila = 'sent', enviado = 1 WHERE id = ?",
        )
        .run(id);
    } else if (i <= 20) {
      api.db
        .prepare(
          "UPDATE produtos SET status_fila = 'failed', enviado = 0 WHERE id = ?",
        )
        .run(id);
    } else {
      api.db
        .prepare(
          "UPDATE produtos SET status_fila = 'ambiguous', enviado = 0 WHERE id = ?",
        )
        .run(id);
    }
  }

  // (1) /api/produtos sem filtros => 200, items.length 20, page 1, limit 20, total 25, counts.all 25
  const resPadrao = await api.req("/api/produtos");
  assert.equal(resPadrao.status, 200);
  const jsonPadrao = resPadrao.json as {
    items: unknown[];
    page: number;
    limit: number;
    total: number;
    counts: Record<string, number>;
  };
  assert.equal(jsonPadrao.items.length, 20);
  assert.equal(jsonPadrao.page, 1);
  assert.equal(jsonPadrao.limit, 20);
  assert.equal(jsonPadrao.total, 25);
  assert.equal(jsonPadrao.counts["all"], 25);

  // (2) page=2 => 5 itens
  const resP2 = await api.req("/api/produtos?page=2");
  assert.equal(resP2.status, 200);
  const jsonP2 = resP2.json as { items: unknown[]; total: number; page: number };
  assert.equal(jsonP2.items.length, 5);
  assert.equal(jsonP2.page, 2);
  assert.equal(jsonP2.total, 25);

  // (3) status=sent devolve só itens status "sent"; status=ambiguous só "needs_review" com needsReview true; counts bate com a contagem manual via SQL
  const resSent = await api.req("/api/produtos?status=sent");
  assert.equal(resSent.status, 200);
  const jsonSent = resSent.json as {
    items: Array<{ status: string; needsReview: boolean }>;
  };
  assert.ok(jsonSent.items.length > 0);
  for (const item of jsonSent.items) {
    assert.equal(item.status, "sent");
  }

  const resAmbiguous = await api.req("/api/produtos?status=ambiguous");
  assert.equal(resAmbiguous.status, 200);
  const jsonAmbiguous = resAmbiguous.json as {
    items: Array<{ status: string; needsReview: boolean }>;
  };
  assert.ok(jsonAmbiguous.items.length > 0);
  for (const item of jsonAmbiguous.items) {
    assert.equal(item.status, "needs_review");
    assert.equal(item.needsReview, true);
  }

  const condicoesAba: Record<AbaProdutos, string> = {
    all: "1 = 1",
    pending: "enviado = 0 AND status_fila IN ('pending','sending')",
    sent: "(status_fila = 'sent' OR enviado = 1)",
    failed: "status_fila = 'failed' AND enviado = 0",
    ambiguous: "status_fila = 'ambiguous' AND enviado = 0",
    not_sent: "enviado = 0",
  };
  for (const aba of ABAS_PRODUTOS) {
    const sqlTotal = (
      api.db
        .prepare(`SELECT COUNT(*) AS n FROM produtos WHERE ${condicoesAba[aba]}`)
        .get() as { n: number }
    ).n;
    assert.equal(
      jsonPadrao.counts[aba],
      sqlTotal,
      `contagem da aba ${aba} deve bater com o banco`,
    );
  }

  // (4) q=50%_off acha só o produto com esse nome (o % e o _ não funcionam como curinga)
  const resQ = await api.req(
    `/api/produtos?q=${encodeURIComponent("50%_off")}`,
  );
  assert.equal(resQ.status, 200);
  const jsonQ = resQ.json as { items: Array<{ nome: string }>; total: number };
  assert.equal(jsonQ.total, 1);
  assert.equal(jsonQ.items.length, 1);
  assert.equal(jsonQ.items[0]?.nome, "Produto Especial 50%_off Promocao");

  // (5) status=xyz, page=0, limit=101, limit=abc => 400 com error.code "PARAMETRO_INVALIDO"
  const casos400 = [
    "/api/produtos?status=xyz",
    "/api/produtos?page=0",
    "/api/produtos?limit=101",
    "/api/produtos?limit=abc",
  ];
  for (const url of casos400) {
    const res = await api.req(url);
    assert.equal(res.status, 400, `URL ${url} deveria retornar 400`);
    assert.equal(
      (res.json as { error: { code: string } })?.error?.code,
      "PARAMETRO_INVALIDO",
      `URL ${url} deveria ter code PARAMETRO_INVALIDO`,
    );
  }

  // (6) /api/produtos/:id existente => 200 com comissao.disponivel false, pedidos.disponivel false e tentativas array; id inexistente => 404; id "abc" => 400
  const primeiroId = ids[0]!;
  const resDetalhe = await api.req(`/api/produtos/${primeiroId}`);
  assert.equal(resDetalhe.status, 200);
  const jsonDetalhe = resDetalhe.json as {
    comissao: { disponivel: boolean; valor: unknown };
    pedidos: { disponivel: boolean; motivo: string };
    tentativas: unknown[];
  };
  assert.equal(jsonDetalhe.comissao.disponivel, false);
  assert.equal(jsonDetalhe.pedidos.disponivel, false);
  assert.ok(Array.isArray(jsonDetalhe.tentativas));

  const resInexistente = await api.req("/api/produtos/999999");
  assert.equal(resInexistente.status, 404);
  assert.equal(
    (resInexistente.json as { error: { code: string } })?.error?.code,
    "NAO_ENCONTRADO",
  );

  const resIdInvalido = await api.req("/api/produtos/abc");
  assert.equal(resIdInvalido.status, 400);
  assert.equal(
    (resIdInvalido.json as { error: { code: string } })?.error?.code,
    "PARAMETRO_INVALIDO",
  );

  // (7) um produto com link_afiliado = link_original tem linkAfiliadoValido false
  const id25 = ids[24]!;
  const res25 = await api.req(`/api/produtos/${id25}`);
  assert.equal(res25.status, 200);
  assert.equal(
    (res25.json as { linkAfiliadoValido: boolean })?.linkAfiliadoValido,
    false,
  );
  assert.equal(
    (resDetalhe.json as { linkAfiliadoValido: boolean })?.linkAfiliadoValido,
    true,
  );

  // (8) a resposta nunca contém a palavra "csrf" nem "cookie" (JSON.stringify do corpo em minúsculas)
  assert.ok(
    !JSON.stringify(resPadrao.json).toLowerCase().includes("csrf"),
    "resposta não deve conter csrf",
  );
  assert.ok(
    !JSON.stringify(resPadrao.json).toLowerCase().includes("cookie"),
    "resposta não deve conter cookie",
  );
  assert.ok(
    !JSON.stringify(resDetalhe.json).toLowerCase().includes("csrf"),
    "resposta de detalhe não deve conter csrf",
  );
  assert.ok(
    !JSON.stringify(resDetalhe.json).toLowerCase().includes("cookie"),
    "resposta de detalhe não deve conter cookie",
  );

  // (9) POST /api/produtos/:id/reenviar de produto com link afiliado igual ao original, com header Idempotency-Key "k1" => 502, error.code "REENVIO_FALHOU" e a mensagem casa /link afiliado/i
  const resReenviar = await api.req(`/api/produtos/${id25}/reenviar`, {
    method: "POST",
    headers: {
      "Idempotency-Key": "k1",
    },
  });
  assert.equal(resReenviar.status, 502);
  const jsonReenviar = resReenviar.json as {
    error: { code: string; message: string };
  };
  assert.equal(jsonReenviar.error.code, "REENVIO_FALHOU");
  assert.match(jsonReenviar.error.message, /link afiliado/i);

  console.log("Resultado: api promocoes passou");
} finally {
  await api.encerrar();
  process.exit(0);
}
