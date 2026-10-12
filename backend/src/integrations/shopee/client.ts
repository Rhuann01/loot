import { createHash } from "node:crypto";

const ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";

export class ShopeeApiError extends Error {
  readonly codigo: number | undefined;

  constructor(message: string, codigo?: number) {
    super(message);
    this.name = "ShopeeApiError";
    this.codigo = codigo;
  }
}

interface RespostaGraphQL<T> {
  data?: T;
  errors?: Array<{
    message?: string;
    extensions?: { code?: number; message?: string };
  }>;
}

export function calcularAssinatura(
  appId: string,
  timestamp: number,
  body: string,
  secret: string,
): string {
  return createHash("sha256")
    .update(`${appId}${timestamp}${body}${secret}`)
    .digest("hex");
}

function credenciais() {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;
  if (!appId || !secret) {
    throw new ShopeeApiError("SHOPEE_APP_ID/SHOPEE_SECRET não configurados");
  }
  return { appId, secret };
}

export async function shopeeRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const { appId, secret } = credenciais();

  // O corpo é montado uma única vez: o mesmo texto é assinado e enviado.
  const body = JSON.stringify({ query, variables });
  const timestamp = Math.floor(Date.now() / 1000);
  const assinatura = calcularAssinatura(appId, timestamp, body, secret);

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${assinatura}`,
    },
    body,
  });

  if (!response.ok) {
    throw new ShopeeApiError(`Shopee respondeu HTTP ${response.status}`);
  }

  // A API responde HTTP 200 mesmo com erro: sempre conferir "errors".
  const json = (await response.json()) as RespostaGraphQL<T>;
  if (json.errors?.length) {
    const erro = json.errors[0]!;
    throw new ShopeeApiError(
      erro.extensions?.message ?? erro.message ?? "erro desconhecido da Shopee",
      erro.extensions?.code,
    );
  }
  if (!json.data) throw new ShopeeApiError("resposta da Shopee sem data");
  return json.data;
}
