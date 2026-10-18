export interface DadosMensagem {
  nome: string;
  precoAtual: string;
  precoOriginal?: string | null;
  descontoPercentual?: number | null;
  freteGratis?: boolean;
  parcelas?: string;
  linkAfiliado: string;
}

export function formatarMensagem(d: DadosMensagem): string {
  const desconto =
    d.descontoPercentual && d.descontoPercentual > 0
      ? Math.round(d.descontoPercentual)
      : calcularDesconto(d.precoOriginal, d.precoAtual);

  let precoOriginalFinal = d.precoOriginal;
  if (
    (!precoOriginalFinal || !precoOriginalFinal.trim()) &&
    desconto &&
    desconto > 0 &&
    desconto < 100
  ) {
    const atualNum = converterPreco(d.precoAtual);
    if (atualNum !== null && atualNum > 0) {
      const originalNum = atualNum / (1 - desconto / 100);
      precoOriginalFinal = originalNum.toFixed(2).replace(".", ",");
    }
  }

  const linhaPreco = precoOriginalFinal
    ? `De: ~R$ ${precoOriginalFinal}~\nPor: *R$ ${d.precoAtual}*`
    : `Por: *R$ ${d.precoAtual}*`;
  const extras = [
    desconto ? `🏷️ ${desconto}% OFF` : null,
    d.freteGratis ? "🚚 Frete grátis" : null,
    d.parcelas ? `💳 ${d.parcelas}` : null,
  ].filter(Boolean).join(" | ");
  return [`🔥 *${d.nome}*`, "", linhaPreco, ...(extras ? [extras] : []), "", d.linkAfiliado].join("\n");
}

export function calcularDesconto(
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

export function converterPreco(preco: string): number | null {
  const limpo = preco.replace(/[^\d,.-]/g, "").trim();
  if (!limpo) return null;

  const normalizado = limpo.includes(",")
    ? limpo.replace(/\./g, "").replace(",", ".")
    : limpo;
  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : null;
}
