import { getSock } from "./connection.js";
import { getConfig } from "../db/queries.js";

interface ProdutoParaEnviar {
  nome: string;
  preco_atual: string;
  preco_original?: string | null;
  link_afiliado: string;
  imagem_url?: string | null;
  parcelas?: string;
  frete_gratis?: boolean;
}

export async function enviarProduto(produto: ProdutoParaEnviar) {
  const sock = getSock();

  if (!sock) {
    throw new Error("WhatsApp não está conectado");
  }

  const groupId = getConfig("whatsapp_grupo_id");
  if (!groupId) {
    throw new Error("Grupo do WhatsApp não configurado");
  }

  const texto = montarMensagem(produto);

  if (imagemUrlValida(produto.imagem_url)) {
    await sock.sendMessage(groupId, {
      image: { url: produto.imagem_url },
      caption: texto,
    });
    return;
  }

  await sock.sendMessage(groupId, { text: texto });
}

function imagemUrlValida(imagemUrl: string | null | undefined): imagemUrl is string {
  if (!imagemUrl) return false;

  try {
    const url = new URL(imagemUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function montarMensagem(produto: ProdutoParaEnviar): string {
  const desconto = calcularDesconto(
    produto.preco_original,
    produto.preco_atual,
  );

  const linhaPreco = produto.preco_original
    ? `De: ~R$ ${produto.preco_original}~\nPor: *R$ ${produto.preco_atual}*`
    : `Por: *R$ ${produto.preco_atual}*`;

  const linhaExtras = [
    desconto ? `🏷️ ${desconto}% OFF` : null,
    produto.frete_gratis ? "🚚 Frete grátis" : null,
    produto.parcelas ? `💳 ${produto.parcelas}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  return `🔥 *${produto.nome}*

${linhaPreco}
${linhaExtras}

${produto.link_afiliado}`;
}

function calcularDesconto(
  precoOriginal: string | null | undefined,
  precoAtual: string,
): number | null {
  if (!precoOriginal) return null;

  const original = converterPreco(precoOriginal);
  const atual = converterPreco(precoAtual);
  if (original === null || atual === null || original <= atual) return null;

  const percentual = Math.round(((original - atual) / original) * 100);
  return percentual > 0 ? percentual : null;
}

function converterPreco(preco: string): number | null {
  const limpo = preco.replace(/[^\d,.-]/g, "").trim();
  if (!limpo) return null;

  const normalizado = limpo.includes(",")
    ? limpo.replace(/\./g, "").replace(",", ".")
    : limpo;
  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : null;
}
