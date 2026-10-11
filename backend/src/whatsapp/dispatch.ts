import { randomUUID } from "node:crypto";
import {
  adquirirLockExecucao,
  liberarLockExecucao,
  getConfig,
  renovarLockExecucao,
  setConfig,
} from "../db/queries.js";

const DURACAO_LOCK_MS = 30_000;
const ESPERA_LOCK_MS = 25;

interface ContextoEnvioProtegido {
  aguardarIntervaloAntesDaMensagem(): Promise<void>;
}

function intervaloEntreMensagensMs(): number {
  const valor = Number(getConfig("intervalo_entre_mensagens_ms") ?? 3000);
  return Number.isInteger(valor) && valor >= 0 ? valor : 3000;
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function comLock<T>(
  nome: string,
  esperarPeloLock: boolean,
  acao: (garantirLockAtivo: () => void) => Promise<T>,
): Promise<T | undefined> {
  const token = randomUUID();
  while (!adquirirLockExecucao(nome, token, DURACAO_LOCK_MS)) {
    if (!esperarPeloLock) return undefined;
    await esperar(ESPERA_LOCK_MS);
  }

  let lockPerdido = false;
  const garantirLockAtivo = () => {
    if (lockPerdido) throw new Error("lock de envio perdido");
  };
  const renovacao = setInterval(
    () => {
      if (!renovarLockExecucao(nome, token, DURACAO_LOCK_MS)) {
        lockPerdido = true;
      }
    },
    Math.floor(DURACAO_LOCK_MS / 2),
  );
  try {
    return await acao(garantirLockAtivo);
  } finally {
    clearInterval(renovacao);
    liberarLockExecucao(nome, token);
  }
}

export async function executarEnvioProtegido<T>(
  acao: (contexto: ContextoEnvioProtegido) => Promise<T>,
): Promise<T> {
  const resultado = await comLock("whatsapp_envio", true, async (garantirLockAtivo) => {
    const aguardarIntervaloAntesDaMensagem = async () => {
      garantirLockAtivo();
      const ultimoEnvio = Number(
        getConfig("whatsapp_ultima_mensagem_em_ms") ?? "0",
      );
      const esperaRestante = Math.max(
        0,
        ultimoEnvio + intervaloEntreMensagensMs() - Date.now(),
      );
      if (esperaRestante > 0) await esperar(esperaRestante);
      garantirLockAtivo();
      setConfig("whatsapp_ultima_mensagem_em_ms", String(Date.now()));
    };
    return acao({ aguardarIntervaloAntesDaMensagem });
  });
  return resultado as T;
}

export async function tentarExecutarLoteAutomatico<T>(
  acao: () => Promise<T>,
): Promise<T | undefined> {
  return comLock("lote_automatico", false, () => acao());
}
