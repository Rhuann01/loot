import "dotenv/config";

import { buscarOfertas } from "../src/scraper/mercadolivre.js";
import { gerarLinkAfiliado } from "../src/affiliate/mercadolivre/provider.js";
import {
  buscarProdutoPorCodigoML,
  atualizarLinkAfiliado,
  salvarProduto,
  setConfig,
} from "../src/db/queries.js";

const quantidade = Math.min(
  5,
  Math.max(1, Number(process.env.WHATSAPP_TEST_SAMPLE_SIZE ?? 3) || 3),
);

function extrairChaveProduto(link: string): string {
  const match = link.match(/MLB-?\d+/i);
  if (match) return match[0].replace("-", "").toUpperCase();

  try {
    const url = new URL(link);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return link.trim();
  }
}

console.log("Executando uma coleta única para preparar a amostra do WhatsApp...");
const ofertas = await buscarOfertas();
const idsVistos = new Set<string>();
const ofertasUnicas = ofertas.filter((oferta) => {
  const id = extrairChaveProduto(oferta.zProdutoLink);
  if (!id || idsVistos.has(id)) return false;
  idsVistos.add(id);
  return true;
});

const selecionadas = ofertasUnicas.slice(0, quantidade);
if (selecionadas.length < quantidade) {
  throw new Error(
    `A coleta retornou ${ofertas.length} ofertas, mas apenas ${selecionadas.length} produtos distintos identificáveis; eram necessários ${quantidade}.`,
  );
}

const idsAmostra: string[] = [];
for (const oferta of selecionadas) {
  const idProduto = extrairChaveProduto(oferta.zProdutoLink);
  const existente = buscarProdutoPorCodigoML(idProduto);
  let linkAfiliado = existente?.link_afiliado;

  if (!linkAfiliado || linkAfiliado === oferta.zProdutoLink) {
    console.log(`Gerando link afiliado uma vez para ${idProduto}...`);
    try {
      linkAfiliado = await gerarLinkAfiliado(oferta.zProdutoLink);
    } catch (erro) {
      console.warn(
        `Não foi possível gerar link afiliado para ${idProduto}; usando o link original`,
        erro,
      );
      linkAfiliado = oferta.zProdutoLink;
    }
  } else {
    console.log(`Reutilizando link afiliado já salvo para ${idProduto}.`);
  }

  salvarProduto({
    source_key: "mercado_livre",
    external_product_id: idProduto,
    nome: oferta.eTituloProduto,
    preco_atual: oferta.novoPreco,
    preco_original: oferta.precoAnterior,
    desconto_percentual: Number(oferta.precoDiscount.match(/(\d+)%/)?.[1] ?? 0),
    imagem_url: oferta.imagemLink,
    link_original: oferta.zProdutoLink,
    link_afiliado: linkAfiliado,
  });
  atualizarLinkAfiliado(idProduto, linkAfiliado);
  idsAmostra.push(idProduto);
}

setConfig("whatsapp_teste_produtos", JSON.stringify({ ids: idsAmostra }));
console.log(
  `Amostra preparada com ${idsAmostra.length} produtos distintos. Os próximos testes não chamarão o Apify nem gerarão novos links.`,
);
