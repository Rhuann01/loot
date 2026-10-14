import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { coletores, getAffiliateProvider, temAffiliateProvider } from "../integrations/registry.js";
import type { IntegrationKey } from "../integrations/types.js";
import {
  getConfig,
  marcarComoEnviado,
  marcarEnvioAmbiguo,
  marcarFalhaEnvio,
  recuperarEnviosAbandonados,
  reservarProdutoParaEnvioComTentativa,
  setConfig,
  integracaoEstaAtiva,
  atualizarLinkAfiliadoPorFonte,
  type Produto,
  atualizarPrecoProduto,
  esgotarTentativasProduto,
  cancelarReservaSemConsumirTentativa,
} from "../db/queries.js";
import {
  consultarOfertaShopeePorItem,
  decidirRecheca,
  extrairItemIdShopee,
  precosDaOfertaAtual,
  type DecisaoRecheca,
  type OfertaAtualShopee,
} from "../integrations/shopee/source.js";
import { enviarProduto } from "../whatsapp/sender.js";
import {
  executarEnvioProtegido,
  tentarExecutarLoteAutomatico,
} from "../whatsapp/dispatch.js";

export interface ResultadoRecheca {
  decisao: DecisaoRecheca;
  atual: OfertaAtualShopee | null;
}

// Pode lançar erro se a consulta falhar (rede/API).
export type Rechecador = (produto: Produto) => Promise<ResultadoRecheca>;

async function rechecarShopee(produto: Produto): Promise<ResultadoRecheca> {
  const itemId = extrairItemIdShopee(produto.external_product_id);
  if (!itemId) {
    return {
      decisao: { enviar: false, motivo: "Identificador Shopee inválido" },
      atual: null,
    };
  }
  const atual = await consultarOfertaShopeePorItem(itemId);
  const descontoMinimo = Math.max(
    0,
    Number(getConfig("desconto_minimo_global") ?? 20) || 0,
  );
  return {
    decisao: decidirRecheca(produto.preco_atual, atual, descontoMinimo),
    atual,
  };
}

