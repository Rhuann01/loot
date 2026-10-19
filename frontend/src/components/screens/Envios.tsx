import { useState, useEffect } from "react";
import {
  Send,
  Copy,
  Check,
  Sparkles,
  AlertCircle,
  RotateCw,
  ShoppingBag,
  Trash2,
  Tag,
} from "lucide-react";
import { api } from "../../services/api";
import { toast } from "../ui/sonner";

type Plataforma = "shopee" | "mercado_livre";

interface DadosShopee {
  nome: string;
  precoAtual: string;
  precoOriginal: string | null;
  descontoPercentual: number;
  imagemUrl: string;
  linkAfiliado: string;
  urlOriginal: string;
}

export default function Envios() {
  const [plataforma, setPlataforma] = useState<Plataforma>("shopee");

  // Estado Shopee
  const [urlShopee, setUrlShopee] = useState("");
  const [buscandoShopee, setBuscandoShopee] = useState(false);
  const [enviandoShopee, setEnviandoShopee] = useState(false);
  const [copiadoShopee, setCopiadoShopee] = useState(false);
  const [dadosShopee, setDadosShopee] = useState<DadosShopee | null>(null);
  const [textoMensagemShopee, setTextoMensagemShopee] = useState("");

  // Estado Mercado Livre
  const [urlML, setUrlML] = useState("");
  const [gerandoML, setGerandoML] = useState(false);
  const [linkAfiliadoML, setLinkAfiliadoML] = useState("");
  const [nomeML, setNomeML] = useState("");
  const [precoAtualML, setPrecoAtualML] = useState("");
  const [precoOriginalML, setPrecoOriginalML] = useState("");
  const [copiadoML, setCopiadoML] = useState(false);
  const [textoMensagemML, setTextoMensagemML] = useState("");

  // ==========================================
  // FUNÇÕES AUXILIARES DE FORMATAÇÃO
  // ==========================================

  const formatarPrecoMoeda = (val: string): string => {
    const num = Number(val.replace(/\./g, "").replace(",", "."));
    if (isNaN(num)) return val;
    return num.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const calcularDesconto = (original: string, atual: string): number | null => {
    const orig = Number(original.replace(/\./g, "").replace(",", "."));
    const atu = Number(atual.replace(/\./g, "").replace(",", "."));
    if (!orig || !atu || orig <= atu) return null;
    return Math.round(((orig - atu) / orig) * 100);
  };

  // Montar texto da oferta padronizado
  const gerarTextoOferta = (
    nome: string,
    precoAtual: string,
    precoOriginal: string | null,
    link: string,
    descontoPercentual?: number | null,
  ): string => {
    const linhas: string[] = [];
    if (nome) {
      linhas.push(`🔥 *${nome.trim()}*`);
      linhas.push("");
    }

    let orig = precoOriginal;
    let desc = calcularDesconto(precoOriginal ?? "", precoAtual);

    if (
      (!orig || !orig.trim()) &&
      descontoPercentual &&
      descontoPercentual > 0 &&
      descontoPercentual < 100
    ) {
      const atuNum = Number(precoAtual.replace(/\./g, "").replace(",", "."));
      if (atuNum > 0) {
        const origNum = atuNum / (1 - descontoPercentual / 100);
        orig = origNum.toLocaleString("pt-BR", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        desc = Math.round(descontoPercentual);
      }
    }

    if (orig && orig.trim()) {
      const origFormatado = formatarPrecoMoeda(orig.trim());
      const atuFormatado = formatarPrecoMoeda(precoAtual.trim());
      linhas.push(`De: ~R$ ${origFormatado}~`);
      linhas.push(`Por: *R$ ${atuFormatado}*`);
      if (desc) {
        linhas.push(`🏷️ ${desc}% OFF`);
      }
    } else if (precoAtual && precoAtual.trim()) {
      const atuFormatado = formatarPrecoMoeda(precoAtual.trim());
      linhas.push(`Por: *R$ ${atuFormatado}*`);
    }

    if (link) {
      linhas.push("");
      linhas.push(link.trim());
    }

    return linhas.join("\n");
  };

  // ==========================================
  // FLUXO SHOPEE
  // ==========================================

  const handleBuscarShopee = async () => {
    if (!urlShopee.trim()) {
      toast.error("Por favor, cole um link da Shopee.");
      return;
    }

    setBuscandoShopee(true);
    setDadosShopee(null);
    setTextoMensagemShopee("");

    try {
      // 1. Resolver link e obter dados do produto
      const resResolve = await api.post("/api/sends/manual/resolve", {
        url: urlShopee.trim(),
      });

      const { dados, urlOriginal } = resResolve.data;

      // 2. Gerar link afiliado e preview
      const resPreview = await api.post("/api/sends/manual/preview", {
        url: urlOriginal || urlShopee.trim(),
        nome: dados.nome,
        precoAtual: dados.precoAtual,
        precoOriginal: dados.precoOriginal,
        descontoPercentual: dados.descontoPercentual,
        imagemUrl: dados.imagemUrl,
      });

      const { linkAfiliado, mensagem, produtoJaEnviadoHoje } = resPreview.data;

      const dadosCarregados: DadosShopee = {
        nome: dados.nome || "Produto Shopee",
        precoAtual: dados.precoAtual || "0,00",
        precoOriginal: dados.precoOriginal || null,
        descontoPercentual: dados.descontoPercentual || 0,
        imagemUrl: dados.imagemUrl || "",
        linkAfiliado,
        urlOriginal: urlOriginal || urlShopee.trim(),
      };

      setDadosShopee(dadosCarregados);
      setTextoMensagemShopee(
        mensagem ||
          gerarTextoOferta(
            dadosCarregados.nome,
            dadosCarregados.precoAtual,
            dadosCarregados.precoOriginal,
            linkAfiliado,
            dadosCarregados.descontoPercentual,
          ),
      );

      if (produtoJaEnviadoHoje) {
        toast.info("Atenção: Este produto já foi enviado hoje.");
      } else {
        toast.success("Dados da Shopee capturados e link de afiliado gerado!");
      }
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message ||
        "Não foi possível buscar os dados da Shopee. Verifique o link e tente novamente.";
      toast.error(msg);
    } finally {
      setBuscandoShopee(false);
    }
  };

  const handleCopiarShopee = () => {
    if (!textoMensagemShopee.trim()) {
      toast.error("Nenhum texto disponível para copiar.");
      return;
    }
    navigator.clipboard.writeText(textoMensagemShopee);
    setCopiadoShopee(true);
    toast.success("Texto copiado para a área de transferência!");
    setTimeout(() => setCopiadoShopee(false), 2500);
  };

  const handleEnviarWhatsAppShopee = async () => {
    if (!dadosShopee) {
      toast.error("Busque os dados do produto primeiro.");
      return;
    }

    setEnviandoShopee(true);
    try {
      const payload = {
        url: dadosShopee.urlOriginal,
        nome: dadosShopee.nome,
        precoAtual: dadosShopee.precoAtual,
        precoOriginal: dadosShopee.precoOriginal,
        descontoPercentual: dadosShopee.descontoPercentual,
        imagemUrl: dadosShopee.imagemUrl,
      };

      const res = await api.post("/api/sends/manual", payload);

      if (res.data?.sucesso) {
        toast.success("Mensagem enviada com sucesso para o grupo do WhatsApp!");
      } else {
        toast.info("Envio concluído com status: " + (res.data?.status || "concluído"));
      }
    } catch (err: any) {
      const code = err.response?.data?.error?.code;
      const msg =
        code === "WHATSAPP_OFFLINE"
          ? "Não é possível enviar: o WhatsApp está desconectado. Conecte um número nas Configurações."
          : err.response?.data?.error?.message ||
            "Falha ao enviar mensagem para o WhatsApp. Verifique se o WhatsApp está conectado.";
      toast.error(msg);
    } finally {
      setEnviandoShopee(false);
    }
  };

  const handleLimparShopee = () => {
    setUrlShopee("");
    setDadosShopee(null);
    setTextoMensagemShopee("");
  };

  // ==========================================
  // FLUXO MERCADO LIVRE
  // ==========================================

  const handleGerarLinkML = async () => {
    if (!urlML.trim()) {
      toast.error("Por favor, cole um link do Mercado Livre.");
      return;
    }

    setGerandoML(true);
    setLinkAfiliadoML("");
    try {
      const res = await api.post("/api/affiliate/ml/link", {
        url: urlML.trim(),
      });

      if (res.data?.sucesso && res.data?.link) {
        setLinkAfiliadoML(res.data.link);
        toast.success("Link de afiliado gerado com sucesso! Preencha o preço e dados abaixo.");
      } else {
        toast.error("Não foi possível gerar o link de afiliado.");
      }
    } catch (err: any) {
      const code = err.response?.data?.error?.code;
      if (code === "SESSAO_ML_EXPIRADA") {
        toast.error("Sessão do Mercado Livre expirada. Atualize os cookies na aba Plataformas.");
      } else {
        const msg =
          err.response?.data?.error?.message ||
          "Erro ao gerar link de afiliado. Verifique o link do Mercado Livre.";
        toast.error(msg);
      }
    } finally {
      setGerandoML(false);
    }
  };

  // Atualizar texto ML em tempo real conforme preenchimento
  useEffect(() => {
    if (linkAfiliadoML) {
      const msg = gerarTextoOferta(nomeML, precoAtualML, precoOriginalML, linkAfiliadoML);
      setTextoMensagemML(msg);
    }
  }, [nomeML, precoAtualML, precoOriginalML, linkAfiliadoML]);

  const handleCopiarML = () => {
    // Conferência rigorosa exigida pelo usuário: verificar campos essenciais
    if (!nomeML.trim()) {
      toast.error("Atenção: Adicione o título/nome do produto antes de copiar.");
      return;
    }

    if (!precoAtualML.trim()) {
      toast.error("Atenção: O preço atual é obrigatório! Preencha o preço da oferta.");
      return;
    }

    const precoNum = Number(precoAtualML.replace(/\./g, "").replace(",", "."));
    if (isNaN(precoNum) || precoNum <= 0) {
      toast.error("Por favor, informe um valor de preço válido (maior que 0).");
      return;
    }

    if (!textoMensagemML.trim()) {
      toast.error("Nenhum texto disponível para copiar.");
      return;
    }

    navigator.clipboard.writeText(textoMensagemML);
    setCopiadoML(true);
    toast.success("Texto copiado! Agora cole manualmente no WhatsApp.");
    setTimeout(() => setCopiadoML(false), 2500);
  };

  const handleLimparML = () => {
    setUrlML("");
    setLinkAfiliadoML("");
    setNomeML("");
    setPrecoAtualML("");
    setPrecoOriginalML("");
    setTextoMensagemML("");
  };

  return (
    <div className="w-full max-w-[390px] mx-auto h-screen overflow-y-auto px-4 pt-6 pb-32 flex flex-col bg-background text-foreground antialiased selection:bg-indigo-100">
      {/* 1. Cabeçalho */}
      <header className="flex flex-col">
        <h1 className="text-[26px] font-bold text-zinc-900 tracking-tight leading-tight">
          Envios manuais
        </h1>
        <p className="text-sm text-zinc-500 mt-1 font-normal">
          Gere links de afiliado e personalize mensagens para envio.
        </p>
      </header>

      {/* 2. Seletor de Plataforma (Segmented Control) */}
      <div className="mt-5 p-1 bg-zinc-200/60 rounded-xl flex items-center gap-1">
        <button
          type="button"
          onClick={() => setPlataforma("shopee")}
          className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
            plataforma === "shopee"
              ? "bg-white text-orange-600 shadow-xs"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          <ShoppingBag className="size-3.5" />
          <span>Shopee</span>
        </button>

        <button
          type="button"
          onClick={() => setPlataforma("mercado_livre")}
          className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
            plataforma === "mercado_livre"
              ? "bg-white text-indigo-600 shadow-xs"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          <Tag className="size-3.5" />
          <span>Mercado Livre</span>
        </button>
      </div>

      {/* ==========================================
          CONTEÚDO DA SHOPEE
          ========================================== */}
      {plataforma === "shopee" && (
        <div className="mt-4 flex flex-col gap-4">
          {/* Card Entrada do Link Shopee */}
          <section className="bg-white rounded-2xl p-4.5 border border-zinc-200/80 shadow-xs flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-zinc-800">
                Link do produto Shopee
              </label>
              {urlShopee && (
                <button
                  type="button"
                  onClick={handleLimparShopee}
                  className="text-[11px] text-zinc-400 hover:text-red-500 flex items-center gap-1 cursor-pointer transition-colors"
                >
                  <Trash2 className="size-3" />
                  <span>Limpar</span>
                </button>
              )}
            </div>

            <div className="flex items-center px-3.5 py-2.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus-within:ring-2 focus-within:ring-orange-500 focus-within:border-transparent">
              <input
                type="url"
                aria-label="URL do produto Shopee"
                value={urlShopee}
                onChange={(e) => setUrlShopee(e.target.value)}
                placeholder="https://shopee.com.br/... ou s.shopee.com.br/..."
                className="w-full bg-transparent focus:outline-none text-zinc-900 placeholder:text-zinc-400"
              />
            </div>

            <button
              type="button"
              disabled={buscandoShopee || !urlShopee.trim()}
              onClick={handleBuscarShopee}
              className="w-full py-2.5 rounded-xl bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {buscandoShopee ? (
                <>
                  <RotateCw className="size-3.5 animate-spin" />
                  <span>Buscando dados e link afiliado...</span>
                </>
              ) : (
                <>
                  <Sparkles className="size-3.5" />
                  <span>Buscar dados e gerar link</span>
                </>
              )}
            </button>
          </section>

          {/* Card Preview do Produto Shopee (se carregado) */}
          {dadosShopee && (
            <section className="bg-white rounded-2xl p-4.5 border border-zinc-200/80 shadow-xs flex flex-col gap-3 animate-in fade-in slide-in-from-top-1">
              <span className="text-xs font-semibold text-zinc-800">
                Produto identificado
              </span>

              <div className="flex gap-3 items-start bg-zinc-50 p-3 rounded-xl border border-zinc-100">
                {dadosShopee.imagemUrl ? (
                  <img
                    src={dadosShopee.imagemUrl}
                    alt={dadosShopee.nome}
                    className="size-16 rounded-lg object-cover shrink-0 border border-zinc-200"
                  />
                ) : (
                  <div className="size-16 rounded-lg bg-zinc-200 flex items-center justify-center shrink-0 text-zinc-400">
                    <ShoppingBag className="size-6" />
                  </div>
                )}

                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <h3 className="text-xs font-semibold text-zinc-900 line-clamp-2 leading-snug">
                    {dadosShopee.nome}
                  </h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-sm font-bold text-orange-600">
                      R$ {dadosShopee.precoAtual}
                    </span>
                    {dadosShopee.descontoPercentual > 0 && (
                      <span className="text-[10px] bg-orange-100 text-orange-700 font-semibold px-1.5 py-0.5 rounded">
                        {dadosShopee.descontoPercentual}% OFF
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Link de Afiliado Gerado */}
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-zinc-500">
                  Link de afiliado gerado:
                </span>
                <div className="px-3 py-2 bg-zinc-50 rounded-lg border border-zinc-200 text-xs text-zinc-700 truncate font-mono">
                  {dadosShopee.linkAfiliado}
                </div>
              </div>
            </section>
          )}

          {/* Card Texto da Mensagem Shopee */}
          {dadosShopee && (
            <section className="bg-white rounded-2xl p-4.5 border border-zinc-200/80 shadow-xs flex flex-col gap-3 animate-in fade-in slide-in-from-top-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-800">
                  Texto da mensagem (editável)
                </span>
                <span className="text-[11px] text-zinc-400 font-normal">
                  Padrão WhatsApp
                </span>
              </div>

              <textarea
                aria-label="Texto da mensagem WhatsApp Shopee"
                rows={6}
                value={textoMensagemShopee}
                onChange={(e) => setTextoMensagemShopee(e.target.value)}
                className="w-full p-3 rounded-xl border border-zinc-200 text-xs text-zinc-900 font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent resize-y"
              />

              <div className="grid grid-cols-2 gap-2 mt-1">
                <button
                  type="button"
                  onClick={handleCopiarShopee}
                  className="py-2.5 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-800 text-xs font-semibold shadow-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {copiadoShopee ? (
                    <>
                      <Check className="size-3.5 text-emerald-600" />
                      <span className="text-emerald-700">Copiado!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="size-3.5 text-zinc-500" />
                      <span>Copiar texto</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={enviandoShopee}
                  onClick={handleEnviarWhatsAppShopee}
                  className="py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {enviandoShopee ? (
                    <>
                      <RotateCw className="size-3.5 animate-spin" />
                      <span>Enviando...</span>
                    </>
                  ) : (
                    <>
                      <Send className="size-3.5" />
                      <span>Enviar no WhatsApp</span>
                    </>
                  )}
                </button>
              </div>
            </section>
          )}
        </div>
      )}

      {/* ==========================================
          CONTEÚDO DO MERCADO LIVRE
          ========================================== */}
      {plataforma === "mercado_livre" && (
        <div className="mt-4 flex flex-col gap-4">
          {/* Card Entrada do Link Mercado Livre */}
          <section className="bg-white rounded-2xl p-4.5 border border-zinc-200/80 shadow-xs flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-zinc-800">
                Link do produto Mercado Livre
              </label>
              {urlML && (
                <button
                  type="button"
                  onClick={handleLimparML}
                  className="text-[11px] text-zinc-400 hover:text-red-500 flex items-center gap-1 cursor-pointer transition-colors"
                >
                  <Trash2 className="size-3" />
                  <span>Limpar</span>
                </button>
              )}
            </div>

            <div className="flex items-center px-3.5 py-2.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus-within:ring-2 focus-within:ring-indigo-600 focus-within:border-transparent">
              <input
                type="url"
                aria-label="URL do produto Mercado Livre"
                value={urlML}
                onChange={(e) => setUrlML(e.target.value)}
                placeholder="https://produto.mercadolivre.com.br/MLB-..."
                className="w-full bg-transparent focus:outline-none text-zinc-900 placeholder:text-zinc-400"
              />
            </div>

            <button
              type="button"
              disabled={gerandoML || !urlML.trim()}
              onClick={handleGerarLinkML}
              className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {gerandoML ? (
                <>
                  <RotateCw className="size-3.5 animate-spin" />
                  <span>Gerando link de afiliado...</span>
                </>
              ) : (
                <>
                  <Sparkles className="size-3.5" />
                  <span>Gerar link de afiliado</span>
                </>
              )}
            </button>
          </section>

          {/* Se link gerado: Formulário de Preenchimento Manual */}
          {linkAfiliadoML && (
            <section className="bg-white rounded-2xl p-4.5 border border-zinc-200/80 shadow-xs flex flex-col gap-3.5 animate-in fade-in slide-in-from-top-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-900">
                  Dados da oferta (Preenchimento manual)
                </span>
                <span className="text-[10px] bg-amber-50 text-amber-700 font-medium px-2 py-0.5 rounded border border-amber-200/60">
                  Manual
                </span>
              </div>

              <div className="p-2.5 bg-amber-50/60 rounded-xl border border-amber-100 flex items-start gap-2">
                <AlertCircle className="size-4 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-800 leading-snug">
                  O Mercado Livre não extrai dados automaticamente. Preencha o título e o preço abaixo para gerar o texto.
                </p>
              </div>

              {/* Link Afiliado Gerado */}
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-zinc-500">
                  Link de afiliado gerado:
                </span>
                <div className="px-3 py-2 bg-zinc-50 rounded-lg border border-zinc-200 text-xs text-indigo-600 truncate font-mono">
                  {linkAfiliadoML}
                </div>
              </div>

              {/* Campo Nome/Título */}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-700">
                  Título do produto <span className="text-red-500">*</span>
                </label>
                <div className="flex items-center px-3.5 py-2.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus-within:ring-2 focus-within:ring-indigo-600 focus-within:border-transparent">
                  <input
                    type="text"
                    aria-label="Título do produto Mercado Livre"
                    value={nomeML}
                    onChange={(e) => setNomeML(e.target.value)}
                    placeholder="Ex: Smartphone Samsung Galaxy A54 128GB"
                    className="w-full bg-transparent focus:outline-none text-zinc-900 placeholder:text-zinc-400"
                  />
                </div>
              </div>

              {/* Linha Preço Atual e Preço Original */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-zinc-700">
                    Preço atual (R$) <span className="text-red-500">*</span>
                  </label>
                  <div className="flex items-center px-3.5 py-2.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus-within:ring-2 focus-within:ring-indigo-600 focus-within:border-transparent">
                    <input
                      type="text"
                      aria-label="Preço atual do produto"
                      value={precoAtualML}
                      onChange={(e) => setPrecoAtualML(e.target.value)}
                      placeholder="Ex: 99,90"
                      className="w-full bg-transparent focus:outline-none text-zinc-900 placeholder:text-zinc-400 font-semibold"
                    />
                  </div>
                  {!precoAtualML.trim() && (
                    <span className="text-[10px] text-red-500 font-medium">
                      Obrigatório
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-zinc-700">
                    Preço original (R$)
                  </label>
                  <div className="flex items-center px-3.5 py-2.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus-within:ring-2 focus-within:ring-indigo-600 focus-within:border-transparent">
                    <input
                      type="text"
                      aria-label="Preço original do produto"
                      value={precoOriginalML}
                      onChange={(e) => setPrecoOriginalML(e.target.value)}
                      placeholder="Ex: 149,90"
                      className="w-full bg-transparent focus:outline-none text-zinc-900 placeholder:text-zinc-400"
                    />
                  </div>
                  <span className="text-[10px] text-zinc-400">Opcional</span>
                </div>
              </div>
            </section>
          )}

          {/* Card Texto da Mensagem Mercado Livre (Editável & Apenas Copiar) */}
          {linkAfiliadoML && (
            <section className="bg-white rounded-2xl p-4.5 border border-zinc-200/80 shadow-xs flex flex-col gap-3 animate-in fade-in slide-in-from-top-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-800">
                  Texto da mensagem (editável)
                </span>
                <span className="text-[11px] text-zinc-400 font-normal">
                  Envio manual
                </span>
              </div>

              <textarea
                aria-label="Texto da mensagem WhatsApp Mercado Livre"
                rows={6}
                value={textoMensagemML}
                onChange={(e) => setTextoMensagemML(e.target.value)}
                placeholder="Preencha o título e o preço acima para gerar o texto da oferta..."
                className="w-full p-3 rounded-xl border border-zinc-200 text-xs text-zinc-900 font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent resize-y"
              />

              {/* Botão Apenas Copiar (Sem botão WhatsApp direto, conforme regra) */}
              <button
                type="button"
                onClick={handleCopiarML}
                className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                {copiadoML ? (
                  <>
                    <Check className="size-3.5 text-white" />
                    <span>Texto copiado para a área de transferência!</span>
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" />
                    <span>Copiar texto para enviar no WhatsApp</span>
                  </>
                )}
              </button>

              <p className="text-[11px] text-zinc-400 text-center leading-normal">
                No Mercado Livre, copie a mensagem e cole diretamente no seu WhatsApp.
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
