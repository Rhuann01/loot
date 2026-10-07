export type IntegrationKey =
  | "mercado_livre"
  | "shopee"
  | "tiktok_shop";

export type IntegrationStatus =
  | "not_configured"
  | "connected"
  | "disconnected"
  | "disabled";

export interface ProductSource {
  readonly key: IntegrationKey;
  readonly name: string;
  fetchProducts(): Promise<unknown[]>;
}

export interface AffiliateProvider {
  readonly key: IntegrationKey;
  generateLink(productUrl: string): Promise<string>;
}
