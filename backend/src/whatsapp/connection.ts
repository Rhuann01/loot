import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import pino from "pino";

let qrCodeAtual: string | null = null;
let statusConexao: "aguardando_qr" | "conectado" | "desconectado" =
  "aguardando_qr";
let sockAtual: WASocket | null = null;

export async function conectarWhatsApp(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Loot", "Chrome", "1.0.0"],
  });

  sockAtual = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeAtual = await QRCode.toDataURL(qr);
      statusConexao = "aguardando_qr";
      console.log("QR code gerado, aguardando leitura");

      const qrcodeTerminal = await import("qrcode-terminal");
      qrcodeTerminal.default.generate(qr, { small: true });
    }

    if (connection === "open") {
      qrCodeAtual = null;
      statusConexao = "conectado";
      console.log("Whatsapp conectado com sucesso!");
    }

    if (connection === "close") {
      statusConexao = "desconectado";
      const motivoErro = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const deveReconectar = motivoErro !== DisconnectReason.loggedOut;

      console.log("conexão fechada, reconectar?", deveReconectar);

      if (deveReconectar) {
        conectarWhatsApp();
      }
    }
  });

  return sock;
}

export function getSock(): WASocket | null {
  return sockAtual;
}

export function getStatusConexao() {
  return { qr: qrCodeAtual, status: statusConexao };
}
