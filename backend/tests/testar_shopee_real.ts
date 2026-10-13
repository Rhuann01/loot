import "dotenv/config";
import { shopeeRequest, ShopeeApiError } from "../src/integrations/shopee/client.js";

interface Oferta {
  itemId: string | number;
  shopId: string | number;
  productName?: string;
  priceMin?: string | number;
  priceDiscountRate?: string | number;
  periodEndTime?: string | number;
}

interface RespostaOfertas {
  productOfferV2: { nodes: Oferta[] };
}

interface RespostaShortLink {
  generateShortLink: { shortLink: string };
}

const QUERY_OFERTAS = `
query ($keyword: String, $sortType: Int, $page: Int, $limit: Int) {
  productOfferV2(keyword: $keyword, sortType: $sortType, page: $page, limit: $limit) {
    nodes {
      itemId
      shopId
      productName
      priceMin
      priceDiscountRate
      periodEndTime
    }
  }
}`;

const MUTATION_SHORT_LINK = `
mutation Gerar($url: String!, $subs: [String!]) {
  generateShortLink(input: { originUrl: $url, subIds: $subs }) {
    shortLink
  }
}`;

function dataLegivel(valor: string | number | undefined): string {
  if (valor === undefined || valor === null || valor === "" || Number(valor) === 0) {
    return "(não informado)";
  }
  const data = new Date(Number(valor) * 1000);
  return Number.isNaN(data.getTime())
    ? String(valor)
    : data.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

async function main(): Promise<void> {
  console.log("== Passo 1: productOfferV2 ==");
  const ofertas = await shopeeRequest<RespostaOfertas>(QUERY_OFERTAS, {
    keyword: null,
    sortType: 2,
    page: 1,
    limit: 3,
  });
  const itens = ofertas.productOfferV2?.nodes ?? [];
  console.log(`Itens recebidos: ${itens.length}`);
  for (const item of itens) {
    console.log(`- ${(item.productName ?? "").slice(0, 50)}`);
    console.log(`  priceMin: ${item.priceMin}`);
    console.log(`  priceDiscountRate: ${item.priceDiscountRate}`);
    console.log(`  periodEndTime: ${dataLegivel(item.periodEndTime)}`);
  }

  const primeiro = itens[0];
  if (!primeiro) throw new Error("Nenhum item retornado para gerar o shortLink");

  console.log("\n== Passo 2: generateShortLink ==");
  const originUrl = `https://shopee.com.br/product/${primeiro.shopId}/${primeiro.itemId}`;
  const resultado = await shopeeRequest<RespostaShortLink>(MUTATION_SHORT_LINK, {
    url: originUrl,
    subs: ["whatsapp"],
  });
  console.log(`URL original: ${originUrl}`);
  console.log(`shortLink: ${resultado.generateShortLink.shortLink}`);
}

try {
  await main();
  process.exit(0);
} catch (erro) {
  if (erro instanceof ShopeeApiError) {
    console.error(`ShopeeApiError: ${erro.message} (codigo: ${erro.codigo})`);
  } else {
    console.error(erro instanceof Error ? erro.message : String(erro));
  }
  process.exit(1);
}
