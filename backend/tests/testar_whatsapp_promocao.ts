import "dotenv/config";
import {
  conectarWhatsApp,
  getStatusConexao,
} from "../src/whatsapp/connection.js";
import { enviarProduto } from "../src/whatsapp/sender.js";
import {
  buscarProdutosPorCodigosML,
  getConfig,
} from "../src/db/queries.js";

const TEMPO_MAXIMO_MS = 120_000;
const INTERVALO_MS = 1_000;

function esperar(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("Reutilizando a sessão atual do WhatsApp...");
await conectarWhatsApp();

const inicio = Date.now();
while (!getStatusConexao().conectado && Date.now() - inicio < TEMPO_MAXIMO_MS) {
  const status = getStatusConexao();
  console.log(`Estado do WhatsApp: ${status.estado}`);

  await esperar(INTERVALO_MS);
}

if (!getStatusConexao().conectado) {
  throw new Error("Tempo esgotado aguardando a conexão do WhatsApp.");
}

const grupoId = getConfig("whatsapp_grupo_id");
if (!grupoId) {
  throw new Error(
    "Nenhum grupo WhatsApp selecionado. Configure o grupo antes de executar o teste.",
  );
}

const amostraConfig = getConfig("whatsapp_teste_produtos");
if (!amostraConfig) {
  throw new Error(
    "Amostra de teste não preparada. Execute: npm run test:whatsapp:preparar",
  );
}

let produtoIds: string[];
try {
  const configuracao = JSON.parse(amostraConfig) as { ids?: unknown };
  produtoIds = Array.isArray(configuracao.ids)
    ? configuracao.ids.filter((id): id is string => typeof id === "string")
    : [];
} catch {
  produtoIds = [];
}

const produtosPorId = new Map(
  buscarProdutosPorCodigosML(produtoIds).map((produto) => [
    produto.external_product_id,
    produto,
  ]),
);
const produtos = produtoIds
  .map((produtoId) => produtosPorId.get(produtoId))
  .filter((produto): produto is NonNullable<typeof produto> => Boolean(produto));
if (produtos.length !== produtoIds.length || produtos.length === 0) {
  throw new Error(
    "A amostra de teste não está disponível integralmente na tabela produtos. Execute novamente a preparação.",
  );
}

const indice = Number(process.env.WHATSAPP_TEST_PRODUCT_INDEX ?? 0);
const produto = produtos[indice];
if (!produto) {
  throw new Error(
    `Índice de produto inválido: ${indice}. A amostra tem ${produtos.length} produtos.`,
  );
}

console.log(`Usando produto fixado: ${produto.nome}`);

console.log(`Enviando promoção para o grupo selecionado: ${grupoId}`);
await enviarProduto({
  nome: produto.nome,
  preco_atual: produto.preco_atual,
  preco_original: produto.preco_original,
  link_afiliado: produto.link_afiliado,
  imagem_url: produto.imagem_url,
});

console.log("Promoção enviada com sucesso.");
console.log(`Link afiliado reutilizado: ${produto.link_afiliado}`);
process.exit(0);
