import "dotenv/config";
import { conectarWhatsApp } from "../src/whatsapp/connection.js";
import { processarESalvarOfertas } from "../src/scraper/apify.js";
import { getMelhoresDescontos, marcarComoEnviado, podeEnviarMais } from "../src/db/queries.js";
import { enviarProduto } from "../src/whatsapp/sender.js";

async function enviarLote(quantidade: number) {
  for (let i = 0; i < quantidade; i++) {
    if (!podeEnviarMais()) {
      console.log("limite diário atingido ou auto-envio desligado, parando");
      break;
    }

    const [produto] = getMelhoresDescontos(1);

    if (!produto) {
      console.log("nenhum produto novo pra enviar");
      break;
    }

    await enviarProduto({
      nome: produto.nome,
      preco_atual: produto.preco_atual,
      preco_original: produto.preco_original,
      link_afiliado: produto.link_afiliado,
      imagem_url: produto.imagem_url,
    });

    marcarComoEnviado(produto.id);
    console.log(`enviado: ${produto.nome}`);
  }
}

await conectarWhatsApp();

setTimeout(async () => {
  console.log("buscando ofertas...");
  await processarESalvarOfertas();

  console.log("enviando lote de teste...");
  await enviarLote(3);

  console.log("teste feito");
}, 3000);