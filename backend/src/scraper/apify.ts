import "dotenv/config";
import { ApifyClient } from "apify-client";

const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN as string,
});

export async function BuscarOfertas() {
  const run = await client
    .actor("karamelo/mercadolivre-scraper-brasil-portugues")
    .call({
      keyword: "ofertas",
      scraperOfertas: true,
      maxPagesOfertas: 1,
      promoted: false,
    });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  return items;
}

function extrairDesconto(precoDiscount: string): number {
  const math = precoDiscount.match(/(\d+)%/);
  return math ? Number(math[1]) : 0;
}

function extrairIdProduto(link: string): string {
  const math = link.match(/MLB\d+/);
  return math ? math[0] : "";
}
// Não é viavel - Necessita de OAuth
/* function montarLinkAfiliado(idProduto: string): string {
  const affiliateId = process.env.ML_AFFILIATE_ID;
  return `https://www.mercadolivre.com.br/produto/${idProduto}?picker=&affiliate=${affiliateId}`;
} */

function precoParaNumero(num: string): number {
  return Number(num.replace(".", "").replace(",", "."));
}
