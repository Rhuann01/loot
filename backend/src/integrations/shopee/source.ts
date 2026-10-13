import { shopeeRequest } from "./client.js";
import {
  atualizarStatusIntegracao,
  limparProdutosAntigos,
  salvarProduto,
  setConfig,
} from "../../db/queries.js";

const QUERY = `
  query Buscar($kw: String, $sort: Int, $page: Int, $limit: Int) {
    productOfferV2(keyword: $kw, sortType: $sort, page: $page, limit: $limit) {
      nodes {
        itemId
        shopId
        productName
        imageUrl
        priceMin
        priceDiscountRate
        periodEndTime
      }
      pageInfo { hasNextPage }
    }
  }
`;

export interface OfertaShopee {
  itemId: number;
  shopId: number;
  productName: string;
  imageUrl: string;
  priceMin: string;
  priceDiscountRate: number;
  periodEndTime?: number | null;
}

export interface ProdutoShopeeConvertido {
  source_key: "shopee";
  external_product_id: string;
  nome: string;
  preco_atual: string;
  preco_original: string;
  desconto_percentual: number;
  imagem_url: string;
  link_original: string;
  link_afiliado: string;
  oferta_expira_em?: number;
}

const MAX_PAGINAS = 2;
const LIMITE_POR_PAGINA = 50;

const formatarPreco = (valor: number) => valor.toFixed(2).replace(".", ",");

// Função pura (sem rede/banco): devolve null quando a oferta não deve ser salva.
export function converterOfertaShopee(
  o: OfertaShopee,
  agoraSegundos: number,
): ProdutoShopeeConvertido | null {
  const atual = Number(o.priceMin);
  const desconto = Number(o.priceDiscountRate);
  if (!Number.isFinite(atual) || atual <= 0) return null;
  if (!Number.isFinite(desconto) || desconto < 1) return null;
  if (o.periodEndTime && o.periodEndTime <= agoraSegundos) return null;

  const original = atual / (1 - Math.min(desconto, 95) / 100);
  // Formato limpo de URL, sem parâmetros extras (regra do manual da Shopee).
  const url = `https://shopee.com.br/product/${o.shopId}/${o.itemId}`;

  return {
    source_key: "shopee",
    external_product_id: `${o.shopId}_${o.itemId}`,
    nome: o.productName,
    preco_atual: formatarPreco(atual),
    preco_original: formatarPreco(original),
    desconto_percentual: Math.round(desconto),
    imagem_url: o.imageUrl,
    link_original: url,
    // O link de afiliado NÃO é gerado aqui; é gerado depois da reserva, no envio.
    link_afiliado: url,
    ...(o.periodEndTime ? { oferta_expira_em: o.periodEndTime } : {}),
  };
}

export async function coletarOfertasShopee(): Promise<number> {
  const keyword = process.env.SHOPEE_KEYWORD?.trim() || null;
  const agora = Math.floor(Date.now() / 1000);
  let salvas = 0;

  try {
    for (let page = 1; page <= MAX_PAGINAS; page++) {
      const data = await shopeeRequest<{
        productOfferV2: {
          nodes: OfertaShopee[];
          pageInfo: { hasNextPage: boolean };
        };
      }>(QUERY, { kw: keyword, sort: 2, page, limit: LIMITE_POR_PAGINA });

      for (const oferta of data.productOfferV2.nodes) {
        const produto = converterOfertaShopee(oferta, agora);
        if (!produto) continue;
        salvarProduto(produto);
        salvas++;
      }

      if (!data.productOfferV2.pageInfo.hasNextPage) break;
    }

    limparProdutosAntigos();
    atualizarStatusIntegracao("shopee", "connected", {
      conectadoEm: new Date().toISOString(),
    });
    setConfig("shopee_ultimo_resultado", String(salvas));
    return salvas;
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    atualizarStatusIntegracao("shopee", "disconnected", {
      erro: mensagem.slice(0, 500),
    });
    throw erro;
  }
}
