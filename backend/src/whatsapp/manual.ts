import {
  atualizarPrecoProduto,
  buscarTentativaEnvioPorId,
  getConfig,
  iniciarEnvioManualIdempotente,
  marcarComoEnviado,
  marcarEnvioAmbiguo,
  marcarFalhaEnvio,
  gravarSnapshotTentativa,
  gravarAtividade,
  type TentativaEnvio,
} from "../db/queries.js";
import { executarEnvioProtegido } from "./dispatch.js";
import { enviarProduto, montarMensagemDoProduto } from "./sender.js";
import { temAffiliateProvider } from "../integrations/registry.js";
import {
  consultarOfertaShopeePorItem,
  decidirRecheca,
  extrairItemIdShopee,
  precosDaOfertaAtual,
} from "../integrations/shopee/source.js";

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

export type ResultadoRechecaManual = Awaited<
  ReturnType<typeof consultarOfertaShopeePorItem>
>;
export type ConsultaPrecoManual = (
  itemId: string,
) => Promise<ResultadoRechecaManual>;

export async function reenviarManualIdempotente(
  produtoId: number,
  chave: string,
  enviar: typeof enviarProduto = enviarProduto,
  consultarPreco: ConsultaPrecoManual = consultarOfertaShopeePorItem,
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
      temAffiliateProvider(produto.source_key) &&
      (!produto.link_afiliado.trim() || produto.link_afiliado === produto.link_original)
    ) {
      marcarFalhaEnvio(
        produto.id,
        "Link afiliado ausente ou igual ao link original.",
        tentativa.id,
        true,
      );
      return "failed";
    }

    let precoAtualEnvio = produto.preco_atual;
    let precoOriginalEnvio = produto.preco_original;
    let descontoEnvio: number | null | undefined = produto.desconto_percentual;

    if (produto.source_key === "shopee") {
      const itemId = extrairItemIdShopee(produto.external_product_id);
      let atual: ResultadoRechecaManual;
      try {
        if (!itemId) throw new Error("Identificador Shopee inválido");
        atual = await consultarPreco(itemId);
      } catch (erro) {
        marcarFalhaEnvio(
          produto.id,
          `Não foi possível conferir o preço agora: ${
            erro instanceof Error ? erro.message : String(erro)
          }`,
          tentativa.id,
          true,
        );
        return "failed";
      }

      const descontoMinimo = Math.max(
        0,
        Number(getConfig("desconto_minimo_global") ?? 20) || 0,
      );
      const decisao = decidirRecheca(produto.preco_atual, atual, descontoMinimo);
      if (!decisao.enviar) {
        if (atual) atualizarPrecoProduto(produto.id, precosDaOfertaAtual(atual));
        marcarFalhaEnvio(
          produto.id,
          `Recheca Shopee: ${decisao.motivo}`,
          tentativa.id,
          true,
        );
        gravarAtividade({
          tipo: "recheca_descarte",
          integracao_key: "shopee",
          produto_id: produto.id,
          tentativa_id: tentativa.id,
          titulo: "Produto descartado pela recheca Shopee",
          detalhe: decisao.motivo,
        });
        return "failed";
      }
      descontoEnvio = decisao.descontoPercentual;
      const novos = precosDaOfertaAtual({
        precoAtual: decisao.precoAtual,
        descontoPercentual: decisao.descontoPercentual,
      });
      precoOriginalEnvio = novos.preco_original;
      if (novos.preco_atual !== produto.preco_atual) {
        atualizarPrecoProduto(produto.id, novos);
        precoAtualEnvio = novos.preco_atual;
      }
    }

    try {
      const dadosEnvio = {
        nome: produto.nome,
        preco_atual: precoAtualEnvio,
        preco_original: precoOriginalEnvio,
        descontoPercentual: descontoEnvio,
        link_afiliado: produto.link_afiliado,
        imagem_url: produto.imagem_url,
      };
      gravarSnapshotTentativa(tentativa.id, {
        mensagem: montarMensagemDoProduto(dadosEnvio),
        destinoId: getConfig("whatsapp_grupo_id") || null,
        destinoNome: getConfig("whatsapp_grupo_nome") || null,
        plataforma: produto.source_key,
        titulo: produto.nome,
        urlOriginal: produto.link_original,
      });
      await aguardarIntervaloAntesDaMensagem();
      await enviar(dadosEnvio);
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
