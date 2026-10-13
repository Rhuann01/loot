import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const diretorioOriginal = process.cwd();
const diretorioTeste = mkdtempSync(join(tmpdir(), "loot-coleta-shopee-"));
process.chdir(diretorioTeste);

const { default: db } = await import("../src/db/index.js");
const { coletarOfertasShopee } = await import("../src/integrations/shopee/source.js");
const { ShopeeApiError } = await import("../src/integrations/shopee/client.js");

let codigoSaida = 0;

try {
  if (!process.cwd().startsWith(tmpdir())) {
    throw new Error("Proteção: diretório atual não é temporário; abortando para não tocar o loot.db real.");
  }

  const salvas = await coletarOfertasShopee();
  console.log(`Ofertas salvas (retorno da função): ${salvas}`);

  const contar = (sql: string): number =>
    (db.prepare(sql).get() as { n: number }).n;

  const total = contar("SELECT COUNT(*) AS n FROM produtos WHERE source_key = 'shopee'");
  const stats = db
    .prepare(
      "SELECT MIN(desconto_percentual) AS minimo, MAX(desconto_percentual) AS maximo, AVG(desconto_percentual) AS media FROM produtos WHERE source_key = 'shopee'",
    )
    .get() as { minimo: number | null; maximo: number | null; media: number | null };
  const desc20 = contar(
    "SELECT COUNT(*) AS n FROM produtos WHERE source_key = 'shopee' AND desconto_percentual >= 20",
  );
  const comExpiracao = contar(
    "SELECT COUNT(*) AS n FROM produtos WHERE source_key = 'shopee' AND oferta_expira_em IS NOT NULL",
  );
  const linkIgual = contar(
    "SELECT COUNT(*) AS n FROM produtos WHERE source_key = 'shopee' AND link_afiliado = link_original",
  );

  const linhas = db
    .prepare(
      "SELECT nome, preco_atual, preco_original, desconto_percentual, external_product_id, link_original, link_afiliado FROM produtos WHERE source_key = 'shopee' ORDER BY desconto_percentual DESC",
    )
    .all() as Array<{
    nome: string;
    preco_atual: number;
    preco_original: number | null;
    desconto_percentual: number;
    external_product_id: string;
    link_original: string;
    link_afiliado: string | null;
  }>;

  const regexId = /^\d+_\d+$/;
  const regexLink = /^https:\/\/shopee\.com\.br\/product\/\d+\/\d+$/;
  const idsInvalidos = linhas.filter((l) => !regexId.test(String(l.external_product_id))).length;
  const linksInvalidos = linhas.filter((l) => !regexLink.test(String(l.link_original))).length;

  console.log("\nResumo do banco temporário:");
  console.log(`Total de produtos shopee: ${total}`);
  console.log(`Desconto mínimo: ${stats.minimo}`);
  console.log(`Desconto máximo: ${stats.maximo}`);
  console.log(`Desconto médio: ${stats.media === null ? "n/a" : stats.media.toFixed(2)}`);
  console.log(`Com desconto >= 20: ${desc20}`);
  console.log(`Com oferta_expira_em preenchido: ${comExpiracao}`);
  console.log(`Com link_afiliado = link_original: ${linkIgual}`);
  console.log(`external_product_id inválidos: ${idsInvalidos}`);
  console.log(`link_original inválidos: ${linksInvalidos}`);

  console.log("\nExemplos (3 maiores descontos):");
  for (const l of linhas.slice(0, 3)) {
    console.log(`- nome: ${String(l.nome).slice(0, 50)}`);
    console.log(`  preco_atual: ${l.preco_atual}`);
    console.log(`  preco_original: ${l.preco_original}`);
    console.log(`  desconto_percentual: ${l.desconto_percentual}`);
    console.log(`  external_product_id: ${l.external_product_id}`);
    console.log(`  link_original: ${l.link_original}`);
  }

  const integracao = db
    .prepare("SELECT status, last_error FROM store_integrations WHERE integration_key = 'shopee'")
    .get() as { status: string; last_error: string | null } | undefined;
  console.log(`\nIntegração: status=${integracao?.status ?? "(ausente)"} last_error=${integracao?.last_error ?? "(nenhum)"}`);

  const verificacoes: Array<[string, boolean, string]> = [
    ["total > 0", total > 0, `total = ${total}`],
    ["nenhum external_product_id inválido", idsInvalidos === 0, `${idsInvalidos} inválidos`],
    ["nenhum link_original inválido", linksInvalidos === 0, `${linksInvalidos} inválidos`],
    [
      "todos os link_afiliado iguais ao link_original",
      linkIgual === total,
      `${linkIgual} de ${total}`,
    ],
    [
      "status = 'connected'",
      integracao?.status === "connected",
      `status = ${integracao?.status ?? "(ausente)"}`,
    ],
  ];

  console.log("\nVerificações:");
  for (const [nome, ok, motivo] of verificacoes) {
    console.log(`${ok ? "OK" : "FALHOU"} - ${nome} (${motivo})`);
    if (!ok) codigoSaida = 1;
  }
} catch (erro) {
  codigoSaida = 1;
  if (erro instanceof ShopeeApiError) {
    console.error(`Erro Shopee: ${erro.message} (codigo: ${erro.codigo ?? "n/a"})`);
  } else {
    console.error(`Erro: ${erro instanceof Error ? erro.message : String(erro)}`);
  }
} finally {
  db.close();
  process.chdir(diretorioOriginal);
  rmSync(diretorioTeste, { recursive: true, force: true });
}

process.exit(codigoSaida);
