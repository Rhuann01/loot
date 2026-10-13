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
} from "../db/queries.js";
import { enviarProduto } from "../whatsapp/sender.js";
import {
  executarEnvioProtegido,
  tentarExecutarLoteAutomatico,
} from "../whatsapp/dispatch.js";

export async function enviarLote(
  quantidade: number,
  enviar: typeof enviarProduto = enviarProduto,
) {
  for (let i = 0; i < quantidade; i++) {
    if (getConfig("auto_envio_ativo") !== "true") {
      console.log("limite diário atingido ou auto-envio desligado, parando");
      break;
    }

    const enviado = await executarEnvioProtegido(
      async ({ aguardarIntervaloAntesDaMensagem }) => {
        if (getConfig("auto_envio_ativo") !== "true") return false;
        const reserva = reservarProdutoParaEnvioComTentativa();
        if (!reserva) return false;
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
                throw new Error(
                  "O provedor retornou um link afiliado inválido",
                );
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
              return false;
            }
          }

          await aguardarIntervaloAntesDaMensagem();
          await enviar({
            nome: produto.nome,
            preco_atual: produto.preco_atual,
            preco_original: produto.preco_original,
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
          return false;
        }

        marcarComoEnviado(produto.id, tentativa.id);
        console.log(`enviado: ${produto.nome}`);
        return true;
      },
    );
    if (!enviado) break;
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
          if (indice === 0) {
            for (const { key, coletar } of coletores) {
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
