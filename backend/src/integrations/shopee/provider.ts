import { shopeeRequest } from "./client.js";
import { atualizarStatusIntegracao } from "../../db/queries.js";

const MUTATION = `
  mutation Gerar($url: String!, $subs: [String!]) {
    generateShortLink(input: { originUrl: $url, subIds: $subs }) {
      shortLink
    }
  }
`;

export async function gerarLinkAfiliadoShopee(
  urlProduto: string,
): Promise<string> {
  const data = await shopeeRequest<{
    generateShortLink?: { shortLink?: string };
  }>(MUTATION, { url: urlProduto, subs: ["whatsapp"] });

  const link = data.generateShortLink?.shortLink;
  if (!link) throw new Error("Shopee não retornou shortLink");

  atualizarStatusIntegracao("shopee", "connected", {
    conectadoEm: new Date().toISOString(),
  });
  return link;
}
