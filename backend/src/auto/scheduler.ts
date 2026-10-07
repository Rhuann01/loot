import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { processarESalvarOfertas } from "../scraper/mercadolivre.js";
import { getAffiliateProvider } from "../integrations/registry.js";
import {
  getConfig,
  liberarReservaEnvio,
  marcarComoEnviado,
  marcarEnvioAmbiguo,
  marcarFalhaEnvio,
  podeEnviarMais,
  reservarProdutoParaEnvio,
  setConfig,
  integracaoEstaAtiva,
  atualizarLinkAfiliado,
} from "../db/queries.js";
import { enviarProduto } from "../whatsapp/sender.js";

async function enviarLote(quantidade: number) {
  for (let i = 0; i < quantidade; i++) {
    if (getConfig("auto_envio_ativo") !== "true" || !podeEnviarMais()) {
      console.log("limite diário atingido ou auto-envio desligado, parando");
      break;
    }

    const produto = reservarProdutoParaEnvio();

    if (!produto) {
      console.log("nenhum produto novo pra enviar");
      break;
    }

    if (getConfig("auto_envio_ativo") !== "true") {
      console.log("scheduler: envio interrompido porque foi desativado");
      liberarReservaEnvio(produto.id);
      break;
    }

    try {
      let linkAfiliado = produto.link_afiliado;
      const precisaGerarLink =
        produto.source_key === "mercado_livre" &&
        produto.link_original &&
        produto.link_afiliado === produto.link_original;

      if (precisaGerarLink) {
        try {
          const linkOriginal = produto.link_original;
          if (!linkOriginal) throw new Error("URL original do produto ausente");

          console.log(`gerando link afiliado para o produto ${produto.id} no envio`);
          linkAfiliado = await getAffiliateProvider("mercado_livre").generateLink(
            linkOriginal,
          );
          atualizarLinkAfiliado(produto.external_product_id, linkAfiliado);
        } catch (erro) {
          console.warn(
            `não foi possível gerar link afiliado para ${produto.id}; usando o link original`,
            erro,
          );
        }
      }

      await enviarProduto({
        nome: produto.nome,
        preco_atual: produto.preco_atual,
        preco_original: produto.preco_original,
        link_afiliado: linkAfiliado,
        imagem_url: produto.imagem_url,
      });
    } catch (erro) {
      console.error(
        `falha ao enviar produto ${produto.id}; ele continuará pendente`,
        erro,
      );
      const mensagemErro = erro instanceof Error ? erro.message : String(erro);
      if (mensagemErro === "WhatsApp não está conectado") {
        marcarFalhaEnvio(produto.id, mensagemErro);
      } else {
        // Sem confirmação do WhatsApp, repetir pode duplicar uma mensagem aceita.
        marcarEnvioAmbiguo(produto.id, mensagemErro);
      }
      break;
    }

    marcarComoEnviado(produto.id);
    console.log(`enviado: ${produto.nome}`);
  }
}

export interface ConfigScheduler {
  ativo: boolean;
  horarios: string[];
  limite_diario: number;
  /** Mantido para compatibilidade com o frontend atual; não controla mais a distribuição. */
  quantidade_por_execucao: number;
}

export const MAX_HORARIOS_SCHEDULER = 4;

let tarefas: ScheduledTask[] = [];
let execucaoEmAndamento = false;
let ultimaExecucaoEm: string | null = null;

function lerHorarios(): string[] {
  try {
    const horarios = JSON.parse(getConfig("horarios_envio") ?? "[]");
    return Array.isArray(horarios)
      ? horarios.filter((horario): horario is string => typeof horario === "string").slice(0, MAX_HORARIOS_SCHEDULER)
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
        const configAtual = obterConfigScheduler();

        // A coleta atualiza o estoque, mas não pode impedir os envios.
        if (indice === 0 && integracaoEstaAtiva("mercado_livre")) {
          try {
            const salvas = await processarESalvarOfertas();
            if (salvas === 0) {
              console.warn(
                "scheduler: Apify não retornou ofertas válidas; usando pendências armazenadas",
              );
            }
          } catch (erro) {
            console.error(
              "scheduler: falha na coleta do Apify; usando pendências armazenadas",
              erro,
            );
          }
        } else if (indice === 0) {
          console.log("scheduler: coleta do Mercado Livre ignorada porque a integração está desativada");
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
      } finally {
        execucaoEmAndamento = false;
      }
    }),
  );
}

export function salvarConfigScheduler(config: ConfigScheduler) {
  if (config.horarios.length > MAX_HORARIOS_SCHEDULER) {
    throw new Error(`o scheduler aceita no máximo ${MAX_HORARIOS_SCHEDULER} horários`);
  }
  setConfig("auto_envio_ativo", String(config.ativo));
  setConfig("horarios_envio", JSON.stringify(config.horarios));
  setConfig("limite_diario", String(config.limite_diario));
  setConfig("quantidade_por_execucao", String(config.quantidade_por_execucao));
  recarregarScheduler();
}

export function iniciarScheduler() {
  recarregarScheduler();
}
