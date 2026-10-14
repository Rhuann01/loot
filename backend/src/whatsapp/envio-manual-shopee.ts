import { createHash } from "node:crypto";
import db from "../db/index.js";
import {
  getConfig,
  salvarProduto,
  buscarProdutoPorExternalId,
  buscarTentativaEnvioPorId,
  gravarSnapshotTentativa,
  gravarAtividade,
  obterUltimaComissao,
  type TentativaEnvio,
} from "../db/queries.js";
import { sqlDiaBrasilia, SQL_HOJE_BRASILIA } from "../lib/time.js";
import { getAffiliateProvider } from "../integrations/registry.js";
import {
  consultarOfertaShopeePorItem,
  type OfertaAtualShopee,
} from "../integrations/shopee/source.js";
import { getStatusConexao } from "./connection.js";
import { executarEnvioProtegido } from "./dispatch.js";
import { enviarProduto, montarMensagemDoProduto } from "./sender.js";

export class ShopeeUrlError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(
    message: string,
    status: number = 422,
    code: string = "URL_INVALIDA",
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShopeeUrlError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface InfoUrlShopee {
  urlNormalizada: string;
  shopId: string;
  itemId: string;
  externalProductId: string;
}

export type ResolvedorRedirect = (url: string) => Promise<string>;
let resolvedorRedirectCustom: ResolvedorRedirect | null = null;

export function definirResolvedorRedirectParaTeste(
  fn: ResolvedorRedirect | null,
) {
  resolvedorRedirectCustom = fn;
}

export type ConsultorOfertaShopee = (
  itemId: string,
) => Promise<OfertaAtualShopee | null>;
let consultorOfertaShopeeCustom: ConsultorOfertaShopee | null = null;

export function definirConsultorShopeeParaTeste(
  fn: ConsultorOfertaShopee | null,
) {
  consultorOfertaShopeeCustom = fn;
}

export type GeradorLinkAfiliado = (url: string) => Promise<string>;
let geradorLinkCustom: GeradorLinkAfiliado | null = null;

export function definirGeradorLinkParaTeste(fn: GeradorLinkAfiliado | null) {
  geradorLinkCustom = fn;
}

export type EnviadorMensagem = (dados: {
  nome: string;
  preco_atual: string;
  preco_original: string | null;
  descontoPercentual?: number | null | undefined;
  link_afiliado: string;
  imagem_url: string | null;
}) => Promise<void>;
let enviadorCustom: EnviadorMensagem | null = null;

export function definirEnviadorParaTeste(fn: EnviadorMensagem | null) {
  enviadorCustom = fn;
}

export type ConsultorStatusConexao = () => ReturnType<typeof getStatusConexao>;
let consultorStatusConexaoCustom: ConsultorStatusConexao | null = null;

export function definirStatusConexaoParaTeste(fn: ConsultorStatusConexao | null) {
  consultorStatusConexaoCustom = fn;
}

function obterStatusConexao() {
  if (consultorStatusConexaoCustom) {
    return consultorStatusConexaoCustom();
  }
  return getStatusConexao();
}

async function resolverRedirectCurto(url: string): Promise<string> {
  if (resolvedorRedirectCustom) {
    return resolvedorRedirectCustom(url);
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    return res.url;
  } catch (erro) {
    throw new ShopeeUrlError(
      `Falha ao resolver link curto Shopee: ${
        erro instanceof Error ? erro.message : String(erro)
      }`,
      422,
      "URL_INVALIDA",
    );
  }
}

export async function normalizarUrlShopee(
  urlEntrada: string,
): Promise<InfoUrlShopee> {
  if (!urlEntrada || typeof urlEntrada !== "string" || !urlEntrada.trim()) {
    throw new ShopeeUrlError(
      "URL ausente ou inválida",
      400,
      "PARAMETRO_INVALIDO",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(urlEntrada.trim());
  } catch {
    throw new ShopeeUrlError("URL malformada", 400, "PARAMETRO_INVALIDO");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ShopeeUrlError("Protocolo inválido", 400, "PARAMETRO_INVALIDO");
  }

  const host = parsed.hostname.toLowerCase();

  // Mercado Livre / MercadoLibre não suportado
  if (host.includes("mercadolivre.") || host.includes("mercadolibre.")) {
    throw new ShopeeUrlError(
      "Envio manual por link disponível somente para Shopee",
      422,
      "PLATAFORMA_NAO_DISPONIVEL",
    );
  }

  // Apenas Shopee
  const hostValido =
    host === "shopee.com.br" ||
    host === "www.shopee.com.br" ||
    host === "s.shopee.com.br";

  if (!hostValido) {
    throw new ShopeeUrlError(
      "Domínio não suportado. Aceito somente Shopee.",
      422,
      "URL_NAO_SUPORTADA",
    );
  }

  let urlFinal = parsed.href;

  // Link curto s.shopee.com.br
  if (host === "s.shopee.com.br") {
    urlFinal = await resolverRedirectCurto(urlEntrada.trim());
  }

  let parsedFinal: URL;
  try {
    parsedFinal = new URL(urlFinal);
  } catch {
    throw new ShopeeUrlError("URL final inválida", 422, "URL_INVALIDA");
  }

  const finalHost = parsedFinal.hostname.toLowerCase();
  if (
    finalHost.includes("mercadolivre.") ||
    finalHost.includes("mercadolibre.")
  ) {
    throw new ShopeeUrlError(
      "Envio manual por link disponível somente para Shopee",
      422,
      "PLATAFORMA_NAO_DISPONIVEL",
    );
  }

  if (finalHost !== "shopee.com.br" && finalHost !== "www.shopee.com.br") {
    throw new ShopeeUrlError(
      "Destino do redirecionamento não pertence à Shopee",
      422,
      "URL_NAO_SUPORTADA",
    );
  }

  const pathname = decodeURIComponent(parsedFinal.pathname);
  let shopId: string | null = null;
  let itemId: string | null = null;

  const matchProduct = pathname.match(/\/product\/(\d+)\/(\d+)/i);
  if (matchProduct && matchProduct[1] && matchProduct[2]) {
    shopId = matchProduct[1];
    itemId = matchProduct[2];
  } else {
    const matchI = pathname.match(/[/-]i\.(\d+)\.(\d+)/i);
    if (matchI && matchI[1] && matchI[2]) {
      shopId = matchI[1];
      itemId = matchI[2];
    }
  }

  if (!shopId || !itemId) {
    throw new ShopeeUrlError(
      "Link da Shopee não contém identificador válido de produto",
      422,
      "URL_INVALIDA",
    );
  }

  const urlNormalizada = `https://shopee.com.br/product/${shopId}/${itemId}`;
  const externalProductId = `${shopId}_${itemId}`;

  return {
    urlNormalizada,
    shopId,
    itemId,
    externalProductId,
  };
}

export function verificarSeShopeeEnviadoHoje(
  externalProductId: string,
  urlNormalizada: string,
): { enviadoHoje: boolean; enviadoEm: string | null } {
  const rowEnvios = db
    .prepare(
      `SELECT e.enviado_em FROM envios e
       JOIN produtos p ON p.id = e.produto_id
       WHERE p.source_key = 'shopee'
         AND p.external_product_id = ?
         AND ${sqlDiaBrasilia("e.enviado_em")} = ${SQL_HOJE_BRASILIA}
       ORDER BY e.id DESC LIMIT 1`,
    )
    .get(externalProductId) as { enviado_em: string } | undefined;

  if (rowEnvios) {
    return { enviadoHoje: true, enviadoEm: rowEnvios.enviado_em };
  }

  const rowTentativa = db
    .prepare(
      `SELECT finalizado_em FROM tentativas_de_envio
       WHERE plataforma = 'shopee'
         AND (url_original = ? OR url_original LIKE ?)
         AND status = 'sent'
         AND ${sqlDiaBrasilia("finalizado_em")} = ${SQL_HOJE_BRASILIA}
       ORDER BY id DESC LIMIT 1`,
    )
    .get(urlNormalizada, `%${externalProductId}%`) as
    | { finalizado_em: string }
    | undefined;

  if (rowTentativa) {
    return { enviadoHoje: true, enviadoEm: rowTentativa.finalizado_em };
  }

  return { enviadoHoje: false, enviadoEm: null };
}

export async function obterOfertaShopee(
  itemId: string,
): Promise<OfertaAtualShopee | null> {
  if (consultorOfertaShopeeCustom) {
    return consultorOfertaShopeeCustom(itemId);
  }
  return consultarOfertaShopeePorItem(itemId);
}

export async function gerarLinkShopee(url: string): Promise<string> {
  if (geradorLinkCustom) {
    return geradorLinkCustom(url);
  }
  const provider = getAffiliateProvider("shopee");
  return provider.generateLink(url);
}

const formatarPreco = (valor: number) => valor.toFixed(2).replace(".", ",");

export async function resolverLinkShopee(url: string) {
  const info = await normalizarUrlShopee(url);
  const oferta = await obterOfertaShopee(info.itemId);
  if (!oferta) {
    throw new ShopeeUrlError(
      "Oferta não encontrada na Shopee",
      422,
      "OFERTA_NAO_ENCONTRADA",
    );
  }

  const { enviadoHoje, enviadoEm } = verificarSeShopeeEnviadoHoje(
    info.externalProductId,
    info.urlNormalizada,
  );

  const prodSalvo = buscarProdutoPorExternalId(
    "shopee",
    info.externalProductId,
  );

  return {
    plataforma: { key: "shopee", nome: "Shopee" },
    urlOriginal: info.urlNormalizada,
    externalProductId: info.externalProductId,
    camposManuais: [],
    produtoJaEnviadoHoje: enviadoHoje,
    enviadoEm,
    dados: {
      nome: oferta.nome || prodSalvo?.nome || "Produto Shopee",
      precoAtual: formatarPreco(oferta.precoAtual),
      precoOriginal: null,
      descontoPercentual: Math.round(oferta.descontoPercentual),
      imagemUrl: oferta.imageUrl || prodSalvo?.imagem_url || "",
    },
  };
}

export async function gerarPreviewManualShopee(dadosEntrada: {
  url: string;
  nome?: string | undefined;
  precoAtual: string;
  precoOriginal?: string | null | undefined;
  descontoPercentual?: number | undefined;
  imagemUrl?: string | undefined;
}) {
  const info = await normalizarUrlShopee(dadosEntrada.url);

  if (!dadosEntrada.precoAtual) {
    throw new ShopeeUrlError(
      "precoAtual é obrigatório",
      400,
      "PARAMETRO_INVALIDO",
    );
  }
  const precoNum = Number(String(dadosEntrada.precoAtual).replace(",", "."));
  if (!Number.isFinite(precoNum) || precoNum <= 0) {
    throw new ShopeeUrlError(
      "precoAtual deve ser um valor monetário válido > 0",
      400,
      "PARAMETRO_INVALIDO",
    );
  }

  const oferta = await obterOfertaShopee(info.itemId);
  if (!oferta) {
    throw new ShopeeUrlError(
      "Oferta não encontrada na Shopee",
      422,
      "OFERTA_NAO_ENCONTRADA",
    );
  }

  const statusWhats = obterStatusConexao();
  if (!statusWhats.conectado) {
    throw new ShopeeUrlError(
      "WhatsApp não está conectado",
      503,
      "WHATSAPP_OFFLINE",
    );
  }

  const destinoId = getConfig("whatsapp_grupo_id") || null;
  const destinoNome = getConfig("whatsapp_grupo_nome") || null;
  if (!destinoId) {
    throw new ShopeeUrlError(
      "Destino do WhatsApp não configurado",
      400,
      "DESTINO_AUSENTE",
    );
  }

  const linkAfiliado = await gerarLinkShopee(info.urlNormalizada);
  if (
    !linkAfiliado ||
    !linkAfiliado.trim() ||
    linkAfiliado === info.urlNormalizada
  ) {
    throw new ShopeeUrlError(
      "Link afiliado gerado é inválido ou igual ao original",
      502,
      "LINK_AFILIADO_INVALIDO",
    );
  }

  const desconto = dadosEntrada.descontoPercentual ?? oferta.descontoPercentual ?? 0;
  const mensagem = montarMensagemDoProduto({
    nome: dadosEntrada.nome || oferta.nome || "Produto Shopee",
    preco_atual: formatarPreco(precoNum),
    preco_original: null,
    descontoPercentual: desconto > 0 ? Math.round(desconto) : null,
    link_afiliado: linkAfiliado,
    imagem_url: dadosEntrada.imagemUrl || oferta.imageUrl || null,
  });

  const { enviadoHoje } = verificarSeShopeeEnviadoHoje(
    info.externalProductId,
    info.urlNormalizada,
  );

  const prodSalvo = buscarProdutoPorExternalId(
    "shopee",
    info.externalProductId,
  );
  const ultimaComissao = prodSalvo ? obterUltimaComissao(prodSalvo.id) : null;

  return {
    mensagem,
    destino: {
      id: destinoId,
      nome: destinoNome,
    },
    linkAfiliado,
    produtoJaEnviadoHoje: enviadoHoje,
    comissao: ultimaComissao
      ? {
          valor: ultimaComissao.comissao_valor,
          percentual: ultimaComissao.comissao_percentual,
          disponivel: true,
          estimada: true,
          coletadaEm: ultimaComissao.coletado_em,
        }
      : {
          valor: null,
          percentual: null,
          disponivel: false,
          estimada: true,
          coletadaEm: null,
        },
  };
}

export async function executarEnvioManualShopee(
  dadosEntrada: {
    url: string;
    nome?: string | undefined;
    precoAtual: string;
    precoOriginal?: string | null | undefined;
    descontoPercentual?: number | undefined;
    imagemUrl?: string | undefined;
  },
  idempotencyKey?: string | undefined,
) {
  const chave = idempotencyKey?.trim();
  const payloadParaHash = {
    url: dadosEntrada.url,
    nome: dadosEntrada.nome ?? "",
    precoAtual: dadosEntrada.precoAtual,
    precoOriginal: dadosEntrada.precoOriginal ?? null,
    descontoPercentual: dadosEntrada.descontoPercentual ?? null,
    imagemUrl: dadosEntrada.imagemUrl ?? "",
  };
  const payloadHash = chave
    ? createHash("sha256").update(JSON.stringify(payloadParaHash)).digest("hex")
    : null;

  if (chave) {
    const existente = db
      .prepare(
        `SELECT * FROM idempotencias_reenvio_manual WHERE chave = ?`,
      )
      .get(chave) as
      | {
          chave: string;
          produto_id: number | null;
          tentativa_id: number;
          payload_hash: string | null;
        }
      | undefined;

    if (existente) {
      if (existente.payload_hash && existente.payload_hash !== payloadHash) {
        throw new ShopeeUrlError(
          "chave de idempotência já utilizada com payload diferente",
          409,
          "CONFLITO",
        );
      }
      const tentativa = buscarTentativaEnvioPorId(existente.tentativa_id);
      if (tentativa) {
        return {
          sucesso: tentativa.status === "sent",
          tentativaId: tentativa.id,
          status: tentativa.status,
          needsReview: tentativa.status === "ambiguous",
          mensagem: tentativa.mensagem_snapshot,
          destino: {
            id: tentativa.destino_id,
            nome: tentativa.destino_nome,
          },
          motivo: tentativa.motivo,
        };
      }
    }
  }

  const info = await normalizarUrlShopee(dadosEntrada.url);

  if (!dadosEntrada.precoAtual) {
    throw new ShopeeUrlError(
      "precoAtual é obrigatório",
      400,
      "PARAMETRO_INVALIDO",
    );
  }
  const precoNum = Number(String(dadosEntrada.precoAtual).replace(",", "."));
  if (!Number.isFinite(precoNum) || precoNum <= 0) {
    throw new ShopeeUrlError(
      "precoAtual deve ser um valor monetário válido > 0",
      400,
      "PARAMETRO_INVALIDO",
    );
  }

  const { enviadoHoje } = verificarSeShopeeEnviadoHoje(
    info.externalProductId,
    info.urlNormalizada,
  );
  if (enviadoHoje) {
    throw new ShopeeUrlError(
      "Este produto já foi enviado hoje",
      422,
      "PRODUTO_JA_ENVIADO_HOJE",
    );
  }

  const statusWhats = obterStatusConexao();
  if (!statusWhats.conectado) {
    const tentativa = db
      .prepare(
        `INSERT INTO tentativas_de_envio (produto_id, origem, status, motivo, plataforma, url_original, titulo)
         VALUES (NULL, 'manual', 'failed', 'WhatsApp não está conectado', 'shopee', ?, ?) RETURNING *`,
      )
      .get(
        info.urlNormalizada,
        dadosEntrada.nome || "Produto Shopee",
      ) as TentativaEnvio;

    if (chave && payloadHash) {
      db.prepare(
        `INSERT OR REPLACE INTO idempotencias_reenvio_manual (chave, produto_id, tentativa_id, payload_hash)
         VALUES (?, NULL, ?, ?)`,
      ).run(chave, tentativa.id, payloadHash);
    }

    gravarAtividade({
      tipo: "envio_falha",
      integracao_key: "shopee",
      tentativa_id: tentativa.id,
      titulo: `Falha no envio manual: ${dadosEntrada.nome || "Produto Shopee"}`,
      detalhe: "WhatsApp não está conectado",
    });

    throw new ShopeeUrlError(
      "WhatsApp não está conectado",
      503,
      "WHATSAPP_OFFLINE",
      { tentativaId: tentativa.id, status: "failed", needsReview: false },
    );
  }

  const destinoId = getConfig("whatsapp_grupo_id") || null;
  const destinoNome = getConfig("whatsapp_grupo_nome") || null;
  if (!destinoId) {
    throw new ShopeeUrlError(
      "Destino do WhatsApp não configurado",
      400,
      "DESTINO_AUSENTE",
    );
  }

  const linkAfiliado = await gerarLinkShopee(info.urlNormalizada);
  if (
    !linkAfiliado ||
    !linkAfiliado.trim() ||
    linkAfiliado === info.urlNormalizada
  ) {
    throw new ShopeeUrlError(
      "Link afiliado gerado é inválido ou igual ao original",
      502,
      "LINK_AFILIADO_INVALIDO",
    );
  }

  const desconto = dadosEntrada.descontoPercentual ?? 0;
  salvarProduto({
    source_key: "shopee",
    external_product_id: info.externalProductId,
    nome: dadosEntrada.nome || "Produto Shopee",
    preco_atual: formatarPreco(precoNum),
    preco_original: null,
    desconto_percentual: desconto > 0 ? Math.round(desconto) : 0,
    imagem_url: dadosEntrada.imagemUrl || undefined,
    link_original: info.urlNormalizada,
    link_afiliado: linkAfiliado,
  });

  const prodSalvo = buscarProdutoPorExternalId(
    "shopee",
    info.externalProductId,
  );
  const produtoId = prodSalvo?.id ?? null;

  const mensagem = montarMensagemDoProduto({
    nome: dadosEntrada.nome || "Produto Shopee",
    preco_atual: formatarPreco(precoNum),
    preco_original: null,
    descontoPercentual: desconto > 0 ? Math.round(desconto) : null,
    link_afiliado: linkAfiliado,
    imagem_url: dadosEntrada.imagemUrl || null,
  });

  const tentativa = db
    .prepare(
      `INSERT INTO tentativas_de_envio (produto_id, origem, status, plataforma, url_original, titulo)
       VALUES (?, 'manual', 'sending', 'shopee', ?, ?) RETURNING *`,
    )
    .get(
      produtoId,
      info.urlNormalizada,
      dadosEntrada.nome || "Produto Shopee",
    ) as TentativaEnvio;

  if (chave && payloadHash) {
    db.prepare(
      `INSERT OR REPLACE INTO idempotencias_reenvio_manual (chave, produto_id, tentativa_id, payload_hash)
       VALUES (?, ?, ?, ?)`,
    ).run(chave, produtoId, tentativa.id, payloadHash);
  }

  gravarSnapshotTentativa(tentativa.id, {
    mensagem,
    destinoId,
    destinoNome,
    plataforma: "shopee",
    titulo: dadosEntrada.nome || "Produto Shopee",
    urlOriginal: info.urlNormalizada,
  });

  const resultadoEnvio = await executarEnvioProtegido(
    async ({ aguardarIntervaloAntesDaMensagem }) => {
      try {
        await aguardarIntervaloAntesDaMensagem();
        if (enviadorCustom) {
          await enviadorCustom({
            nome: dadosEntrada.nome || "Produto Shopee",
            preco_atual: formatarPreco(precoNum),
            preco_original: null,
            descontoPercentual: desconto > 0 ? Math.round(desconto) : undefined,
            link_afiliado: linkAfiliado,
            imagem_url: dadosEntrada.imagemUrl || null,
          });
        } else {
          await enviarProduto({
            nome: dadosEntrada.nome || "Produto Shopee",
            preco_atual: formatarPreco(precoNum),
            preco_original: null,
            descontoPercentual: desconto > 0 ? Math.round(desconto) : null,
            link_afiliado: linkAfiliado,
            imagem_url: dadosEntrada.imagemUrl || null,
          });
        }

        if (produtoId) {
          db.prepare(
            `UPDATE produtos
             SET enviado = 1,
                 status_fila = 'sent',
                 envio_iniciado_em = NULL,
                 origem_envio_em_andamento = NULL,
                 ultimo_erro_envio = NULL
             WHERE id = ?`,
          ).run(produtoId);
        }
        db.prepare(
          `UPDATE tentativas_de_envio
           SET status = 'sent', motivo = NULL, finalizado_em = CURRENT_TIMESTAMP
           WHERE id = ?`,
        ).run(tentativa.id);

        gravarAtividade({
          tipo: "envio_sucesso",
          integracao_key: "shopee",
          produto_id: produtoId || null,
          tentativa_id: tentativa.id,
          titulo: `Envio concluído: ${dadosEntrada.nome ? dadosEntrada.nome.slice(0, 50) : "Produto Shopee"}`,
          detalhe: "Mensagem enviada com sucesso",
        });

        return {
          sucesso: true,
          tentativaId: tentativa.id,
          status: "sent" as const,
          needsReview: false,
          mensagem,
          destino: { id: destinoId, nome: destinoNome },
          motivo: null,
        };
      } catch (erro) {
        const msgErro = erro instanceof Error ? erro.message : String(erro);
        if (msgErro === "WhatsApp não está conectado") {
          db.prepare(
            `UPDATE tentativas_de_envio SET status = 'failed', motivo = ?, finalizado_em = CURRENT_TIMESTAMP WHERE id = ?`,
          ).run(msgErro, tentativa.id);
          if (produtoId) {
            db.prepare(
              `UPDATE produtos SET status_fila = 'failed', ultimo_erro_envio = ?, envio_iniciado_em = NULL, origem_envio_em_andamento = NULL WHERE id = ?`,
            ).run(msgErro, produtoId);
          }
          gravarAtividade({
            tipo: "envio_falha",
            integracao_key: "shopee",
            produto_id: produtoId || null,
            tentativa_id: tentativa.id,
            titulo: `Falha no envio manual: ${dadosEntrada.nome || "Produto Shopee"}`,
            detalhe: msgErro,
          });
          return {
            sucesso: false,
            tentativaId: tentativa.id,
            status: "failed" as const,
            needsReview: false,
            motivo: msgErro,
          };
        }

        // Erro após despacho vira ambiguous com needsReview = true
        db.prepare(
          `UPDATE tentativas_de_envio SET status = 'ambiguous', motivo = ?, finalizado_em = CURRENT_TIMESTAMP WHERE id = ?`,
        ).run(msgErro, tentativa.id);
        if (produtoId) {
          db.prepare(
            `UPDATE produtos SET status_fila = 'ambiguous', ultimo_erro_envio = ?, envio_iniciado_em = NULL, origem_envio_em_andamento = NULL WHERE id = ?`,
          ).run(msgErro, produtoId);
        }
        gravarAtividade({
          tipo: "envio_ambiguo",
          integracao_key: "shopee",
          produto_id: produtoId || null,
          tentativa_id: tentativa.id,
          titulo: `Envio manual com status ambíguo: ${dadosEntrada.nome ? dadosEntrada.nome.slice(0, 50) : "Produto Shopee"}`,
          detalhe: msgErro.slice(0, 200),
        });
        return {
          sucesso: false,
          tentativaId: tentativa.id,
          status: "ambiguous" as const,
          needsReview: true,
          motivo: msgErro,
        };
      }
    },
  );

  return resultadoEnvio;
}
