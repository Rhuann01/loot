import "dotenv/config";
import { ApifyClient } from "apify-client";
import { salvarProduto } from "../db/queries.js";

const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN as string,
});

interface OfertaApify {
  zProdutoLink: string;
  eTituloProduto: string;
  novoPreco: string;
  precoAnterior: string;
  precoDiscount: string;
  imagemLink: string;
}

export async function buscarOfertas(): Promise<OfertaApify[]> {
  const run = await client
    .actor("karamelo/mercadolivre-scraper-brasil-portugues")
    .call({
      keyword: "ofertas",
      scrapeOfertas: true,
      maxPagesOfertas: 1,
      promoted: false,
    });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  return items as unknown as OfertaApify[];
}

function extrairDesconto(precoDiscount: string): number {
  const match = precoDiscount.match(/(\d+)%/);
  return match ? Number(match[1]) : 0;
}

function extrairIdProduto(link: string): string {
  const match = link.match(/MLB\d+/);
  return match ? match[0] : "";
}

function montarLinkTemporario(link: string): string {
  return link;
}

export async function processarESalvarOfertas() {
  const ofertas = await buscarOfertas();

  for (const oferta of ofertas) {
    const idProduto = extrairIdProduto(oferta.zProdutoLink);

    if (!idProduto) continue;

    salvarProduto({
      produto_id_ml: idProduto,
      nome: oferta.eTituloProduto,
      preco_atual: oferta.novoPreco,
      preco_original: oferta.precoAnterior,
      desconto_percentual: extrairDesconto(oferta.precoDiscount),
      imagem_url: oferta.imagemLink,
      link_afiliado: montarLinkTemporario(oferta.zProdutoLink),
    });
  }

  console.log(`${ofertas.length} ofertas processadas e salvas`);
}
