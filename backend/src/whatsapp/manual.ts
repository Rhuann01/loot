import {
  buscarTentativaEnvioPorId,
  iniciarEnvioManualIdempotente,
  marcarComoEnviado,
  marcarEnvioAmbiguo,
  marcarFalhaEnvio,
  type TentativaEnvio,
} from "../db/queries.js";
import { executarEnvioProtegido } from "./dispatch.js";
import { enviarProduto } from "./sender.js";

export type ResultadoReenvioManual =
  | "sent"
  | "sending"
  | "failed"
  | "ambiguous"
  | "conflito"
  | "ausente";

export function statusHttpReenvioManual(resultado: ResultadoReenvioManual): number {
  switch (resultado) {
    case "sent":
      return 200;
    case "sending":
      return 202;
    case "conflito":
      return 409;
    case "ausente":
      return 404;
    case "failed":
    case "ambiguous":
      return 502;
  }
}

function resultadoDaTentativa(tentativa: TentativaEnvio): ResultadoReenvioManual {
  return tentativa.status === "cancelled" ? "ambiguous" : tentativa.status;
}

export async function reenviarManualIdempotente(
  produtoId: number,
  chave: string,
  enviar: typeof enviarProduto = enviarProduto,
): Promise<ResultadoReenvioManual> {
  const inicio = iniciarEnvioManualIdempotente(produtoId, chave);
  if (inicio.tipo === "conflito" || inicio.tipo === "ausente") return inicio.tipo;
  if (inicio.tipo === "existente") return resultadoDaTentativa(inicio.tentativa);

  const { produto, tentativa } = inicio.reserva;
  return executarEnvioProtegido(async ({ aguardarIntervaloAntesDaMensagem }) => {
    const tentativaAtual = buscarTentativaEnvioPorId(tentativa.id);
    if (!tentativaAtual) return "ambiguous";
    if (tentativaAtual.status !== "sending") return resultadoDaTentativa(tentativaAtual);

    if (
      produto.source_key === "mercado_livre" &&
      (!produto.link_afiliado.trim() || produto.link_afiliado === produto.link_original)
    ) {
      marcarFalhaEnvio(
        produto.id,
        "Link afiliado do Mercado Livre ausente ou igual ao link original.",
        tentativa.id,
        true,
      );
      return "failed";
    }

    try {
      await aguardarIntervaloAntesDaMensagem();
      await enviar({
        nome: produto.nome,
        preco_atual: produto.preco_atual,
        preco_original: produto.preco_original,
        link_afiliado: produto.link_afiliado,
        imagem_url: produto.imagem_url,
      });
      marcarComoEnviado(produto.id, tentativa.id);
      return "sent";
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      if (mensagem === "WhatsApp não está conectado") {
        marcarFalhaEnvio(produto.id, mensagem, tentativa.id, true);
        return "failed";
      }
      marcarEnvioAmbiguo(produto.id, mensagem, tentativa.id);
      return "ambiguous";
    }
  });
}
