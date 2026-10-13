import { gerarLinkAfiliado } from "../affiliate/mercadolivre/provider.js";
import { gerarLinkAfiliadoShopee } from "./shopee/provider.js";
import { coletarOfertasShopee } from "./shopee/source.js";
import { processarESalvarOfertas } from "../scraper/mercadolivre.js";
import type { AffiliateProvider, IntegrationKey } from "./types.js";

const mercadoLivreAffiliateProvider: AffiliateProvider = {
  key: "mercado_livre",
  async generateLink(productUrl) {
    return gerarLinkAfiliado(productUrl);
  },
};

const shopeeAffiliateProvider: AffiliateProvider = {
  key: "shopee",
  async generateLink(productUrl) {
    return gerarLinkAfiliadoShopee(productUrl);
  },
};

const affiliateProviders = new Map<IntegrationKey, AffiliateProvider>([
  [mercadoLivreAffiliateProvider.key, mercadoLivreAffiliateProvider],
  [shopeeAffiliateProvider.key, shopeeAffiliateProvider],
]);

export function getAffiliateProvider(key: IntegrationKey): AffiliateProvider {
  const provider = affiliateProviders.get(key);
  if (!provider) throw new Error(`provedor de afiliado não implementado: ${key}`);
  return provider;
}

export function temAffiliateProvider(key: string): key is IntegrationKey {
  return affiliateProviders.has(key as IntegrationKey);
}

export const coletores: ReadonlyArray<{
  key: IntegrationKey;
  coletar: () => Promise<number>;
}> = [
  { key: "mercado_livre", coletar: processarESalvarOfertas },
  { key: "shopee", coletar: coletarOfertasShopee },
];
