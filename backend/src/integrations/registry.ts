import {
  gerarLinkAfiliado,
} from "../affiliate/mercadolivre/provider.js";
import type { AffiliateProvider, IntegrationKey } from "./types.js";

const mercadoLivreAffiliateProvider: AffiliateProvider = {
  key: "mercado_livre",
  async generateLink(productUrl) {
    return gerarLinkAfiliado(productUrl);
  },
};

const affiliateProviders = new Map<IntegrationKey, AffiliateProvider>([
  [mercadoLivreAffiliateProvider.key, mercadoLivreAffiliateProvider],
]);

export function getAffiliateProvider(key: IntegrationKey): AffiliateProvider {
  const provider = affiliateProviders.get(key);
  if (!provider) throw new Error(`provedor de afiliado não implementado: ${key}`);
  return provider;
}
