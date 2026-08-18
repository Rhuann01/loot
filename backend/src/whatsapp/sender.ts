import "dotenv/config";
import { getSock } from "./connection.js";

interface ProdutoParaEnviar {
  nome: string;
  preco_atual: string;
  preco_original?: string;
  link_afiliado: string;
  imagem_url?: string;
  parcelas?: string;
  frete_gratis?: boolean;
}

const GROUP_ID = process.env.WHATSAPP_GROUP_ID as string;

export async function enviarProduto(produto: ProdutoParaEnviar) {
  const sock = getSock();

  if (!sock) {
    throw new Error("WhatsApp não está conectado");
  }

  const texto = montarMensagem(produto);

  if (produto.imagem_url) {
    await sock.sendMessage(GROUP_ID, {
      image: { url: produto.imagem_url },
      caption: texto,
    });
  } else {
    await sock.sendMessage(GROUP_ID, { text: texto });
  }
}

function montarMensagem(produto: ProdutoParaEnviar): string {
  const linhaPreco = produto.preco_original
    ? `De ~R$${produto.preco_original}~ por *R$${produto.preco_atual}*`
    : `Por *R$${produto.preco_atual}*`;

  const linhaExtras = [
    produto.frete_gratis ? "🚚 Frete grátis" : null,
    produto.parcelas ? `💳 ${produto.parcelas}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  return `🔥 PROMOÇÃO 🔥

*${produto.nome}*

${linhaPreco}
${linhaExtras}

👉 ${produto.link_afiliado}`;
}
