import "dotenv/config";
import { ApifyClient } from "apify-client";
import { limparProdutosAntigos, salvarProduto, setConfig, getConfig } from "../db/queries.js";

export function obterTokenApify(): string | undefined {
  return getConfig("apify_api_token") || process.env.APIFY_API_TOKEN;
}

function obterClienteApify(): ApifyClient {
  const token = obterTokenApify();
  if (!token) {
    throw new Error("APIFY_API_TOKEN não configurado");
  }
  return new ApifyClient({ token });
}

const ACTOR_ID = "karamelo/mercadolivre-scraper-brasil-portugues";
const ACTOR_BUILD = process.env.APIFY_ACTOR_BUILD;
const COLLECTION_TIMEOUT_SECS = 180;
const COLLECTION_WAIT_SECS = 240;
const MAX_PRODUTOS_POR_COLETA = Math.min(
  50,
  Math.max(1, Number(process.env.APIFY_MAX_PRODUCTS ?? 24) || 24),
);

interface OfertaApify {
  zProdutoLink: string;
  eTituloProduto: string;
  novoPreco: string;
  precoAnterior?: string;
  precoDiscount?: string;
  imagemLink: string;
  idPublicacao?: string;
}

export async function buscarOfertas(): Promise<OfertaApify[]> {
  const client = obterClienteApify();

  let ultimoErro: unknown;

  const maxPages = Math.min(
    10,
    Math.max(1, Number(process.env.APIFY_MAX_PAGES_OFERTAS ?? 4) || 4),
  );

  // Uma única tentativa adicional. A frequência normal de coleta não muda.
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const run = await client.actor(ACTOR_ID).call(
        {
          keyword: "ofertas",
          scrapeOfertas: true,
          maxPagesOfertas: maxPages,
          promoted: false,
        },
        {
          ...(ACTOR_BUILD ? { build: ACTOR_BUILD } : {}),
          timeout: COLLECTION_TIMEOUT_SECS,
          waitSecs: COLLECTION_WAIT_SECS,
        },
      );

      if (run.status !== "SUCCEEDED") {
        throw new Error(`execução do Apify terminou com status ${run.status}`);
      }

      const { items } = await client.dataset(run.defaultDatasetId).listItems();

      const itensValidos = items.filter((item) => {
        if (!item || typeof item !== "object") return false;
        const oferta = item as Partial<OfertaApify>;
        return (
          typeof oferta.zProdutoLink === "string" &&
          typeof oferta.eTituloProduto === "string" &&
          typeof oferta.novoPreco === "string" &&
          typeof oferta.imagemLink === "string"
        );
      });

      return itensValidos as unknown as OfertaApify[];
    } catch (erro) {
      ultimoErro = erro;
      if (!erroApifyPodeSerRepetido(erro)) break;
      if (tentativa < 2) {
        console.warn("Apify falhou; tentando novamente uma vez", erro);
      }
    }
  }

  throw ultimoErro instanceof Error
    ? ultimoErro
    : new Error(String(ultimoErro));
}

function codigoStatusDoErro(erro: unknown): number | undefined {
  if (!erro || typeof erro !== "object") return undefined;
  const candidato = erro as { statusCode?: unknown; status?: unknown };
  const status = candidato.statusCode ?? candidato.status;
  return typeof status === "number" ? status : undefined;
}

function erroApifyPodeSerRepetido(erro: unknown): boolean {
  const status = codigoStatusDoErro(erro);
  if (status !== undefined) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  const mensagem = erro instanceof Error ? erro.message.toLowerCase() : String(erro).toLowerCase();
  const permanente = [
    "401", "402", "403", "404", "unauthorized", "forbidden", "not found",
    "invalid token", "token inválido", "credit", "billing", "insufficient funds",
  ];
  return !permanente.some((termo) => mensagem.includes(termo));
}

export function extrairDesconto(
  precoDiscount?: string,
  novoPreco?: string,
  precoAnterior?: string,
): number {
  if (typeof precoDiscount === "string") {
    const match = precoDiscount.match(/(\d+)%/);
    if (match) return Number(match[1]);
  }
  if (typeof precoAnterior === "string" && typeof novoPreco === "string") {
    const limpar = (v: string) =>
      Number(v.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, ""));
    const anterior = limpar(precoAnterior);
    const atual = limpar(novoPreco);
    if (anterior > 0 && atual > 0 && anterior > atual) {
      return Math.round(((anterior - atual) / anterior) * 100);
    }
  }
  return 0;
}

export function extrairIdProduto(link: string, idPublicacao?: string): string {
  if (typeof idPublicacao === "string" && idPublicacao.trim()) {
    const limpo = idPublicacao.trim().replace(/-/g, "").toUpperCase();
    if (/^MLB[A-Z0-9]*\d+$/i.test(limpo)) {
      return limpo;
    }
  }

  const urlLimpa = link.split("?")[0] || "";
  const match = urlLimpa.match(/MLB(U)?-?(\d+)/i) || link.match(/MLB(U)?-?(\d+)/i);
  if (!match) return "";
  const u = match[1] ? "U" : "";
  const nums = match[2];
  return `MLB${u}${nums}`;
}

export async function processarESalvarOfertas() {
  setConfig("scraper_ultima_tentativa", new Date().toISOString());

  try {
    const ofertas = await buscarOfertas();
    let salvas = 0;

    const ofertasLimitadas = ofertas
      .sort(
        (a, b) =>
          extrairDesconto(b.precoDiscount, b.novoPreco, b.precoAnterior) -
          extrairDesconto(a.precoDiscount, a.novoPreco, a.precoAnterior),
      )
      .slice(0, MAX_PRODUTOS_POR_COLETA);

    for (const oferta of ofertasLimitadas) {
      const idProduto = extrairIdProduto(
        oferta.zProdutoLink,
        (oferta as Partial<OfertaApify>).idPublicacao,
      );

      if (!idProduto) continue;

      const desconto = extrairDesconto(
        oferta.precoDiscount,
        oferta.novoPreco,
        oferta.precoAnterior,
      );

      salvarProduto({
        source_key: "mercado_livre",
        external_product_id: idProduto,
        nome: oferta.eTituloProduto,
        preco_atual: oferta.novoPreco,
        preco_original: oferta.precoAnterior,
        desconto_percentual: desconto,
        imagem_url: oferta.imagemLink,
        link_original: oferta.zProdutoLink,
        link_afiliado: oferta.zProdutoLink,
      });
      salvas++;
    }

    const produtosRemovidos = limparProdutosAntigos();
    setConfig("scraper_ultima_sucesso", new Date().toISOString());
    setConfig("scraper_ultimo_resultado", String(salvas));
    setConfig("scraper_ultimo_erro", "");
    console.log(
      `${salvas} ofertas válidas processadas e salvas; ${produtosRemovidos} produtos antigos removidos`,
    );
    return salvas;
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    setConfig("scraper_ultimo_erro", mensagem.slice(0, 500));
    throw erro;
  }
}
