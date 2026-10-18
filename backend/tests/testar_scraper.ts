import "dotenv/config";
import assert from "node:assert/strict";
import { extrairIdProduto, extrairDesconto, buscarOfertas } from "../src/scraper/apify.js";

// 1. Extração de ID com hífen na URL
assert.equal(
  extrairIdProduto(
    "https://produto.mercadolivre.com.br/MLB-2794030545-kit-6-cuecas-boxer-lupo-sem-costura-box-microfibra-original-_JM?searchVariation=187166422265",
  ),
  "MLB2794030545",
  "Deve extrair MLB seguido de números mesmo quando há hífen",
);

// 2. Extração de ID sem hífen na URL
assert.equal(
  extrairIdProduto(
    "https://produto.mercadolivre.com.br/MLB5330020602-tnis-reserva-masculino-casual-cano-baixo-antiderrapante-_JM?searchVariation=187375331745",
  ),
  "MLB5330020602",
  "Deve extrair MLB seguido de números quando não há hífen",
);

// 3. Extração de ID em links de catálogo /p/
assert.equal(
  extrairIdProduto("https://www.mercadolivre.com.br/p/MLB12345678"),
  "MLB12345678",
  "Deve extrair MLB de link de catálogo",
);

// 4. Priorização/uso de idPublicacao fornecido pelo Apify
assert.equal(
  extrairIdProduto("https://produto.mercadolivre.com.br/outro-link", "MLB2794030545"),
  "MLB2794030545",
  "Deve usar idPublicacao quando fornecido e válido",
);
assert.equal(
  extrairIdProduto("https://produto.mercadolivre.com.br/outro-link", "MLB-2794030545"),
  "MLB2794030545",
  "Deve normalizar idPublicacao com hífen",
);

// 5. Links inválidos retornam string vazia
assert.equal(extrairIdProduto("https://mercadolivre.com.br/sem-id"), "");
assert.equal(extrairIdProduto(""), "");

// 6. Extração de desconto
assert.equal(extrairDesconto("60% OFF"), 60);
assert.equal(extrairDesconto("22%"), 22);
assert.equal(extrairDesconto("Sem desconto"), 0);
assert.equal(extrairDesconto(""), 0);

console.log("Resultado: testes do scraper do Mercado Livre passaram");

// Executa coleta real apenas se explicitamente solicitado
if (process.env.TESTAR_APIFY_LIVE === "true") {
  const ofertas = await buscarOfertas();
  console.log(`Ofertas encontradas: ${ofertas.length}`);
  console.dir(ofertas.slice(0, 3), { depth: null });
}