export async function enviarLote(
  quantidade: number,
  enviar: typeof enviarProduto = enviarProduto,
  rechecar: Rechecador = rechecarShopee,
) {
  for (let i = 0; i < quantidade; i++) {
    if (getConfig("auto_envio_ativo") !== "true") {
      console.log("limite diário atingido ou auto-envio desligado, parando");
      break;
    }

    const resultado = await executarEnvioProtegido<
      "enviado" | "descartado" | "parar"
    >(async ({ aguardarIntervaloAntesDaMensagem }) => {
      if (getConfig("auto_envio_ativo") !== "true") return "parar";
      const reserva = reservarProdutoParaEnvioComTentativa();
      if (!reserva) return "parar";
      const { produto, tentativa } = reserva;

      try {
        let linkAfiliado = produto.link_afiliado;

        const precisaGerarLink =
          temAffiliateProvider(produto.source_key) &&
          (!produto.link_afiliado.trim() ||
            produto.link_afiliado === produto.link_original);

        if (precisaGerarLink) {
          try {
            const linkOriginal = produto.link_original;
            if (!linkOriginal)
              throw new Error("URL original do produto ausente");
            const linkGerado = await getAffiliateProvider(
              produto.source_key as IntegrationKey,
            ).generateLink(linkOriginal);

            if (!linkGerado.trim() || linkGerado === linkOriginal) {
              throw new Error("O provedor retornou um link afiliado inválido");
            }

            linkAfiliado = linkGerado;
            atualizarLinkAfiliadoPorFonte(
              produto.source_key,
              produto.external_product_id,
              linkAfiliado,
            );
          } catch (erro) {
            const mensagemErro = `Falha ao gerar link afiliado: ${
              erro instanceof Error ? erro.message : String(erro)
            }`;
            console.warn(
              `não foi possível gerar link afiliado para ${produto.id}; envio interrompido`,
            );
            marcarFalhaEnvio(produto.id, mensagemErro, tentativa.id);
            return "parar";
          }
        }

        // NOVO: recheca de preço (somente Shopee)
        let precoAtualEnvio = produto.preco_atual;
        let precoOriginalEnvio = produto.preco_original;

        if (produto.source_key === "shopee") {
          let resultadoRecheca: ResultadoRecheca;
          try {
            resultadoRecheca = await rechecar(produto);
          } catch (erro) {
            const motivo = `Recheca de preço indisponível: ${
              erro instanceof Error ? erro.message : String(erro)
            }`;
            console.warn(
              `scheduler: recheca da Shopee falhou para ${produto.id}; produto devolvido à fila`,
            );
            cancelarReservaSemConsumirTentativa(
              produto.id,
              tentativa.id,
              motivo,
            );
            return "parar";
          }

          const { decisao, atual } = resultadoRecheca;
          if (!decisao.enviar) {
            if (atual) {
              atualizarPrecoProduto(produto.id, precosDaOfertaAtual(atual));
            }
            marcarFalhaEnvio(
              produto.id,
              `Recheca Shopee: ${decisao.motivo}`,
              tentativa.id,
            );
            if (!atual) esgotarTentativasProduto(produto.id);
            console.log(
              `scheduler: ${produto.id} descartado pela recheca (${decisao.motivo})`,
            );
            return "descartado";
          }

          const novos = precosDaOfertaAtual({
            precoAtual: decisao.precoAtual,
            descontoPercentual: decisao.descontoPercentual,
          });
          if (novos.preco_atual !== produto.preco_atual) {
            atualizarPrecoProduto(produto.id, novos);
            precoAtualEnvio = novos.preco_atual;
            precoOriginalEnvio = novos.preco_original;
          }
        }

        await aguardarIntervaloAntesDaMensagem();
        await enviar({
          nome: produto.nome,
          preco_atual: precoAtualEnvio,
          preco_original: precoOriginalEnvio,
          link_afiliado: linkAfiliado,
          imagem_url: produto.imagem_url,
        });
      } catch (erro) {
        const mensagemErro =
          erro instanceof Error ? erro.message : String(erro);
        if (mensagemErro === "WhatsApp não está conectado") {
          marcarFalhaEnvio(produto.id, mensagemErro, tentativa.id);
        } else {
          marcarEnvioAmbiguo(produto.id, mensagemErro, tentativa.id);
        }
        return "parar";
      }

      marcarComoEnviado(produto.id, tentativa.id);
      console.log(`enviado: ${produto.nome}`);
      return "enviado";
    });
    if (resultado === "parar") break;
  }
}

export interface ConfigScheduler {
  ativo: boolean;
  horarios: string[];
  limite_diario: number;
  /** Mantido para compatibilidade com o frontend atual; não controla mais a distribuição. */
  quantidade_por_execucao: number;
  intervalo_entre_mensagens_ms: number;
}

export const MAX_HORARIOS_SCHEDULER = 4;

let tarefas: ScheduledTask[] = [];
let execucaoEmAndamento = false;
let ultimaExecucaoEm: string | null = null;

function lerHorarios(): string[] {
  try {
    const horarios = JSON.parse(getConfig("horarios_envio") ?? "[]");
    return Array.isArray(horarios)
      ? horarios
          .filter((horario): horario is string => typeof horario === "string")
          .slice(0, MAX_HORARIOS_SCHEDULER)
      : [];
  } catch {
    return [];
  }
}

export function obterConfigScheduler(): ConfigScheduler {
  return {
    ativo: getConfig("auto_envio_ativo") === "true",
    horarios: lerHorarios(),
    limite_diario: Number(getConfig("limite_diario") ?? 12),
    quantidade_por_execucao: Number(getConfig("quantidade_por_execucao") ?? 3),
    intervalo_entre_mensagens_ms: Number(
      getConfig("intervalo_entre_mensagens_ms") ?? 3000,
    ),
  };
}

