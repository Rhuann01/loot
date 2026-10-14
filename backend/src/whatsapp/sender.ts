import { getSock } from "./connection.js";
import { getConfig } from "../db/queries.js";
import { formatarMensagem } from "./mensagem.js";

export interface ProdutoParaEnviar {
  nome: string;
  preco_atual: string;
  preco_original?: string | null;
  descontoPercentual?: number | null;
  link_afiliado: string;
  imagem_url?: string | null;
  parcelas?: string;
  frete_gratis?: boolean;
}

export function montarMensagemDoProduto(produto: ProdutoParaEnviar): string {
  return formatarMensagem({
    nome: produto.nome,
    precoAtual: produto.preco_atual,
    precoOriginal: produto.preco_original ?? null,
    descontoPercentual: produto.descontoPercentual ?? null,
    ...(produto.frete_gratis !== undefined ? { freteGratis: produto.frete_gratis } : {}),
    ...(produto.parcelas !== undefined ? { parcelas: produto.parcelas } : {}),
    linkAfiliado: produto.link_afiliado,
  });
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

  const texto = montarMensagemDoProduto(produto);

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
