import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type GroupMetadata,
  type WASocket,
} from "@whiskeysockets/baileys";
import { rm } from "node:fs/promises";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import pino from "pino";

export type EstadoConexao =
  | "inicializando"
  | "aguardando_qr"
  | "conectado"
  | "reconectando"
  | "desconectado"
  | "deslogado";

export interface StatusConexao {
  estado: EstadoConexao;
  conectado: boolean;
  qrDisponivel: boolean;
  reconexaoNecessaria: boolean;
  ultimaMudancaEm: string;
}

export interface GrupoWhatsApp {
  id: string;
  nome: string;
  participantes: number;
}

type ListenerConexao = (status: StatusConexao) => void;

const TEMPO_ENTRE_RECONEXOES_MS = 2_000;

let qrCodeAtual: string | null = null;
let qrAtualizadoEm: string | null = null;
let estadoConexao: EstadoConexao = "desconectado";
let ultimaMudancaEm = new Date().toISOString();
let sockAtual: WASocket | null = null;
let conexaoEmAndamento: Promise<WASocket> | null = null;
let reconexaoAgendada: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<ListenerConexao>();

function atualizarEstado(estado: EstadoConexao) {
  estadoConexao = estado;
  ultimaMudancaEm = new Date().toISOString();

  const status = getStatusConexao();
  for (const listener of listeners) listener(status);
}

function limparQrCode() {
  qrCodeAtual = null;
  qrAtualizadoEm = null;
}

async function criarConexao(): Promise<WASocket> {
  atualizarEstado("inicializando");

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "warn" }),
    browser: ["Loot", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: true,
  });

  sockAtual = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (sockAtual !== sock) return;

    if (qr) {
      qrCodeAtual = await QRCode.toDataURL(qr);
      if (sockAtual !== sock || estadoConexao === "conectado") return;
      qrAtualizadoEm = new Date().toISOString();
      atualizarEstado("aguardando_qr");
      console.log("QR code gerado, aguardando leitura");
    }

    if (connection === "open") {
      limparQrCode();
      atualizarEstado("conectado");
      console.log("Whatsapp conectado com sucesso!");
    }

    if (connection === "close") {
      sockAtual = null;
      limparQrCode();

      const motivoErro = (lastDisconnect?.error as Boom | undefined)?.output
        ?.statusCode;
      const foiDeslogado = motivoErro === DisconnectReason.loggedOut;
      const foiSubstituido = motivoErro === DisconnectReason.connectionReplaced;

      console.error(
        "conexão do WhatsApp fechada:",
        motivoErro ?? "código desconhecido",
        lastDisconnect?.error,
      );

      if (foiDeslogado) {
        atualizarEstado("deslogado");
        console.warn("WhatsApp deslogado; nova leitura de QR code necessária");
        return;
      }

      if (foiSubstituido) {
        atualizarEstado("desconectado");
        console.warn(
          "WhatsApp desconectado: a sessão foi substituída por outra instância; encerre a outra conexão antes de tentar novamente",
        );
        return;
      }

      atualizarEstado("reconectando");
      agendarReconexao();
    }
  });

  return sock;
}

function agendarReconexao() {
  if (reconexaoAgendada || conexaoEmAndamento) return;

  reconexaoAgendada = setTimeout(() => {
    reconexaoAgendada = null;
    void conectarWhatsApp().catch((erro: unknown) => {
      console.error("falha ao reconectar o WhatsApp:", erro);
      atualizarEstado("reconectando");
      agendarReconexao();
    });
  }, TEMPO_ENTRE_RECONEXOES_MS);
}

export function conectarWhatsApp(): Promise<WASocket> {
  if (
    sockAtual &&
    estadoConexao !== "desconectado" &&
    estadoConexao !== "deslogado"
  ) {
    return Promise.resolve(sockAtual);
  }

  if (conexaoEmAndamento) return conexaoEmAndamento;

  const tentativa = criarConexao();
  conexaoEmAndamento = tentativa;
  tentativa.then(
    () => {
      if (conexaoEmAndamento === tentativa) conexaoEmAndamento = null;
    },
    () => {
      if (conexaoEmAndamento === tentativa) {
        conexaoEmAndamento = null;
        if (estadoConexao === "inicializando") atualizarEstado("desconectado");
      }
    },
  );

  return tentativa;
}

export async function solicitarReconexao(opcoes: {
  forcarNovoQr?: boolean;
} = {}): Promise<WASocket> {
  if (reconexaoAgendada) {
    clearTimeout(reconexaoAgendada);
    reconexaoAgendada = null;
  }

  if (sockAtual && estadoConexao === "conectado") {
    return Promise.resolve(sockAtual);
  }

  if (estadoConexao === "deslogado" && !opcoes.forcarNovoQr) {
    throw new Error(
      "sessão deslogada; confirme forcarNovoQr para iniciar uma nova sessão",
    );
  }

  if (opcoes.forcarNovoQr) {
    if (sockAtual || conexaoEmAndamento) {
      throw new Error("já existe uma conexão do WhatsApp em andamento");
    }

    await rm("auth_info", { recursive: true, force: true });
    limparQrCode();
    atualizarEstado("desconectado");
  }

  return conectarWhatsApp();
}

export function getSock(): WASocket | null {
  return sockAtual;
}

export function getStatusConexao(): StatusConexao {
  return {
    estado: estadoConexao,
    conectado: estadoConexao === "conectado" && sockAtual !== null,
    qrDisponivel: qrCodeAtual !== null,
    reconexaoNecessaria: estadoConexao === "deslogado",
    ultimaMudancaEm,
  };
}

export function getQrCode() {
  return {
    qr: qrCodeAtual,
    atualizadoEm: qrAtualizadoEm,
  };
}

export function inscreverMudancasConexao(listener: ListenerConexao) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function grupoParaResposta(grupo: GroupMetadata): GrupoWhatsApp {
  return {
    id: grupo.id,
    nome: grupo.subject,
    participantes: grupo.participants?.length ?? 0,
  };
}

export async function listarGruposWhatsApp(): Promise<GrupoWhatsApp[]> {
  const sock = getSock();
  if (!sock || getStatusConexao().estado !== "conectado") {
    throw new Error("WhatsApp não está conectado");
  }

  const grupos = await sock.groupFetchAllParticipating();
  return Object.values(grupos)
    .map(grupoParaResposta)
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}
