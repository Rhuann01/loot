import {
  buscarSessaoAfiliado,
  atualizarCookieSessao,
  atualizarStatusIntegracao,
  salvarSessaoAfiliado,
} from "../../db/queries.js";
import { mergeCookies } from "./cookies.js";

const PROVEDOR = "mercadolivre";
const LINKBUILDER_URL =
  "https://www.mercadolivre.com.br/afiliados/linkbuilder";
const CREATE_LINK_URL =
  "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink";

export class SessionExpiredError extends Error {
  constructor(message = "Sessão do Mercado Livre expirada.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

async function getCsrfToken(): Promise<string> {
  const sessao = buscarSessaoAfiliado(PROVEDOR);
  if (!sessao) {
    throw new SessionExpiredError(
      "Nenhuma sessão configurada. Configure com configurarSessaoML().",
    );
  }
  return sessao.csrf_token;
}

function headersBase(cookie: string, csrfToken: string) {
  return {
    cookie,
    "x-csrf-token": csrfToken,
    "content-type": "application/json",
    origin: "https://www.mercadolivre.com.br",
    referer: LINKBUILDER_URL,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
}

function extrairSetCookies(headers: Headers): string[] {
  if (typeof (headers as any).getSetCookie === "function") {
    return (headers as any).getSetCookie() as string[];
  }
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function limparUrl(url: string): string {
  const hashIdx = url.indexOf("#");
  return hashIdx !== -1 ? url.slice(0, hashIdx) : url;
}

export function configurarSessaoML(
  cookie: string,
  csrfToken: string,
  tag: string,
) {
  salvarSessaoAfiliado(PROVEDOR, cookie, csrfToken, tag);
  atualizarStatusIntegracao("mercado_livre", "configured");
}

export async function refreshSession(): Promise<void> {
  const sessao = buscarSessaoAfiliado(PROVEDOR);
  if (!sessao) {
    throw new SessionExpiredError(
      "Nenhuma sessão configurada. Configure com configurarSessaoML().",
    );
  }

  const csrfToken = await getCsrfToken();

  const response = await fetch(LINKBUILDER_URL, {
    method: "GET",
    redirect: "manual",
    headers: headersBase(sessao.cookie, csrfToken),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new SessionExpiredError(
      "Sessão expirada (redirecionamento para login detectado). " +
        "Cole um novo cookie com configurarSessaoML().",
    );
  }

  const setCookies = extrairSetCookies(response.headers);
  if (setCookies.length > 0) {
    const novoCookie = mergeCookies(sessao.cookie, setCookies);
    atualizarCookieSessao(PROVEDOR, novoCookie);
  }
}

export async function gerarLinkAfiliado(urlProduto: string): Promise<string> {
  await refreshSession();

  const sessao = buscarSessaoAfiliado(PROVEDOR);
  if (!sessao) throw new SessionExpiredError();

  const csrfToken = await getCsrfToken();
  const urlLimpa = limparUrl(urlProduto);

  const body = JSON.stringify({ urls: [urlLimpa], tag: sessao.tag });

  const response = await fetch(CREATE_LINK_URL, {
    method: "POST",
    headers: headersBase(sessao.cookie, csrfToken),
    body,
  });

  if (response.status === 401 || response.status === 403) {
    throw new SessionExpiredError(
      `API retornou ${response.status}. ` +
        "Sessão expirada. Cole um novo cookie com configurarSessaoML().",
    );
  }

  if (!response.ok) {
    throw new Error(
      `Erro inesperado ao chamar createLink: HTTP ${response.status}`,
    );
  }

  const setCookies = extrairSetCookies(response.headers);
  if (setCookies.length > 0) {
    const novoCookie = mergeCookies(sessao.cookie, setCookies);
    atualizarCookieSessao(PROVEDOR, novoCookie);
  }

  type LinkResponse = {
    short_url?: string;
    shortUrl?: string;
    url?: string;
    urls?: LinkResponse[];
  };

  const data = (await response.json()) as LinkResponse | LinkResponse[];

  const primeiro = Array.isArray(data)
    ? data[0]
    : data.urls?.[0] ?? data;
  const linkGerado =
    primeiro?.short_url ?? primeiro?.shortUrl ?? primeiro?.url;

  if (!linkGerado) {
    throw new Error(
      `Resposta inesperada de createLink: ${JSON.stringify(data)}`,
    );
  }

  atualizarStatusIntegracao("mercado_livre", "connected", {
    conectadoEm: new Date().toISOString(),
  });

  return linkGerado;
}
