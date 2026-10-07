// Adapter de coleta do Mercado Livre.
// Cada nova loja deve ter seu próprio módulo de scraper, sem reutilizar o
// parser ou o Actor específico desta integração.
export {
  buscarOfertas,
  processarESalvarOfertas,
} from "./apify.js";