function quantidadeDoHorario(
  totalDiario: number,
  indiceHorario: number,
  totalHorarios: number,
): number {
  const base = Math.floor(totalDiario / totalHorarios);
  const sobras = totalDiario % totalHorarios;
  return base + (indiceHorario < sobras ? 1 : 0);
}

export function obterEstadoScheduler() {
  return {
    ...obterConfigScheduler(),
    execucao_em_andamento: execucaoEmAndamento,
    ultima_execucao_em: ultimaExecucaoEm,
    tarefas_ativas: tarefas.length,
  };
}

function horarioParaCron(horario: string): string {
  const [hora, minuto] = horario.split(":").map(Number);
  return `${minuto} ${hora} * * *`;
}

function pararTarefas() {
  for (const tarefa of tarefas) tarefa.stop();
  tarefas = [];
}

export function recarregarScheduler() {
  pararTarefas();

  const config = obterConfigScheduler();
  if (!config.ativo || config.horarios.length === 0) return;

  tarefas = config.horarios.map((horario, indice) =>
    cron.schedule(horarioParaCron(horario), async () => {
      if (!obterConfigScheduler().ativo) {
        console.log("scheduler: execução ignorada porque está desativado");
        return;
      }

      if (execucaoEmAndamento) {
        console.warn("scheduler: execução anterior ainda está em andamento");
        return;
      }

      execucaoEmAndamento = true;
      ultimaExecucaoEm = new Date().toISOString();
      console.log(`scheduler: executando envio das ${horario}`);

      try {
        const executou = await tentarExecutarLoteAutomatico(async () => {
          recuperarEnviosAbandonados();
          const configAtual = obterConfigScheduler();

          // A coleta atualiza o estoque, mas não pode impedir os envios.
          // Cada loja é independente: a falha de uma não bloqueia a outra.
          // Shopee coleta em todos os horários (preço fresco, 2 requisições);
          // as demais lojas (custo de Apify) coletam só no primeiro horário.
          {
            for (const { key, coletar } of coletores) {
              if (key !== "shopee" && indice !== 0) continue;
              if (!integracaoEstaAtiva(key)) {
                console.log(
                  `scheduler: coleta de ${key} ignorada porque a integração está desativada`,
                );
                continue;
              }
              try {
                const salvas = await coletar();
                if (salvas === 0) {
                  console.warn(
                    `scheduler: ${key} não retornou ofertas válidas; usando pendências armazenadas`,
                  );
                }
              } catch (erro) {
                console.error(
                  `scheduler: falha na coleta de ${key}; usando pendências armazenadas`,
                  erro,
                );
              }
            }
          }

          try {
            if (obterConfigScheduler().ativo) {
              await enviarLote(
                quantidadeDoHorario(
                  configAtual.limite_diario,
                  indice,
                  configAtual.horarios.length,
                ),
              );
            } else {
              console.log("scheduler: envio cancelado antes do início do lote");
            }
          } catch (erro) {
            console.error("scheduler: falha no lote de envio", erro);
          }
        });
        if (executou === undefined) {
          console.warn("scheduler: outro processo já está executando o lote");
        }
      } finally {
        execucaoEmAndamento = false;
      }
    }),
  );
}

export function salvarConfigScheduler(config: ConfigScheduler) {
  if (config.horarios.length > MAX_HORARIOS_SCHEDULER) {
    throw new Error(
      `o scheduler aceita no máximo ${MAX_HORARIOS_SCHEDULER} horários`,
    );
  }
  setConfig("auto_envio_ativo", String(config.ativo));
  setConfig("horarios_envio", JSON.stringify(config.horarios));
  setConfig("limite_diario", String(config.limite_diario));
  setConfig("quantidade_por_execucao", String(config.quantidade_por_execucao));
  setConfig(
    "intervalo_entre_mensagens_ms",
    String(config.intervalo_entre_mensagens_ms),
  );
  recarregarScheduler();
}

export function iniciarScheduler() {
  recuperarEnviosAbandonados();
  recarregarScheduler();
}
