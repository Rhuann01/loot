import { useState, useEffect } from "react";
import {
  Search,
  MoreHorizontal,
  Eye,
  Copy,
  Send,
  Trash2,
  ArrowLeft,
  Clock,
  CheckCircle2,
  AlertCircle,
  Package,
  Sparkles,
  RotateCw,
} from "lucide-react";
import { api } from "@/services/api";
import { toast } from "../ui/sonner";

interface Produto {
  id: number;
  plataforma: { key: string; nome: string };
  nome: string;
  precoAtual: string;
  precoOriginal: string | null;
  descontoPercentual: number;
  imagemUrl: string | null;
  linkOriginal: string | null;
  linkAfiliado: string | null;
  linkAfiliadoValido: boolean;
  status: "pending" | "sent" | "failed" | "needs_review";
  needsReview: boolean;
  emAndamento: boolean;
  selecionado: boolean;
  tentativas: number;
  ultimoErro: string | null;
  ofertaExpiraEm: string | null;
  criadoEm: string;
  comissao?: {
    valor: number | null;
    disponivel: boolean;
    estimada: boolean;
  };
}

interface TentativaItem {
  id: number;
  origem: string;
  status: string;
  needsReview: boolean;
  motivo?: string;
  iniciadoEm: string;
  finalizadoEm?: string;
  destino: { id: string; nome: string };
}

interface ProdutoDetalhe extends Omit<Produto, "tentativas" | "comissao"> {
  comissao: {
    valor: number | null;
    percentual: number | null;
    disponivel: boolean;
    estimada: boolean;
    coletadaEm: string | null;
  };
  pedidos: {
    disponivel: boolean;
    motivo: string;
  };
  tentativas: TentativaItem[];
}

function formatarMoeda(valor: number | string | null | undefined): string {
  if (valor === null || valor === undefined || valor === "") return "R$ 0,00";
  const num = typeof valor === "string" ? parseFloat(valor.replace(",", ".")) : valor;
  if (isNaN(num)) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(num);
}

function formatarPreco(val: string | number | null | undefined): string {
  if (val === null || val === undefined || val === "") return "";
  const str = String(val).trim();
  if (str.includes(",")) return str;
  if (str.includes(".")) {
    const num = parseFloat(str);
    if (!isNaN(num)) return num.toFixed(2).replace(".", ",");
    return str.replace(".", ",");
  }
  return str;
}

function parseDataUtc(dataStr: string): Date {
  const s = dataStr.includes(" ") && !dataStr.includes("T") ? dataStr.replace(" ", "T") + "Z" : dataStr;
  return new Date(s);
}

function formatarDataHora(dataStr: string): string {
  try {
    const d = parseDataUtc(dataStr);
    if (isNaN(d.getTime())) return dataStr;
    const dia = String(d.getDate()).padStart(2, "0");
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${dia}/${mes}, ${hh}:${mm}`;
  } catch {
    return dataStr;
  }
}

function formatarDataCompleta(dataStr: string): string {
  try {
    const d = parseDataUtc(dataStr);
    if (isNaN(d.getTime())) return dataStr;
    const dia = String(d.getDate()).padStart(2, "0");
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    const ano = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${dia}/${mes}/${ano} às ${hh}:${mm}`;
  } catch {
    return dataStr;
  }
}

