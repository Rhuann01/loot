import assert from "node:assert/strict";
import { formatarMensagem } from "../src/whatsapp/mensagem.js";

// 1. Exato com preço original e desconto percentual
const m1 = formatarMensagem({
  nome: "Fone",
  precoAtual: "80,00",
  precoOriginal: "100,00",
  descontoPercentual: 20,
  linkAfiliado: "https://a.test/x",
});
assert.equal(
  m1,
  "🔥 *Fone*\n\nDe: ~R$ 100,00~\nPor: *R$ 80,00*\n🏷️ 20% OFF\n\nhttps://a.test/x",
);

// 2. Shopee: sem preço original, com desconto percentual
const m2 = formatarMensagem({
  nome: "Fone",
  precoAtual: "64,00",
  precoOriginal: null,
  descontoPercentual: 60,
  linkAfiliado: "https://a.test/x",
});
assert.equal(
  m2,
  "🔥 *Fone*\n\nPor: *R$ 64,00*\n🏷️ 60% OFF\n\nhttps://a.test/x",
);

// 3. Sem desconto e sem original
const m3 = formatarMensagem({
  nome: "Fone",
  precoAtual: "80,00",
  linkAfiliado: "https://a.test/x",
});
assert.equal(m3, "🔥 *Fone*\n\nPor: *R$ 80,00*\n\nhttps://a.test/x");

// 4. Sem descontoPercentual mas com original "100,00" e atual "80,00" => contém "20% OFF"
const m4 = formatarMensagem({
  nome: "Fone",
  precoAtual: "80,00",
  precoOriginal: "100,00",
  linkAfiliado: "https://a.test/x",
});
assert.ok(m4.includes("20% OFF"), "deve conter 20% OFF");

// 5. Com freteGratis e parcelas "12x de R$ 7,71" e desconto 20 => contém a linha "🏷️ 20% OFF | 🚚 Frete grátis | 💳 12x de R$ 7,71"
const m5 = formatarMensagem({
  nome: "Fone",
  precoAtual: "80,00",
  precoOriginal: "100,00",
  descontoPercentual: 20,
  freteGratis: true,
  parcelas: "12x de R$ 7,71",
  linkAfiliado: "https://a.test/x",
});
assert.ok(
  m5.includes("🏷️ 20% OFF | 🚚 Frete grátis | 💳 12x de R$ 7,71"),
  "deve conter os extras formatados",
);

// 6. Nenhum dos resultados contém "undefined" nem "null"
for (const [idx, m] of [m1, m2, m3, m4, m5].entries()) {
  assert.ok(
    !m.includes("undefined"),
    `resultado m${idx + 1} não deve conter undefined`,
  );
  assert.ok(!m.includes("null"), `resultado m${idx + 1} não deve conter null`);
}

console.log("Resultado: mensagem passou");
