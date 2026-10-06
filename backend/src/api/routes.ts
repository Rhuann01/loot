import { Router } from "express";
import {
  alternarSelecao,
  buscarProdutoPorId,
  listarProdutos,
  marcarComoEnviado,
} from "../db/queries.js";
import { getStatusConexao } from "../whatsapp/connection.js";
import { getConfig, setConfig } from "../db/queries.js";
import { enviarProduto } from "../whatsapp/sender.js";

const router = Router();

router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

router.get("/produtos", (req, res) => {
  const produtos = listarProdutos();
  res.json(produtos);
});

router.get("/whatsapp/status", (req, res) => {
  const status = getStatusConexao();
  res.json(status);
});

router.get("/config", (req, res) => {
  const config = {
    auto_envio_ativo: getConfig("auto_envio_ativo"),
    limite_diario: getConfig("limite_diario"),
    desconto_minimo_global: getConfig("desconto_minimo_global"),
  };
  res.json(config);
});

router.post("/config", (req, res) => {
  const { chave, valor } = req.body;

  if (!chave || !valor) {
    return res.status(400).json({ erro: "chave e valor são obrigatórios" });
  }

  setConfig(chave, valor);
  res.json({ sucesso: true });
});

router.post("/produtos/:id/selecionar", (req, res) => {
  const id = Number(req.params.id);
  const { selecionado } = req.body;

  alternarSelecao(id, selecionado);
  res.json({ sucesso: true });
});

router.post("/produtos/:id/reenviar", async (req, res) => {
  const id = Number(req.params.id);
  const produto = buscarProdutoPorId(id);

  if (!produto) {
    return res.status(404).json({ erro: "produto não encontrado" });
  }

  await enviarProduto({
    nome: produto.nome,
    preco_atual: produto.preco_atual,
    preco_original: produto.preco_original,
    link_afiliado: produto.link_afiliado,
    imagem_url: produto.imagem_url,
  });

  marcarComoEnviado(produto.id);

  res.json({ sucesso: true });
});

export default router;
