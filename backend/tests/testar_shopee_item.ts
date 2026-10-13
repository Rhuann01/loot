import "dotenv/config";
import { shopeeRequest, ShopeeApiError } from "../src/integrations/shopee/client.js";

interface OfertaNode {
  itemId: string | number;
  shopId: string | number;
  productName?: string;
  priceMin?: string | number;
  priceMax?: string | number;
  priceDiscountRate?: string | number;
  periodEndTime?: string | number;
}

interface RespostaProductOfferV2 {
  productOfferV2?: {
    nodes?: OfertaNode[];
  };
}

function formatarDataLegivel(valor: string | number | undefined | null): string {
  if (valor === undefined || valor === null || valor === "" || Number(valor) === 0) {
    return "(não informado)";
  }
  const timestamp = Number(valor);
  const data = new Date(timestamp > 1e11 ? timestamp : timestamp * 1000);
  return Number.isNaN(data.getTime())
    ? String(valor)
    : data.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

async function main(): Promise<void> {
  const itemId = process.argv[2];

  if (!itemId || !/^\d+$/.test(itemId)) {
    console.error("Uso: npx tsx tests/testar_shopee_item.ts <itemId>");
    process.exit(1);
  }

  const query = `query { productOfferV2(itemId: ${itemId}, page: 1, limit: 5) { nodes { itemId shopId productName priceMin priceMax priceDiscountRate periodEndTime } } }`;

  const resposta = await shopeeRequest<RespostaProductOfferV2>(query);
  const nodes = resposta.productOfferV2?.nodes ?? [];

  console.log(`Nós retornados: ${nodes.length}`);

  for (const node of nodes) {
    const nome50 = (node.productName ?? "").slice(0, 50);
    const dataLegivel = formatarDataLegivel(node.periodEndTime);

    console.log(`- itemId: ${node.itemId}`);
    console.log(`  shopId: ${node.shopId}`);
    console.log(`  nome: ${nome50}`);
    console.log(`  priceMin: ${node.priceMin}`);
    console.log(`  priceMax: ${node.priceMax}`);
    console.log(`  priceDiscountRate: ${node.priceDiscountRate}`);
    console.log(`  periodEndTime: ${node.periodEndTime} (legível: ${dataLegivel})`);
  }
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
