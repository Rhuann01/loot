import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import { enviarErro } from "./respostas.js";

function criarLimitador(opcoes: {
  janelaMs: number;
  max: number;
  mensagem: string;
  skipInTests?: boolean;
  skipSuccessfulRequests?: boolean;
}) {
  return rateLimit({
    windowMs: opcoes.janelaMs,
    limit: opcoes.max,
    ...(opcoes.skipSuccessfulRequests !== undefined ? { skipSuccessfulRequests: opcoes.skipSuccessfulRequests } : {}),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (_req) => {
      // Pula limitador geral em testes automatizados para evitar false positives na suíte de testes
      if (opcoes.skipInTests && process.env.NODE_ENV === "test") {
        return true;
      }
      return false;
    },
    handler: (_req: Request, res: Response) => {
      enviarErro(res, 429, "MUITAS_REQUISICOES", opcoes.mensagem);
    },
  });
}

// 1. Login: 5 tentativas em 15 minutos (NUNCA pula em teste para permitir testar o 429)
export const authLimiter = criarLimitador({
  janelaMs: 15 * 60 * 1000,
  max: 5,
  mensagem: "Muitas tentativas de login. Aguarde 15 minutos.",
  skipSuccessfulRequests: true,
});

// 2. WhatsApp Reconnect: 3 tentativas em 5 minutos
export const whatsappReconnectLimiter = criarLimitador({
  janelaMs: 5 * 60 * 1000,
  max: 3,
  mensagem: "Muitas tentativas de reconexão do WhatsApp. Aguarde alguns minutos.",
  skipInTests: true,
});

// 3. WhatsApp Teste: 3 disparos por minuto
export const whatsappTestLimiter = criarLimitador({
  janelaMs: 60 * 1000,
  max: 3,
  mensagem: "Limite de envio de testes atingido. Aguarde 1 minuto.",
  skipInTests: true,
});

// 4. WhatsApp SSE: 5 conexões por minuto
export const whatsappEventsLimiter = criarLimitador({
  janelaMs: 60 * 1000,
  max: 5,
  mensagem: "Muitas tentativas de conexão em tempo real.",
  skipInTests: true,
});

// 5. Envios Manuais e Reenvios: 5 requisições por minuto
export const sendsLimiter = criarLimitador({
  janelaMs: 60 * 1000,
  max: 5,
  mensagem: "Muitos envios solicitados. Aguarde 1 minuto.",
  skipInTests: true,
});

// 6. Scraping e Resolução de Links: 15 requisições por minuto
export const scrapingLimiter = criarLimitador({
  janelaMs: 60 * 1000,
  max: 15,
  mensagem: "Muitas consultas de produtos externas. Aguarde um momento.",
  skipInTests: true,
});

// 7. Sincronização de Plataformas: 2 requisições por minuto
export const syncLimiter = criarLimitador({
  janelaMs: 60 * 1000,
  max: 2,
  mensagem: "Sincronização em andamento ou solicitada com muita frequência.",
  skipInTests: true,
});

// 8. Configurações: 30 requisições por minuto
export const settingsLimiter = criarLimitador({
  janelaMs: 60 * 1000,
  max: 30,
  mensagem: "Muitas alterações de configuração solicitadas.",
  skipInTests: true,
});

// 9. Leitura Geral do Painel: 120 requisições por minuto
export const generalLimiter = criarLimitador({
  janelaMs: 60 * 1000,
  max: 120,
  mensagem: "Limite de requisições excedido. Tente novamente em instantes.",
  skipInTests: true,
});

// 10. Healthcheck: 60 requisições por minuto
export const healthLimiter = criarLimitador({
  janelaMs: 60 * 1000,
  max: 60,
  mensagem: "Muitas requisições de monitoramento.",
  skipInTests: true,
});
