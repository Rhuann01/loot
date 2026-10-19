import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
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
let codigoPareamentoAtual: string | null = null;
let codigoPareamentoGeradoEm: string | null = null;
let telefonePareamentoAtual: string | null = null;
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

export function limparCodigoPareamento() {
  codigoPareamentoAtual = null;
  codigoPareamentoGeradoEm = null;
  telefonePareamentoAtual = null;
}

async function criarConexao(): Promise<WASocket> {
  atualizarEstado("inicializando");

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: false,
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
      limparCodigoPareamento();
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

      const erroMsg = (lastDisconnect?.error as Error)?.message ?? "erro de conexão";
      console.error("conexão fechada:", erroMsg);

      if (foiDeslogado) {
        limparCodigoPareamento();
        atualizarEstado("deslogado");
        console.warn("WhatsApp deslogado; nova leitura de QR code necessária");
        return;
      }

      if (foiSubstituido) {
        limparCodigoPareamento();
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
    const sockParaEncerrar = sockAtual;
    sockAtual = null;
    conexaoEmAndamento = null;

    if (sockParaEncerrar) {
      try {
        sockParaEncerrar.end(undefined);
      } catch {
        // silencioso
      }
    }

    await rm("auth_info", { recursive: true, force: true });
    limparQrCode();
    limparCodigoPareamento();
    atualizarEstado("desconectado");
  }

  return conectarWhatsApp();
}

export async function desconectarWhatsApp(): Promise<void> {
  if (reconexaoAgendada) {
    clearTimeout(reconexaoAgendada);
    reconexaoAgendada = null;
  }

  const sockParaEncerrar = sockAtual;
  sockAtual = null;
  conexaoEmAndamento = null;

  if (sockParaEncerrar) {
    try {
      await sockParaEncerrar.logout();
    } catch {
      try {
        sockParaEncerrar.end(undefined);
      } catch {
        // silencioso se o socket já estiver fechado
      }
    }
  }

  await rm("auth_info", { recursive: true, force: true });
  limparQrCode();
  limparCodigoPareamento();
  atualizarEstado("desconectado");
}

export function normalizarTelefoneParaPareamento(telefone: string): string {
  let digits = telefone.replace(/\D/g, "");
  if (!digits) {
    throw new Error("Número de telefone não informado");
  }
  if (digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  if (digits.startsWith("5555")) {
    digits = digits.slice(2);
  }
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    return digits;
  }
  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`;
  }
  if (digits.length < 10 || digits.length > 15) {
    throw new Error("Número de telefone inválido. Informe o DDD e o número com 10 ou 11 dígitos.");
  }
  return digits;
}

export function formatarCodigoPareamento(codigo: string): string {
  const limpo = codigo.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (limpo.length === 8) {
    return `${limpo.slice(0, 4)}-${limpo.slice(4)}`;
  }
  return codigo;
}

export type SolicitadorCodigoPareamento = (telefone: string) => Promise<string>;
let solicitadorCodigoCustom: SolicitadorCodigoPareamento | null = null;
export function definirSolicitadorCodigoParaTeste(fn: SolicitadorCodigoPareamento | null) {
  solicitadorCodigoCustom = fn;
}

export async function solicitarCodigoPareamento(telefone: string): Promise<string> {
  if (solicitadorCodigoCustom) {
    return solicitadorCodigoCustom(telefone);
  }

  const numeroNormalizado = normalizarTelefoneParaPareamento(telefone);

  if (reconexaoAgendada) {
    clearTimeout(reconexaoAgendada);
    reconexaoAgendada = null;
  }

  const sockAntigo = sockAtual;
  sockAtual = null;
  conexaoEmAndamento = null;
  if (sockAntigo) {
    try {
      sockAntigo.end(undefined);
    } catch {}
  }

  await rm("auth_info", { recursive: true, force: true });
  limparQrCode();
  limparCodigoPareamento();
  atualizarEstado("desconectado");

  const sock = await conectarWhatsApp();

  // Aguarda o socket WebSocket abrir completamente antes de pedir o código (até 8s)
  const inicio = Date.now();
  while (!sock.ws?.isOpen && Date.now() - inicio < 8000) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Pequena pausa para garantir estabilidade da sessão
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (sock.authState.creds.registered) {
    throw new Error("O WhatsApp já está registrado. Desconecte antes de pedir novo código.");
  }

  console.log(`[WhatsApp Pairing] Solicitando código para ${numeroNormalizado}...`);
  try {
    const rawCode = await sock.requestPairingCode(numeroNormalizado);
    const formatado = formatarCodigoPareamento(rawCode);
    codigoPareamentoAtual = formatado;
    codigoPareamentoGeradoEm = new Date().toISOString();
    telefonePareamentoAtual = numeroNormalizado;
    atualizarEstado("aguardando_qr");
    console.log(`[WhatsApp Pairing] Código gerado com sucesso: ${formatado}`);
    return formatado;
  } catch (erro) {
    console.error("[WhatsApp Pairing] Erro ao solicitar código no Baileys:", erro);
    throw erro;
  }
}

export function getCodigoPareamento() {
  return {
    codigo: codigoPareamentoAtual,
    atualizadoEm: codigoPareamentoGeradoEm,
    telefone: telefonePareamentoAtual,
  };
}

export function getSock(): WASocket | null {
  return sockAtual;
}

export type ListadorGruposWhatsApp = () => Promise<GrupoWhatsApp[]>;
let listadorGruposCustom: ListadorGruposWhatsApp | null = null;
export function definirListadorGruposParaTeste(fn: ListadorGruposWhatsApp | null) {
  listadorGruposCustom = fn;
}

export type ConsultorStatusConexao = () => StatusConexao;
let consultorStatusCustom: ConsultorStatusConexao | null = null;
export function definirStatusConexaoParaTeste(fn: ConsultorStatusConexao | null) {
  consultorStatusCustom = fn;
}

export function getNumeroConectado(): string | null {
  if (sockAtual?.user?.id) {
    const raw = sockAtual.user.id.split(":")[0]?.replace(/\D/g, "");
    return raw || null;
  }
  return null;
}

export function getStatusConexao(): StatusConexao {
  if (consultorStatusCustom) {
    return consultorStatusCustom();
  }
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
  if (listadorGruposCustom) {
    return listadorGruposCustom();
  }
  const sock = getSock();
  if (!sock || getStatusConexao().estado !== "conectado") {
    throw new Error("WhatsApp não está conectado");
  }

  const grupos = await sock.groupFetchAllParticipating();
  return Object.values(grupos)
    .map(grupoParaResposta)
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}
