import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const diretorioOriginal = process.cwd();
const diretorioTeste = mkdtempSync(join(tmpdir(), "loot-shopee-"));
process.chdir(diretorioTeste);

const { default: db } = await import("../src/db/index.js");
const {
  converterOfertaShopee,
  decidirRecheca,
  extrairItemIdShopee,
  precosDaOfertaAtual,
} = await import("../src/integrations/shopee/source.js");

try {
  const agora = 1_800_000_000;

  // 1. Oferta válida
  const caso1 = converterOfertaShopee(
    {
      itemId: 111,
      shopId: 222,
      productName: "Fone",
      imageUrl: "https://x/i.jpg",
      priceMin: "80.00",
      priceDiscountRate: 20,
      periodEndTime: 1_800_003_600,
    },
    agora,
  );
  assert.ok(caso1);
  assert.equal(caso1.external_product_id, "222_111");
  assert.equal(caso1.preco_atual, "80,00");
  assert.equal(caso1.preco_original, "100,00");
  assert.equal(caso1.desconto_percentual, 20);
  assert.equal(caso1.link_original, "https://shopee.com.br/product/222/111");
  assert.equal(caso1.link_afiliado, "https://shopee.com.br/product/222/111");
  assert.equal(caso1.oferta_expira_em, 1_800_003_600);
  assert.equal(caso1.source_key, "shopee");

  // 2. periodEndTime no passado (1_799_999_000) => null
  const caso2 = converterOfertaShopee(
    {
      itemId: 111,
      shopId: 222,
      productName: "Fone",
      imageUrl: "https://x/i.jpg",
      priceMin: "80.00",
      priceDiscountRate: 20,
      periodEndTime: 1_799_999_000,
    },
    agora,
  );
  assert.equal(caso2, null);

  // 3. priceDiscountRate 0 => null
  const caso3 = converterOfertaShopee(
    {
      itemId: 111,
      shopId: 222,
      productName: "Fone",
      imageUrl: "https://x/i.jpg",
      priceMin: "80.00",
      priceDiscountRate: 0,
      periodEndTime: 1_800_003_600,
    },
    agora,
  );
  assert.equal(caso3, null);

  // 4. priceMin "abc" => null
  const caso4 = converterOfertaShopee(
    {
      itemId: 111,
      shopId: 222,
      productName: "Fone",
      imageUrl: "https://x/i.jpg",
      priceMin: "abc",
      priceDiscountRate: 20,
      periodEndTime: 1_800_003_600,
    },
    agora,
  );
  assert.equal(caso4, null);

  // 5. priceMin "0" => null
  const caso5 = converterOfertaShopee(
    {
      itemId: 111,
      shopId: 222,
      productName: "Fone",
      imageUrl: "https://x/i.jpg",
      priceMin: "0",
      priceDiscountRate: 20,
      periodEndTime: 1_800_003_600,
    },
    agora,
  );
  assert.equal(caso5, null);

  // 6. Sem periodEndTime (undefined) => convertido e a propriedade oferta_expira_em NÃO existe no resultado
  const caso6 = converterOfertaShopee(
    {
      itemId: 111,
      shopId: 222,
      productName: "Fone",
      imageUrl: "https://x/i.jpg",
      priceMin: "80.00",
      priceDiscountRate: 20,
    },
    agora,
  );
  assert.ok(caso6);
  assert.equal("oferta_expira_em" in caso6, false);

  // 7. priceMin "199.9" com desconto 30 => preco_atual "199,90" e preco_original "285,57"
  const caso7 = converterOfertaShopee(
    {
      itemId: 111,
      shopId: 222,
      productName: "Fone",
      imageUrl: "https://x/i.jpg",
      priceMin: "199.9",
      priceDiscountRate: 30,
      periodEndTime: 1_800_003_600,
    },
    agora,
  );
  assert.ok(caso7);
  assert.equal(caso7.preco_atual, "199,90");
  assert.equal(caso7.preco_original, "285,57");

  // Recheca (descontoMinimo = 20, precoGuardado = "100,00")
  assert.deepEqual(
    decidirRecheca("100,00", { precoAtual: 100, descontoPercentual: 30 }, 20),
    { enviar: true, precoAtual: 100, descontoPercentual: 30 },
  );
  assert.deepEqual(
    decidirRecheca("100,00", { precoAtual: 90, descontoPercentual: 35 }, 20),
    { enviar: true, precoAtual: 90, descontoPercentual: 35 },
  );
  assert.deepEqual(
    decidirRecheca("100,00", { precoAtual: 102, descontoPercentual: 30 }, 20),
    { enviar: true, precoAtual: 102, descontoPercentual: 30 },
  );
  assert.deepEqual(
    decidirRecheca("100,00", { precoAtual: 102.01, descontoPercentual: 30 }, 20),
    { enviar: false, motivo: "Preço subiu desde a coleta" },
  );
  assert.deepEqual(
    decidirRecheca("100,00", { precoAtual: 100, descontoPercentual: 19 }, 20),
    { enviar: false, motivo: "Desconto atual abaixo do mínimo" },
  );
  assert.deepEqual(decidirRecheca("100,00", null, 20), {
    enviar: false,
    motivo: "Oferta não encontrada na Shopee",
  });
  assert.deepEqual(
    decidirRecheca("abc", { precoAtual: 100, descontoPercentual: 30 }, 20),
    { enviar: false, motivo: "Preço guardado inválido" },
  );

  // extrairItemIdShopee
  assert.equal(extrairItemIdShopee("222_111"), "111");
  assert.equal(extrairItemIdShopee("abc"), null);
  assert.equal(extrairItemIdShopee("1_2_3"), null);
  assert.equal(extrairItemIdShopee("222_x"), null);

  // precosDaOfertaAtual
  assert.deepEqual(
    precosDaOfertaAtual({ precoAtual: 64, descontoPercentual: 60 }),
    { preco_atual: "64,00", preco_original: "160,00", desconto_percentual: 60 },
  );
  assert.deepEqual(
    precosDaOfertaAtual({ precoAtual: 5, descontoPercentual: 99 }),
    { preco_atual: "5,00", preco_original: "100,00", desconto_percentual: 99 },
  );

  console.log("Resultado: conversão Shopee passou");
} finally {
  db.close();
  process.chdir(diretorioOriginal);
  rmSync(diretorioTeste, { recursive: true, force: true });
}
