import "dotenv/config";
import { ApifyClient } from "apify-client";
import { salvarProduto, setConfig } from "../db/queries.js";

const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN as string,
});

const ACTOR_ID = "karamelo/mercadolivre-scraper-brasil-portugues";
const ACTOR_BUILD = process.env.APIFY_ACTOR_BUILD;
const COLLECTION_TIMEOUT_SECS = 180;
const COLLECTION_WAIT_SECS = 240;
const MAX_PRODUTOS_POR_COLETA = Math.min(
  20,
  Math.max(1, Number(process.env.APIFY_MAX_PRODUCTS ?? 20) || 20),
);

interface OfertaApify {
  zProdutoLink: string;
  eTituloProduto: string;
  novoPreco: string;
  precoAnterior: string;
  precoDiscount: string;
  imagemLink: string;
}

export async function buscarOfertas(): Promise<OfertaApify[]> {
  if (!process.env.APIFY_API_TOKEN) {
    throw new Error("APIFY_API_TOKEN não configurado");
  }

  let ultimoErro: unknown;

  // Uma única tentativa adicional. A frequência normal de coleta não muda.
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const run = await client.actor(ACTOR_ID).call(
        {
          keyword: "ofertas",
          scrapeOfertas: true,
          maxPagesOfertas: 1,
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
          typeof oferta.precoAnterior === "string" &&
          typeof oferta.precoDiscount === "string" &&
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

function extrairDesconto(precoDiscount: string): number {
  const match = precoDiscount.match(/(\d+)%/);
  return match ? Number(match[1]) : 0;
}

function extrairIdProduto(link: string): string {
  const match = link.match(/MLB\d+/);
  return match ? match[0] : "";
}

export async function processarESalvarOfertas() {
  setConfig("scraper_ultima_tentativa", new Date().toISOString());

  try {
    const ofertas = await buscarOfertas();
    let salvas = 0;

    const ofertasLimitadas = ofertas
      .sort((a, b) => extrairDesconto(b.precoDiscount) - extrairDesconto(a.precoDiscount))
      .slice(0, MAX_PRODUTOS_POR_COLETA);

    for (const oferta of ofertasLimitadas) {
      const idProduto = extrairIdProduto(oferta.zProdutoLink);

      if (!idProduto) continue;

      salvarProduto({
        source_key: "mercado_livre",
        external_product_id: idProduto,
        nome: oferta.eTituloProduto,
        preco_atual: oferta.novoPreco,
        preco_original: oferta.precoAnterior,
        desconto_percentual: extrairDesconto(oferta.precoDiscount),
        imagem_url: oferta.imagemLink,
        link_original: oferta.zProdutoLink,
        link_afiliado: oferta.zProdutoLink,
      });
      salvas++;
    }

    setConfig("scraper_ultima_sucesso", new Date().toISOString());
    setConfig("scraper_ultimo_resultado", String(salvas));
    setConfig("scraper_ultimo_erro", "");
    console.log(`${salvas} ofertas válidas processadas e salvas`);
    return salvas;
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    setConfig("scraper_ultimo_erro", mensagem.slice(0, 500));
    throw erro;
  }
}