const Promocoes = () => {
  const [produtos, setProdutos] = useState<Produto[]>([]);
  const [total, setTotal] = useState(0);
  const [totalArmazenadas, setTotalArmazenadas] = useState(0);
  const [coletadasHoje, setColetadasHoje] = useState(0);
  const [abaAtiva, setAbaAtiva] = useState<"all" | "not_sent" | "sent">("all");
  const [termoBusca, setTermoBusca] = useState("");
  const [pagina, setPagina] = useState(1);
  const [carregando, setCarregando] = useState(false);
  const [menuAbertoId, setMenuAbertoId] = useState<number | null>(null);
  const [produtoSelecionado, setProdutoSelecionado] = useState<ProdutoDetalhe | null>(null);
  const limite = 10;

  const mostrarToast = (msg: string, tipo?: "success" | "error" | "info") => {
    if (tipo === "success") {
      toast.success(msg);
    } else if (tipo === "error") {
      toast.error(msg);
    } else {
      toast(msg);
    }
  };

  // Carrega contadores do Dashboard (coletadas hoje)
  useEffect(() => {
    api.get("/api/dashboard").then((res) => {
      if (res.data?.today?.coletadas !== undefined) {
        setColetadasHoje(res.data.today.coletadas);
      }
    }).catch(() => {});
  }, []);

  // Carrega produtos da rota /api/produtos
  useEffect(() => {
    let ativo = true;
    setCarregando(true);

    const params: Record<string, string | number> = {
      status: abaAtiva,
      page: pagina,
      limit: limite,
    };
    if (termoBusca.trim()) {
      params.q = termoBusca.trim();
    }

    api
      .get("/api/produtos", { params })
      .then((res) => {
        if (!ativo || !res.data) return;
        setProdutos(res.data.items || []);
        setTotal(res.data.total ?? 0);
        if (res.data.counts?.all !== undefined) {
          setTotalArmazenadas(res.data.counts.all);
        }
      })
      .catch((err) => {
        console.error("Falha ao carregar promoções:", err);
      })
      .finally(() => {
        if (ativo) setCarregando(false);
      });

    return () => {
      ativo = false;
    };
  }, [abaAtiva, termoBusca, pagina]);

  const abrirDetalhes = (prodId: number) => {
    setMenuAbertoId(null);
    api
      .get(`/api/produtos/${prodId}`)
      .then((res) => {
        setProdutoSelecionado(res.data);
      })
      .catch((err) => {
        console.error("Falha ao buscar detalhes do produto:", err);
        mostrarToast("Erro ao abrir detalhes.");
      });
  };

  const copiarLink = (link: string | null) => {
    if (!link) {
      mostrarToast("Link não disponível.");
      return;
    }
    navigator.clipboard.writeText(link);
    mostrarToast("Link copiado para a área de transferência!");
    setMenuAbertoId(null);
  };

  const [gerandoLinkId, setGerandoLinkId] = useState<number | null>(null);

  const enviarAgora = async (prodId: number) => {
    setMenuAbertoId(null);
    mostrarToast("Gerando link de afiliado e enviando para o WhatsApp...");
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await api.post(
        `/api/produtos/${prodId}/reenviar`,
        {},
        { headers: { "Idempotency-Key": idempotencyKey } }
      );
      if (res.status === 200 || res.status === 202) {
        mostrarToast("Promoção enviada com sucesso!");
        const novoLink = res.data?.linkAfiliado;
        // Atualiza a lista
        setProdutos((prev) =>
          prev.map((p) =>
            p.id === prodId
              ? {
                  ...p,
                  status: "sent",
                  linkAfiliado: novoLink || p.linkAfiliado,
                  linkAfiliadoValido: Boolean(novoLink && novoLink !== p.linkOriginal),
                }
              : p
          )
        );
        if (produtoSelecionado && produtoSelecionado.id === prodId) {
          setProdutoSelecionado((prev) =>
            prev
              ? {
                  ...prev,
                  status: "sent",
                  linkAfiliado: novoLink || prev.linkAfiliado,
                  linkAfiliadoValido: Boolean(novoLink && novoLink !== prev.linkOriginal),
                }
              : null
          );
        }
      }
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || "Falha ao enviar promoção.";
      mostrarToast(msg);
    }
  };

  const handleGerarLinkAvulso = async (prodId: number) => {
    setGerandoLinkId(prodId);
    mostrarToast("Gerando link de afiliado...");
    try {
      const res = await api.post(`/api/produtos/${prodId}/gerar-link`);
      if (res.data?.sucesso && res.data?.linkAfiliado) {
        const novoLink = res.data.linkAfiliado;
        mostrarToast("Link de afiliado gerado com sucesso!");
        setProdutos((prev) =>
          prev.map((p) =>
            p.id === prodId
              ? {
                  ...p,
                  linkAfiliado: novoLink,
                  linkAfiliadoValido: true,
                }
              : p
          )
        );
        if (produtoSelecionado && produtoSelecionado.id === prodId) {
          setProdutoSelecionado((prev) =>
            prev
              ? {
                  ...prev,
                  linkAfiliado: novoLink,
                  linkAfiliadoValido: true,
                }
              : null
          );
        }
      }
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message || "Falha ao gerar link de afiliado.";
      mostrarToast(msg);
    } finally {
      setGerandoLinkId(null);
    }
  };

  const totalPaginas = Math.ceil(total / limite) || 1;
  const inicioItem = total === 0 ? 0 : (pagina - 1) * limite + 1;
  const fimItem = Math.min(pagina * limite, total);

  // VIEW 1: DETALHES DA PROMOÇÃO (quando um produto é clicado)
  if (produtoSelecionado) {
    const p = produtoSelecionado;
    const linkParaExibir = p.linkAfiliado || p.linkOriginal || "";
    const isShopee = p.plataforma.key === "shopee";

    return (
      <div className="w-full max-w-[390px] mx-auto h-screen overflow-y-auto px-4 pt-6 pb-32 flex flex-col bg-background text-foreground antialiased selection:bg-indigo-100">
        {/* Botão Voltar */}
        <button
          onClick={() => setProdutoSelecionado(null)}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900 font-medium transition-colors cursor-pointer w-fit"
        >
          <ArrowLeft className="size-4" /> Promoções
        </button>

        {/* Título */}
        <header className="mt-3 flex flex-col">
          <h1 className="text-[26px] font-bold text-zinc-900 tracking-tight leading-tight">
            Detalhes da promoção
          </h1>
          <p className="text-sm text-zinc-500 mt-1 font-normal">
            Informações do produto e dados da integração.
          </p>
        </header>

        {/* Card Principal do Produto */}
        <section className="mt-5 bg-white rounded-2xl p-4 border border-zinc-200/70 shadow-xs flex flex-col gap-3">
          {/* Imagem do Produto */}
          <div className="w-full h-48 rounded-xl bg-zinc-50 border border-zinc-100 flex items-center justify-center overflow-hidden">
            {p.imagemUrl ? (
              <img
                src={p.imagemUrl}
                alt={p.nome}
                className="w-full h-full object-contain p-2"
              />
            ) : (
              <Package className="size-16 text-zinc-300" />
            )}
          </div>

          {/* Badges de Plataforma e Status */}
          <div className="flex items-center gap-2 mt-1">
            <span className="bg-zinc-100 text-zinc-600 text-xs font-medium px-2 py-0.5 rounded">
              {p.plataforma.nome}
            </span>
            {p.status === "sent" ? (
              <span className="bg-emerald-50 text-emerald-700 text-xs font-medium px-2 py-0.5 rounded">
                Enviado
              </span>
            ) : p.status === "failed" ? (
              <span className="bg-rose-50 text-rose-600 text-xs font-medium px-2 py-0.5 rounded">
                Falhou
              </span>
            ) : (
              <span className="bg-zinc-100 text-zinc-500 text-xs font-medium px-2 py-0.5 rounded">
                Não enviado
              </span>
            )}
          </div>

          {/* Nome do Produto */}
          <h2 className="text-base font-bold text-zinc-900 tracking-tight leading-snug">
            {p.nome}
          </h2>

          {/* Preço e Desconto */}
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="text-2xl font-bold text-zinc-900 tracking-tight">
              R$ {formatarPreco(p.precoAtual)}
            </span>
            {p.descontoPercentual > 0 && (
              <span className="bg-[#EEF2FF] text-[#4338CA] text-xs font-semibold px-2 py-0.5 rounded">
                -{p.descontoPercentual}%
              </span>
            )}
          </div>

          {p.precoOriginal && (
            <span className="text-xs text-zinc-400 line-through -mt-1 font-normal">
              De R$ {formatarPreco(p.precoOriginal)}
            </span>
          )}

          {/* Data de coleta */}
          <span className="text-xs text-zinc-400 font-normal mt-1">
            Coletada em {formatarDataCompleta(p.criadoEm)}
          </span>

          {/* Botões de Ação */}
          <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-zinc-100">
            <button
              onClick={() => enviarAgora(p.id)}
              className="w-full bg-[#4F46E5] hover:bg-[#4338CA] text-white font-medium text-xs py-2.5 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-colors shadow-xs cursor-pointer"
            >
              <Send className="size-3.5" /> Enviar agora
            </button>
            <button
              onClick={() => copiarLink(linkParaExibir)}
              className="w-full bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700 font-medium text-xs py-2.5 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-colors shadow-xs cursor-pointer"
            >
              <Copy className="size-3.5" /> Copiar link
            </button>
          </div>
        </section>

        {/* Card Link da Promoção */}
        <section className="mt-4 bg-white rounded-2xl p-4 border border-zinc-200/70 shadow-xs flex flex-col gap-2">
          <h3 className="text-base font-bold text-zinc-900 tracking-tight">
            Link da promoção
          </h3>
          <span className="text-xs text-zinc-400 font-medium">Link</span>
          <p className="text-xs text-[#4F46E5] font-normal break-all select-all">
            {linkParaExibir || "Nenhum link gerado"}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => copiarLink(linkParaExibir)}
              className="w-fit bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700 font-medium text-xs py-2 px-3 rounded-xl flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer"
            >
              <Copy className="size-3.5" /> Copiar link
            </button>

            {(!p.linkAfiliadoValido || p.linkAfiliado === p.linkOriginal) && (
              <button
                type="button"
                disabled={gerandoLinkId === p.id}
                onClick={() => handleGerarLinkAvulso(p.id)}
                className="w-fit bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-medium text-xs py-2 px-3 rounded-xl flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer disabled:opacity-50"
              >
                {gerandoLinkId === p.id ? (
                  <>
                    <RotateCw className="size-3.5 animate-spin" />
                    <span>Gerando...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="size-3.5" />
                    <span>Gerar link afiliado</span>
                  </>
                )}
              </button>
            )}
          </div>
        </section>

        {/* Card Comissão */}
        {isShopee ? (
          <section className="mt-4 bg-white rounded-2xl p-4 border border-zinc-200/70 shadow-xs flex flex-col gap-2">
            <h3 className="text-base font-bold text-zinc-900 tracking-tight">
              Estimativa de comissão
            </h3>
            <span className="text-xs text-zinc-400">
              Dados da Shopee · {p.comissao.coletadaEm ? `Recebida em ${formatarDataHora(p.comissao.coletadaEm)}` : "Estimada"}
            </span>

            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500 font-normal">Comissão líquida estimada</span>
                <span className="font-bold text-emerald-600">
                  {p.comissao.valor !== null ? formatarMoeda(p.comissao.valor) : "Sob consulta"}
                </span>
              </div>
              {p.comissao.percentual !== null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-zinc-500 font-normal">Taxa estimada</span>
                  <span className="font-medium text-zinc-900">
                    {p.comissao.percentual}%
                  </span>
                </div>
              )}
            </div>
          </section>
        ) : (
          <section className="mt-4 bg-white rounded-2xl p-4 border border-zinc-200/70 shadow-xs flex flex-col gap-2">
            <h3 className="text-base font-bold text-zinc-900 tracking-tight">
              Detalhes · Mercado Livre
            </h3>
            <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
              Esta integração não fornece dados de pedidos ou comissão. Campos exclusivos da Shopee não se aplicam.
            </p>
            <div className="mt-2 space-y-2 divide-y divide-zinc-100">
              <div className="flex items-center justify-between text-sm pt-2">
                <span className="text-zinc-500">Comissão</span>
                <span className="text-zinc-700 font-medium">Não disponível</span>
              </div>
              <div className="flex items-center justify-between text-sm pt-2">
                <span className="text-zinc-500">Pedidos</span>
                <span className="text-zinc-700 font-medium">Não disponível</span>
              </div>
            </div>
          </section>
        )}

        {/* Card Histórico de Envio */}
        <section className="mt-4 bg-white rounded-2xl p-4 border border-zinc-200/70 shadow-xs flex flex-col gap-2">
          <h3 className="text-base font-bold text-zinc-900 tracking-tight">
            Histórico de envio
          </h3>

          {p.tentativas && p.tentativas.length > 0 ? (
            <div className="divide-y divide-zinc-100 mt-1">
              {p.tentativas.map((t) => (
                <div key={t.id} className="py-2.5 flex items-start gap-2.5">
                  {t.status === "sent" ? (
                    <CheckCircle2 className="size-4 text-emerald-600 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="size-4 text-rose-500 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-900">
                      Envio {t.status === "sent" ? "concluído" : "falhou"} · {t.destino?.nome || "WhatsApp"}
                    </p>
                    <span className="text-[11px] text-zinc-400">
                      {formatarDataHora(t.finalizadoEm || t.iniciadoEm)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-3 flex items-center gap-3">
              <Clock className="size-5 text-zinc-400 shrink-0" />
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-zinc-900">
                  Ainda não enviado nesta coleta
                </span>
                <span className="text-xs text-zinc-500 mt-0.5">
                  Nenhum envio ao destino Ofertas do dia.
                </span>
              </div>
            </div>
          )}
        </section>
      </div>
    );
  }

  // VIEW 2: LISTAGEM DE PROMOÇÕES (Padrão do Figma)
  return (
    <div className="w-full max-w-[390px] mx-auto h-screen overflow-y-auto px-4 pt-6 pb-32 flex flex-col bg-background text-foreground antialiased selection:bg-indigo-100">
      {/* 1. Cabeçalho */}
      <header className="flex flex-col">
        <h1 className="text-[26px] font-bold text-zinc-900 tracking-tight leading-tight">
          Promoções
        </h1>
        <p className="text-sm text-zinc-500 mt-1 font-normal">
          {coletadasHoje} coletadas hoje · {totalArmazenadas} promoções armazenadas
        </p>
      </header>

      {/* 2. Campo de Busca */}
      <div className="relative mt-5">
        <input
          type="text"
          placeholder="Buscar por produto"
          value={termoBusca}
          onChange={(e) => {
            setTermoBusca(e.target.value);
            setPagina(1);
          }}
          className="w-full bg-white border border-zinc-200/80 rounded-xl px-4 py-2.5 pr-10 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs transition-all"
        />
        <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 size-4 text-zinc-400 pointer-events-none" />
      </div>

      {/* 3. Segmented Control (Abas) */}
      <div className="mt-3 bg-zinc-100 p-1 rounded-xl flex items-center">
        <button
          onClick={() => {
            setAbaAtiva("all");
            setPagina(1);
          }}
          className={`flex-1 py-1.5 text-xs rounded-lg transition-all text-center cursor-pointer ${
            abaAtiva === "all"
              ? "bg-white text-zinc-900 font-semibold shadow-xs"
              : "text-zinc-500 hover:text-zinc-900 font-medium"
          }`}
        >
          Todas
        </button>
        <button
          onClick={() => {
            setAbaAtiva("not_sent");
            setPagina(1);
          }}
          className={`flex-1 py-1.5 text-xs rounded-lg transition-all text-center cursor-pointer ${
            abaAtiva === "not_sent"
              ? "bg-white text-zinc-900 font-semibold shadow-xs"
              : "text-zinc-500 hover:text-zinc-900 font-medium"
          }`}
        >
          Não enviadas
        </button>
        <button
          onClick={() => {
            setAbaAtiva("sent");
            setPagina(1);
          }}
          className={`flex-1 py-1.5 text-xs rounded-lg transition-all text-center cursor-pointer ${
            abaAtiva === "sent"
              ? "bg-white text-zinc-900 font-semibold shadow-xs"
              : "text-zinc-500 hover:text-zinc-900 font-medium"
          }`}
        >
          Enviadas
        </button>
      </div>

      {/* 4. Linha de Contexto / Contagem */}
      <div className="mt-4 flex items-center justify-between text-xs text-zinc-500 font-normal">
        <span>Todas as plataformas</span>
        <span>{total} {total === 1 ? "resultado" : "resultados"}</span>
      </div>

      {/* 5. Lista de Produtos */}
      <div className="mt-3 flex flex-col gap-3">
        {carregando ? (
          <div className="py-12 text-center text-xs text-zinc-400">
            Carregando promoções...
          </div>
        ) : produtos.length === 0 ? (
          <div className="bg-white rounded-2xl p-8 border border-zinc-200/70 text-center flex flex-col items-center">
            <Package className="size-10 text-zinc-300 mb-2" />
            <p className="text-sm font-semibold text-zinc-700">Nenhuma promoção encontrada</p>
            <p className="text-xs text-zinc-400 mt-1">
              {termoBusca ? "Tente buscar com outros termos." : "Não há produtos cadastrados nesta aba."}
            </p>
          </div>
        ) : (
          produtos.map((p) => {
            const isMenuAberto = menuAbertoId === p.id;
            const isShopee = p.plataforma.key === "shopee";

            return (
              <div
                key={p.id}
                onClick={() => abrirDetalhes(p.id)}
                className="relative bg-white rounded-2xl p-3.5 border border-zinc-200/70 shadow-xs flex flex-col gap-2.5 cursor-pointer hover:border-zinc-300 transition-colors"
              >
                {/* Linha Superior: Imagem + Informações Principais */}
                <div className="flex items-start gap-3">
                  {/* Thumbnail */}
                  <div className="w-[72px] h-[72px] rounded-xl bg-zinc-50 border border-zinc-100 shrink-0 flex items-center justify-center overflow-hidden">
                    {p.imagemUrl ? (
                      <img
                        src={p.imagemUrl}
                        alt={p.nome}
                        className="w-full h-full object-contain p-1"
                      />
                    ) : (
                      <Package className="size-7 text-zinc-300" />
                    )}
                  </div>

                  {/* Informações da Promoção */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-1">
                      <h2 className="text-sm font-bold text-zinc-900 leading-snug line-clamp-1">
                        {p.nome}
                      </h2>
                      {/* Botão Menu de Ações (...) */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuAbertoId(isMenuAberto ? null : p.id);
                        }}
                        className="text-zinc-400 hover:text-zinc-700 p-1 -mr-1 -mt-1 rounded-lg transition-colors cursor-pointer"
                        aria-label="Ações do produto"
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                    </div>

                    {/* Plataforma e Data */}
                    <p className="text-xs text-zinc-400 mt-0.5 font-normal">
                      {p.plataforma.nome} · {formatarDataHora(p.criadoEm)}
                    </p>

                    {/* Preços e Desconto */}
                    <div className="flex items-center gap-1.5 mt-1">
                      {p.precoOriginal && (
                        <>
                          <span className="text-xs text-zinc-400 line-through">
                            R$ {formatarPreco(p.precoOriginal)}
                          </span>
                          <span className="text-zinc-300 text-xs">→</span>
                        </>
                      )}
                      <span className="text-sm font-bold text-zinc-900">
                        R$ {formatarPreco(p.precoAtual)}
                      </span>
                      {p.descontoPercentual > 0 && (
                        <span className="text-xs text-indigo-600 font-medium">
                          · -{p.descontoPercentual}%
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Linha Inferior: Comissão e Badge de Status */}
                <div className="flex items-center justify-between pt-1 border-t border-zinc-100 text-xs">
                  <div>
                    {isShopee ? (
                      p.comissao?.valor !== null && p.comissao?.valor !== undefined ? (
                        <span className="text-emerald-600 font-medium">
                          Comissão {formatarMoeda(p.comissao.valor)}
                        </span>
                      ) : (
                        <span className="text-zinc-400 font-normal">
                          Comissão sob consulta
                        </span>
                      )
                    ) : (
                      <span className="text-zinc-400 font-normal">
                        Comissão Não disponível
                      </span>
                    )}
                  </div>

                  <div>
                    {p.status === "sent" ? (
                      <span className="bg-emerald-50 text-emerald-700 text-[11px] font-medium px-2.5 py-0.5 rounded-md">
                        Enviado
                      </span>
                    ) : p.status === "failed" ? (
                      <span className="bg-rose-50 text-rose-600 text-[11px] font-medium px-2.5 py-0.5 rounded-md">
                        Falhou
                      </span>
                    ) : p.status === "needs_review" ? (
                      <span className="bg-amber-50 text-amber-700 text-[11px] font-medium px-2.5 py-0.5 rounded-md">
                        Verificar
                      </span>
                    ) : (
                      <span className="bg-zinc-100 text-zinc-500 text-[11px] font-medium px-2.5 py-0.5 rounded-md">
                        Não enviado
                      </span>
                    )}
                  </div>
                </div>

                {/* MENU DE AÇÕES DROP DOWN (Figma: Promoções · 390 · Menu de ações.png) */}
                {isMenuAberto && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-3 top-10 z-30 bg-white rounded-2xl shadow-xl border border-zinc-100 p-1.5 min-w-[175px] flex flex-col gap-0.5 animate-in fade-in zoom-in-95"
                  >
                    <button
                      onClick={() => abrirDetalhes(p.id)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 rounded-xl transition-colors text-left cursor-pointer"
                    >
                      <Eye className="size-4 text-zinc-500" />
                      Ver detalhes
                    </button>
                    <button
                      onClick={() => copiarLink(p.linkAfiliado || p.linkOriginal)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 rounded-xl transition-colors text-left cursor-pointer"
                    >
                      <Copy className="size-4 text-zinc-500" />
                      Copiar link
                    </button>
                    <button
                      onClick={() => enviarAgora(p.id)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 rounded-xl transition-colors text-left cursor-pointer"
                    >
                      <Send className="size-4 text-zinc-500" />
                      Enviar agora
                    </button>
                    <button
                      onClick={() => {
                        setMenuAbertoId(null);
                        mostrarToast("Exclusão não disponível nesta versão.");
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50 rounded-xl transition-colors text-left cursor-pointer"
                    >
                      <Trash2 className="size-4 text-rose-500" />
                      Excluir
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 6. Paginação */}
      {total > 0 && (
        <div className="mt-6 flex items-center justify-between text-xs text-zinc-500 font-normal">
          <span>
            {inicioItem}-{fimItem} de {total} promoções
          </span>
          <div className="flex items-center gap-2">
            <button
              disabled={pagina <= 1}
              onClick={() => setPagina((curr) => Math.max(1, curr - 1))}
              className="px-3 py-1.5 rounded-xl border border-zinc-200 bg-white text-zinc-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-50 shadow-xs transition-colors cursor-pointer"
            >
              Anterior
            </button>
            <button
              disabled={pagina >= totalPaginas}
              onClick={() => setPagina((curr) => Math.min(totalPaginas, curr + 1))}
              className="px-3 py-1.5 rounded-xl border border-zinc-200 bg-white text-zinc-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-50 shadow-xs transition-colors cursor-pointer"
            >
              Próxima
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Promocoes;
