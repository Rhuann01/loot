import "dotenv/config";

import { buscarOfertas } from "../src/scraper/apify.js";

const ofertas = await buscarOfertas();

console.log(
  `Ofertas encontradas: ${ofertas.length}\n=============== Primeiras ofertas ===============\n`,
);
console.dir(ofertas.slice(0, 3), { depth: null });
