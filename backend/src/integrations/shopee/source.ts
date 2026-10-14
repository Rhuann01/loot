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
  preco_original: string | null;
  desconto_percentual: number;
  imagem_url: string;
  link_original: string;
  link_afiliado: string;
  oferta_expira_em?: number;
}

const MAX_PAGINAS = 2;
const LIMITE_POR_PAGINA = 50;
// A API devolve periodEndTime em 2999 quando não informa o fim da oferta.
// Valores acima do ano 2100 são tratados como "sem fim informado".
const LIMITE_PERIODO_SEM_FIM = 4_102_444_800;

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

  // Formato limpo de URL, sem parâmetros extras (regra do manual da Shopee).
  const url = `https://shopee.com.br/product/${o.shopId}/${o.itemId}`;

  return {
    source_key: "shopee",
    external_product_id: `${o.shopId}_${o.itemId}`,
    nome: o.productName,
    preco_atual: formatarPreco(atual),
    preco_original: null,
    desconto_percentual: Math.round(desconto),
    imagem_url: o.imageUrl,
    link_original: url,
    // O link de afiliado NÃO é gerado aqui; é gerado depois da reserva, no envio.
    link_afiliado: url,
    ...(o.periodEndTime && o.periodEndTime <= LIMITE_PERIODO_SEM_FIM
      ? { oferta_expira_em: o.periodEndTime }
      : {}),
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

export interface OfertaAtualShopee {
  precoAtual: number;
  descontoPercentual: number;
}

export type DecisaoRecheca =
  | { enviar: true; precoAtual: number; descontoPercentual: number }
  | { enviar: false; motivo: string };

const TOLERANCIA_ALTA_PRECO = 1.02;

// "222_111" -> "111". Devolve null se o formato não for shopId_itemId.
export function extrairItemIdShopee(externalProductId: string): string | null {
  const partes = externalProductId.split("_");
  if (partes.length !== 2) return null;
  const itemId = partes[1] ?? "";
  return /^\d+$/.test(itemId) ? itemId : null;
}

// Função pura (sem rede/banco). precoGuardado vem do banco, formato "199,90".
export function decidirRecheca(
  precoGuardado: string,
  atual: OfertaAtualShopee | null,
  descontoMinimo: number,
): DecisaoRecheca {
  if (!atual) return { enviar: false, motivo: "Oferta não encontrada na Shopee" };
  const guardado = Number(precoGuardado.replace(",", "."));
  if (!Number.isFinite(guardado) || guardado <= 0) {
    return { enviar: false, motivo: "Preço guardado inválido" };
  }
  if (atual.descontoPercentual < descontoMinimo) {
    return { enviar: false, motivo: "Desconto atual abaixo do mínimo" };
  }
  if (atual.precoAtual > guardado * TOLERANCIA_ALTA_PRECO) {
    return { enviar: false, motivo: "Preço subiu desde a coleta" };
  }
  return {
    enviar: true,
    precoAtual: atual.precoAtual,
    descontoPercentual: atual.descontoPercentual,
  };
}

// Consulta o preço atual de UM item. O itemId vai direto no texto da query
// (validado como só dígitos), igual ao script tests/testar_shopee_item.ts,
// que foi confirmado na API real.
export async function consultarOfertaShopeePorItem(
  itemId: string,
): Promise<OfertaAtualShopee | null> {
  if (!/^\d+$/.test(itemId)) throw new Error("itemId inválido");

  const data = await shopeeRequest<{
    productOfferV2: {
      nodes: Array<{
        itemId: number | string;
        priceMin: string;
        priceDiscountRate: number;
      }>;
    };
  }>(
    `query { productOfferV2(itemId: ${itemId}, page: 1, limit: 5) { nodes { itemId priceMin priceDiscountRate } } }`,
  );

  const no = data.productOfferV2.nodes.find((n) => String(n.itemId) === itemId);
  if (!no) return null;
  const preco = Number(no.priceMin);
  const desconto = Number(no.priceDiscountRate);
  if (!Number.isFinite(preco) || preco <= 0) return null;
  return {
    precoAtual: preco,
    descontoPercentual: Number.isFinite(desconto) ? desconto : 0,
  };
}

// Preços formatados a partir da oferta atual da API. O "preco_original" é
// mantido como null, pois a Shopee não informa preço original.
export function precosDaOfertaAtual(atual: OfertaAtualShopee): {
  preco_atual: string;
  preco_original: string | null;
  desconto_percentual: number;
} {
  return {
    preco_atual: formatarPreco(atual.precoAtual),
    preco_original: null,
    desconto_percentual: Math.round(atual.descontoPercentual),
  };
}

