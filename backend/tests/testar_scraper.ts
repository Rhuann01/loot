import "dotenv/config";

import { BuscarOfertas } from "../src/scraper/apify.js";

const ofertas = await BuscarOfertas();
console.log(
  `Ofertas encontradas: ${ofertas.length}\n=============== Ofertas ===============\n`,
);
console.log(ofertas[0]);
