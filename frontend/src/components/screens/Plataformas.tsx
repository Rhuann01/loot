import { useState, useEffect } from "react";
import { Plug, Settings, RotateCw, Unplug, Info, X } from "lucide-react";
import { api } from "../../services/api";
import { toast } from "../ui/sonner";

interface ComissaoHoje {
  valor: number | null;
  disponivel: boolean;
  estimada: boolean;
  motivo?: string;
}

interface PlataformaItem {
  key: string;
  nome: string;
  status: string;
  available: boolean;
  ativo: boolean;
  ultimaSincronizacao: string | null;
  totalProdutos: number;
  comissaoHoje: ComissaoHoje;
  erro: string | null;
  motivo?: string;
}

interface ShopeeConfig {
  key: string;
  nome: string;
  appId: string | null;
  apiKey: string | null;
  apiKeyConfigurada: boolean;
  status: string;
  ultimaSincronizacao: string | null;
}

interface MlConfig {
  configurado: boolean;
  tag: string | null;
  atualizadoEm: string | null;
  apifyTokenConfigurado?: boolean;
  apifyToken?: string | null;
}

function formatarMoeda(valor: number | string | null | undefined): string {
  if (valor === null || valor === undefined || valor === "") return "R$ 0,00";
  const num =
    typeof valor === "string" ? parseFloat(valor.replace(",", ".")) : valor;
  if (isNaN(num)) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(num);
}

function formatarDataRelativa(dataStr: string | null | undefined): string {
  if (!dataStr) return "Não disponível";
  try {
    const rawData = dataStr.includes(" ") && !dataStr.includes("T") ? dataStr.replace(" ", "T") + "Z" : dataStr;
    const d = new Date(rawData);
    if (isNaN(d.getTime())) return dataStr;

    const agora = new Date();
    const hoje = new Date(
      agora.getFullYear(),
      agora.getMonth(),
      agora.getDate(),
    );
    const dataComparar = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDias = Math.round(
      (hoje.getTime() - dataComparar.getTime()) / (1000 * 60 * 60 * 24),
    );

    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");

    if (diffDias === 0) {
      return `Hoje, ${hh}:${mm}`;
    } else if (diffDias === 1) {
      return `Ontem, ${hh}:${mm}`;
    } else {
      const dia = String(d.getDate()).padStart(2, "0");
      const mes = String(d.getMonth() + 1).padStart(2, "0");
      return `${dia}/${mes}, ${hh}:${mm}`;
    }
  } catch {
    return dataStr;
  }
}

const ORDEM_PLATAFORMAS: Record<string, number> = {
  shopee: 1,
  mercado_livre: 2,
  tiktok_shop: 3,
};

export default function Plataformas() {
  const [plataformas, setPlataformas] = useState<PlataformaItem[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [sincronizandoKey, setSincronizandoKey] = useState<string | null>(null);
  const [alternandoAtivoKey, setAlternandoAtivoKey] = useState<string | null>(
    null,
  );

  // Modais
  const [modalShopeeAberto, setModalShopeeAberto] = useState(false);
  const [shopeeConfig, setShopeeConfig] = useState<ShopeeConfig | null>(null);
  const [modalAdicionarAberto, setModalAdicionarAberto] = useState(false);
  const [modalMlAberto, setModalMlAberto] = useState(false);
  const [modalTiktokAberto, setModalTiktokAberto] = useState(false);

  // Edição de Shopee Config
  const [inputAppId, setInputAppId] = useState("");
  const [inputApiKey, setInputApiKey] = useState("");
  const [salvandoConfig, setSalvandoConfig] = useState(false);

  // Edição de Mercado Livre Config
  const [mlConfig, setMlConfig] = useState<MlConfig | null>(null);
  const [mlCookie, setMlCookie] = useState("");
  const [mlCsrfToken, setMlCsrfToken] = useState("");
  const [mlTag, setMlTag] = useState("");
  const [mlApifyToken, setMlApifyToken] = useState("");
  const [salvandoMl, setSalvandoMl] = useState(false);

  const mostrarToast = (msg: string, tipo?: "success" | "error" | "info") => {
    if (tipo === "success") {
      toast.success(msg);
    } else if (tipo === "error") {
      toast.error(msg);
    } else {
      toast(msg);
    }
  };

  // Carrega lista de plataformas
  const carregarPlataformas = async () => {
    try {
      const res = await api.get("/api/platforms");
      if (Array.isArray(res.data)) {
        setPlataformas(res.data);
      }
    } catch (err) {
      console.error("Falha ao carregar plataformas:", err);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    carregarPlataformas();
  }, []);

  // Sincronizar plataforma agora
  const handleSincronizar = async (key: string) => {
    if (key === "mercado_livre") {
      mostrarToast("A coleta do Mercado Livre é automatizada diariamente para economizar créditos.", "info");
      return;
    }

    const plat = plataformas.find((p) => p.key === key);
    if (plat && !plat.available) {
      mostrarToast(plat.motivo || "Não disponível nesta versão");
      return;
    }

    setSincronizandoKey(key);
    mostrarToast(`Iniciando sincronização de ${plat?.nome || key}...`);

    try {
      const res = await api.post(`/api/platforms/${key}/sync`);
      if (res.data?.sucesso) {
        mostrarToast(`Sincronização concluída com sucesso!`, "success");
      } else {
        mostrarToast("Sincronização finalizada.");
      }
      await carregarPlataformas();
      if (modalShopeeAberto) {
        await carregarShopeeConfig();
      }
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message || "Erro ao sincronizar plataforma.";
      mostrarToast(msg, "error");
    } finally {
      setSincronizandoKey(null);
    }
  };

  // Alternar ativo/desativado
  const handleToggleAtivo = async (key: string, ativoAtual: boolean) => {
    const plat = plataformas.find((p) => p.key === key);
    if (plat && !plat.available) {
      mostrarToast(plat.motivo || "Não disponível nesta versão");
      return;
    }

    setAlternandoAtivoKey(key);
    const novoAtivo = !ativoAtual;
    try {
      await api.put(`/api/platforms/${key}/active`, { active: novoAtivo });
      mostrarToast(
        novoAtivo
          ? `${plat?.nome || key} ativada com sucesso!`
          : `${plat?.nome || key} desativada.`,
        "success",
      );
      await carregarPlataformas();
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message ||
        "Erro ao alterar estado da plataforma.";
      mostrarToast(msg, "error");
    } finally {
      setAlternandoAtivoKey(null);
    }
  };

  // Abrir configuração
  const handleAbrirConfig = async (key: string) => {
    if (key === "shopee") {
      setModalShopeeAberto(true);
      await carregarShopeeConfig();
    } else if (key === "mercado_livre") {
      setModalMlAberto(true);
      await carregarMlConfig();
    } else if (key === "tiktok_shop") {
      setModalTiktokAberto(true);
    } else {
      mostrarToast("Configuração não disponível.");
    }
  };

  // Carregar dados de configuração da Shopee
  const carregarShopeeConfig = async () => {
    try {
      const res = await api.get("/api/platforms/shopee/config");
      if (res.data) {
        setShopeeConfig(res.data);
        setInputAppId(res.data.appId || "");
        setInputApiKey("");
      }
    } catch (err) {
      console.error("Falha ao buscar config da Shopee:", err);
    }
  };

  // Carregar dados de configuração do Mercado Livre
  const carregarMlConfig = async () => {
    try {
      const res = await api.get("/api/affiliate/ml/config");
      if (res.data) {
        setMlConfig(res.data);
        if (res.data.tag) {
          setMlTag(res.data.tag);
        }
        setMlApifyToken("");
      }
    } catch (err) {
      console.error("Falha ao buscar config do Mercado Livre:", err);
    }
  };

  // Salvar credenciais do Mercado Livre
  const handleSalvarMlConfig = async () => {
    const temSessao = Boolean(mlCookie.trim() || mlCsrfToken.trim() || mlTag.trim());
    const temApify = Boolean(mlApifyToken.trim());

    if (!temSessao && !temApify) {
      mostrarToast("Preencha ao menos uma configuração para salvar.", "error");
      return;
    }

    if (temSessao && (!mlCookie.trim() || !mlCsrfToken.trim() || !mlTag.trim())) {
      mostrarToast("Preencha Cookie, Token CSRF e Tag de Afiliado.", "error");
      return;
    }

    setSalvandoMl(true);
    try {
      const payload: Record<string, string> = {};
      if (temSessao) {
        payload.cookie = mlCookie.trim();
        payload.csrfToken = mlCsrfToken.trim();
        payload.tag = mlTag.trim();
      }
      if (temApify) {
        payload.apifyToken = mlApifyToken.trim();
      }

      const res = await api.post("/api/affiliate/ml/config", payload);
      if (res.data?.sucesso) {
        mostrarToast(
          "Configurações do Mercado Livre salvas com sucesso!",
          "success",
        );
        setMlCookie("");
        setMlCsrfToken("");
        setMlApifyToken("");
        await carregarMlConfig();
        await carregarPlataformas();
        setModalMlAberto(false);
      }
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message ||
        "Erro ao salvar credenciais do Mercado Livre.";
      mostrarToast(msg, "error");
    } finally {
      setSalvandoMl(false);
    }
  };

  // Salvar credenciais da Shopee
  const handleSalvarShopeeConfig = async () => {
    setSalvandoConfig(true);
    try {
      const payload: { appId?: string; apiKey?: string } = {};
      if (inputAppId.trim() && !inputAppId.includes("*")) {
        payload.appId = inputAppId.trim();
      }
      if (inputApiKey.trim()) {
        payload.apiKey = inputApiKey.trim();
      }

      const res = await api.put("/api/platforms/shopee/config", payload);
      if (res.data) {
        setShopeeConfig(res.data);
        mostrarToast("Configurações da Shopee salvas com sucesso!", "success");
        await carregarPlataformas();
        setModalShopeeAberto(false);
      }
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message || "Erro ao salvar configurações.";
      mostrarToast(msg, "error");
    } finally {
      setSalvandoConfig(false);
    }
  };

  // Plataformas ordenadas como no Figma (Shopee primeiro, depois Mercado Livre, depois TikTok Shop)
  const plataformasOrdenadas = [...plataformas].sort(
    (a, b) =>
      (ORDEM_PLATAFORMAS[a.key] ?? 99) - (ORDEM_PLATAFORMAS[b.key] ?? 99),
  );

  // Cálculos dinâmicos de resumo
  const totalConectadas = plataformas.filter(
    (p) => p.status === "connected" || p.status === "configured",
  ).length;
  const totalNaoConfiguradas = plataformas.filter(
    (p) => p.status === "not_configured",
  ).length;

  // RENDER PRINCIPAL: LISTAGEM DE PLATAFORMAS (Figma: Plataformas · 390 · Padrão.png)
  return (
    <div className="w-full max-w-[390px] mx-auto h-screen overflow-y-auto px-4 pt-6 pb-32 flex flex-col bg-background text-foreground antialiased selection:bg-indigo-100">
      {/* 1. Cabeçalho Principal */}
      <header className="flex flex-col">
        <h1 className="text-[26px] font-bold text-zinc-900 tracking-tight leading-tight">
          Plataformas
        </h1>
        <p className="text-sm text-zinc-500 mt-1 font-normal">
          Gerencie cada conexão e seus próprios dados.
        </p>

        {/* Botão + Adicionar plataforma */}
        {/*  <button
          type="button"
          onClick={() => setModalAdicionarAberto(true)}
          className="mt-3.5 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer w-fit"
        >
          <Plus className="size-3.5 stroke-[2.5]" />
          Adicionar plataforma
        </button>
 */}
        {/* Contadores / Badges de Resumo */}
        <div className="mt-4 flex items-center gap-3 text-xs">
          <span className="px-2.5 py-1 rounded-md bg-indigo-50 text-indigo-600 font-semibold">
            {totalConectadas} conectada{totalConectadas !== 1 ? "s" : ""}
          </span>
          {totalNaoConfiguradas > 0 && (
            <span className="text-zinc-500 font-normal">
              {totalNaoConfiguradas} não configurada
              {totalNaoConfiguradas !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </header>

      {/* 2. Lista de Cards de Plataforma */}
      <div className="mt-4 flex flex-col gap-4">
        {carregando ? (
          <div className="py-12 flex flex-col items-center justify-center text-zinc-400 gap-2">
            <RotateCw className="size-6 animate-spin text-indigo-600" />
            <span className="text-xs">Carregando plataformas...</span>
          </div>
        ) : (
          plataformasOrdenadas.map((p) => {
            const isSincronizando = sincronizandoKey === p.key;
            const isAlternando = alternandoAtivoKey === p.key;
            const isConnected =
              p.status === "connected" || p.status === "configured";
            const isDisabled = p.status === "disabled" || !p.ativo;
            const isShopee = p.key === "shopee";

            return (
              <div
                key={p.key}
                className="bg-white rounded-2xl p-5 border border-zinc-200/80 shadow-xs flex flex-col gap-3.5"
              >
                {/* Linha 1: Ícone e Título da Plataforma */}
                <div className="flex items-center gap-3">
                  <div className="size-10 rounded-xl bg-zinc-50 border border-zinc-100 flex items-center justify-center text-zinc-600 shrink-0">
                    <Plug className="size-5" />
                  </div>
                  <span className="text-lg font-bold text-zinc-900 leading-snug">
                    {p.nome}
                  </span>
                </div>

                {/* Linha 2: Badge de Status (posicionado abaixo do título como no Figma) */}
                <div>
                  {isConnected && !isDisabled ? (
                    <span className="bg-indigo-50 text-indigo-600 text-xs font-semibold px-2.5 py-1 rounded-md inline-block">
                      Conectada
                    </span>
                  ) : isDisabled ? (
                    <span className="bg-zinc-100 text-zinc-600 text-xs font-medium px-2.5 py-1 rounded-md inline-block">
                      Desativada
                    </span>
                  ) : (
                    <span className="bg-zinc-100 text-zinc-500 text-xs font-medium px-2.5 py-1 rounded-md inline-block">
                      Não configurada
                    </span>
                  )}
                </div>

                {/* Linha 3: Subtítulo / Descrição da API */}
                <p className="text-xs text-zinc-500 font-normal -mt-1">
                  {p.available
                    ? isDisabled
                      ? "Integração desativada temporariamente."
                      : "API ativa · Configuração independente"
                    : "Conecte esta integração para iniciar a coleta."}
                </p>

                {/* Linha Divisória */}
                <div className="border-t border-zinc-100 my-0.5" />

                {/* Estatísticas da Plataforma */}
                <div className="flex flex-col gap-2.5 text-xs">
                  {/* Linha 1: Última Sincronização */}
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Última sincronização</span>
                    <span
                      className={`font-medium ${
                        p.ultimaSincronizacao
                          ? "text-zinc-900"
                          : "text-zinc-600"
                      }`}
                    >
                      {formatarDataRelativa(p.ultimaSincronizacao)}
                    </span>
                  </div>

                  {/* Linha 2: Promoções Coletadas */}
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Promoções coletadas</span>
                    <span
                      className={`font-medium ${
                        p.available ? "text-zinc-900" : "text-zinc-600"
                      }`}
                    >
                      {p.available
                        ? p.totalProdutos.toLocaleString("pt-BR")
                        : "Não disponível"}
                    </span>
                  </div>

                  {/* Linha 3: Comissão Recebida Hoje */}
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">
                      Comissão recebida hoje
                    </span>
                    {isShopee &&
                    p.comissaoHoje?.valor !== null &&
                    p.comissaoHoje?.valor !== undefined ? (
                      <span className="text-emerald-600 font-semibold">
                        {formatarMoeda(p.comissaoHoje.valor)}
                      </span>
                    ) : isShopee && isConnected ? (
                      <span className="text-emerald-600 font-semibold">
                        R$ 0,00
                      </span>
                    ) : (
                      <span className="text-zinc-600 font-medium">
                        Não disponível
                      </span>
                    )}
                  </div>
                </div>

                {/* Ações / Botões do Card */}
                <div className="flex flex-col gap-2 mt-1">
                  {p.available ? (
                    <>
                      {/* Botão Configurar */}
                      <button
                        type="button"
                        onClick={() => handleAbrirConfig(p.key)}
                        className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-zinc-200/90 bg-white text-zinc-800 text-xs font-semibold hover:bg-zinc-50 shadow-xs transition-colors cursor-pointer"
                      >
                        <Settings className="size-3.5 text-zinc-600" />
                        Configurar
                      </button>

                      {/* Botão Sincronizar agora (oculto no Mercado Livre para preservar cota Apify) */}
                      {p.key !== "mercado_livre" && (
                        <button
                          type="button"
                          disabled={isSincronizando}
                          onClick={() => handleSincronizar(p.key)}
                          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-zinc-200/90 bg-white text-zinc-800 text-xs font-semibold hover:bg-zinc-50 shadow-xs transition-colors cursor-pointer disabled:opacity-60"
                        >
                          <RotateCw
                            className={`size-3.5 text-zinc-600 ${
                              isSincronizando
                                ? "animate-spin text-indigo-600"
                                : ""
                            }`}
                          />
                          {isSincronizando
                            ? "Sincronizando..."
                            : "Sincronizar agora"}
                        </button>
                      )}

                      {/* Botão Desativar / Ativar */}
                      <button
                        type="button"
                        disabled={isAlternando}
                        onClick={() => handleToggleAtivo(p.key, p.ativo)}
                        className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-zinc-200/90 bg-white text-zinc-800 text-xs font-semibold hover:bg-zinc-50 shadow-xs transition-colors cursor-pointer disabled:opacity-60"
                      >
                        <Unplug className="size-3.5 text-zinc-600" />
                        {isAlternando
                          ? "Processando..."
                          : p.ativo
                            ? "Desativar"
                            : "Ativar"}
                      </button>
                    </>
                  ) : (
                    /* Plataforma Indisponível (ex: TikTok Shop) */
                    <button
                      type="button"
                      onClick={() => handleAbrirConfig(p.key)}
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                    >
                      <Settings className="size-3.5" />
                      Configurar
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 3. Banner Informativo: Integrações Independentes */}
      <section className="mt-4 bg-indigo-50/70 border border-indigo-100 rounded-2xl p-4 flex gap-3 text-indigo-900">
        <Info className="size-5 text-indigo-600 shrink-0 mt-0.5" />
        <div className="flex flex-col">
          <h3 className="text-xs font-bold text-indigo-950">
            Integrações independentes
          </h3>
          <p className="text-xs text-indigo-700 mt-1 leading-relaxed font-normal">
            Cada plataforma tem credenciais, regras de coleta e dados
            disponíveis próprios. Novas integrações podem ser adicionadas sem
            alterar as demais.
          </p>
        </div>
      </section>

      {/* 4. Rodapé Informativo */}
      <footer className="text-center text-xs text-zinc-400 mt-5 pb-6">
        Suportadas neste ambiente: Shopee, Mercado Livre e TikTok Shop.
      </footer>

      {/* MODAL: ADICIONAR PLATAFORMA */}
      {modalAdicionarAberto && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in"
          onClick={() => setModalAdicionarAberto(false)}
        >
          <div
            className="w-full max-w-[340px] bg-white rounded-2xl p-5 shadow-2xl flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-zinc-900">
                Adicionar plataforma
              </h3>
              <button
                type="button"
                onClick={() => setModalAdicionarAberto(false)}
                className="text-zinc-400 hover:text-zinc-700 cursor-pointer"
              >
                <X className="size-4" />
              </button>
            </div>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Todas as plataformas suportadas no ecossistema (Shopee, Mercado
              Livre e TikTok Shop) já estão integradas e disponíveis no painel.
            </p>
            <div className="bg-zinc-50 border border-zinc-100 rounded-xl p-3 flex flex-col gap-1.5 text-xs text-zinc-700">
              <span className="font-semibold text-zinc-900">
                Em desenvolvimento:
              </span>
              <span>• Amazon Afiliados</span>
              <span>• Magazine Luiza</span>
            </div>
            <button
              type="button"
              onClick={() => setModalAdicionarAberto(false)}
              className="mt-2 w-full py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 transition-colors cursor-pointer"
            >
              Entendido
            </button>
          </div>
        </div>
      )}

      {/* MODAL: CONFIGURAÇÃO SHOPEE */}
      {modalShopeeAberto && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in"
          onClick={() => setModalShopeeAberto(false)}
        >
          <div
            className="w-full max-w-[360px] bg-white rounded-2xl p-5 shadow-2xl flex flex-col gap-3.5 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-zinc-900">
                  Configuração da Shopee
                </h3>
                {shopeeConfig?.status === "connected" ||
                shopeeConfig?.status === "configured" ? (
                  <span className="bg-emerald-50 text-emerald-600 text-[10px] font-semibold px-2 py-0.5 rounded-md">
                    Conectada
                  </span>
                ) : (
                  <span className="bg-zinc-100 text-zinc-600 text-[10px] font-medium px-2 py-0.5 rounded-md">
                    Não configurada
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setModalShopeeAberto(false)}
                className="text-zinc-400 hover:text-zinc-700 cursor-pointer"
              >
                <X className="size-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-500 leading-relaxed">
              Credenciais da API de Afiliados Shopee utilizadas para consulta de
              ofertas e geração de links.
            </p>

            {/* Campo App ID */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-zinc-700">
                App ID
              </label>
              <input
                type="text"
                value={inputAppId}
                onChange={(e) => setInputAppId(e.target.value)}
                placeholder="Insira o App ID da Shopee"
                className="w-full text-xs px-3.5 py-2.5 rounded-xl border border-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-600 text-zinc-900 bg-white"
              />
            </div>

            {/* Campo Chave da API */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-zinc-700">
                Chave da API
              </label>
              <input
                type="password"
                value={inputApiKey}
                onChange={(e) => setInputApiKey(e.target.value)}
                placeholder={
                  shopeeConfig?.apiKeyConfigurada
                    ? "Deixe em branco para manter a atual"
                    : "Insira a chave da API"
                }
                className="w-full text-xs px-3.5 py-2.5 rounded-xl border border-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-600 text-zinc-900 bg-white"
              />
            </div>

            {shopeeConfig?.ultimaSincronizacao && (
              <p className="text-[11px] text-zinc-400">
                Última sincronização:{" "}
                {formatarDataRelativa(shopeeConfig.ultimaSincronizacao)}
              </p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setModalShopeeAberto(false)}
                className="flex-1 py-2.5 rounded-xl border border-zinc-200 text-zinc-700 text-xs font-semibold hover:bg-zinc-50 transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={salvandoConfig}
                onClick={handleSalvarShopeeConfig}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 transition-colors cursor-pointer disabled:opacity-60 flex items-center justify-center gap-1.5"
              >
                {salvandoConfig ? (
                  <>
                    <RotateCw className="size-3.5 animate-spin" />
                    <span>Salvando...</span>
                  </>
                ) : (
                  <span>Salvar</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: CONFIGURAÇÃO MERCADO LIVRE */}
      {modalMlAberto && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in"
          onClick={() => setModalMlAberto(false)}
        >
          <div
            className="w-full max-w-[360px] bg-white rounded-2xl p-5 shadow-2xl flex flex-col gap-3.5 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-zinc-900">
                  Configuração do Mercado Livre
                </h3>
                {mlConfig?.configurado ? (
                  <span className="bg-emerald-50 text-emerald-600 text-[10px] font-semibold px-2 py-0.5 rounded-md">
                    Configurado
                  </span>
                ) : (
                  <span className="bg-zinc-100 text-zinc-600 text-[10px] font-medium px-2 py-0.5 rounded-md">
                    Não configurado
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setModalMlAberto(false)}
                className="text-zinc-400 hover:text-zinc-700 cursor-pointer"
              >
                <X className="size-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-500 leading-relaxed">
              Insira os cookies da sessão, token CSRF e a tag de afiliado para
              ativar a geração de links do Mercado Livre.
            </p>

            {/* Campo Tag de Afiliado */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-zinc-700">
                Tag de Afiliado
              </label>
              <input
                type="text"
                value={mlTag}
                onChange={(e) => setMlTag(e.target.value)}
                placeholder="Ex: minhatag-20"
                className="w-full text-xs px-3.5 py-2.5 rounded-xl border border-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-600 text-zinc-900 bg-white"
              />
            </div>

            {/* Campo CSRF Token */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-zinc-700">
                Token CSRF
              </label>
              <input
                type="password"
                value={mlCsrfToken}
                onChange={(e) => setMlCsrfToken(e.target.value)}
                placeholder="Cole o token CSRF..."
                className="w-full text-xs px-3.5 py-2.5 rounded-xl border border-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-600 text-zinc-900 bg-white"
              />
            </div>

            {/* Campo Cookie */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-zinc-700">
                Cookie da Sessão
              </label>
              <textarea
                value={mlCookie}
                onChange={(e) => setMlCookie(e.target.value)}
                placeholder="Cole o cookie da sessão (ex: c_user=...; ssid=...)"
                rows={3}
                className="w-full text-xs px-3.5 py-2 rounded-xl border border-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-600 text-zinc-900 bg-white font-mono resize-none"
              />
            </div>

            {/* Campo Token da API Apify */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-zinc-700">
                  Token da API Apify (Scraper)
                </label>
                {mlConfig?.apifyTokenConfigurado ? (
                  <span className="bg-emerald-50 text-emerald-600 text-[10px] font-semibold px-1.5 py-0.5 rounded">
                    Configurado
                  </span>
                ) : (
                  <span className="bg-zinc-100 text-zinc-500 text-[10px] font-medium px-1.5 py-0.5 rounded">
                    Pendente
                  </span>
                )}
              </div>
              <input
                type="password"
                value={mlApifyToken}
                onChange={(e) => setMlApifyToken(e.target.value)}
                placeholder={
                  mlConfig?.apifyTokenConfigurado
                    ? "Deixe em branco para manter o token atual"
                    : "Insira o token Apify (apify_api_...)"
                }
                className="w-full text-xs px-3.5 py-2.5 rounded-xl border border-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-600 text-zinc-900 bg-white"
              />
              <span className="text-[10px] text-zinc-400">
                Necessário para o robô coletar ofertas automáticas do Mercado Livre.
              </span>
            </div>

            {mlConfig?.atualizadoEm && (
              <p className="text-[11px] text-zinc-400">
                Última atualização:{" "}
                {formatarDataRelativa(mlConfig.atualizadoEm)}
              </p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setModalMlAberto(false)}
                className="flex-1 py-2.5 rounded-xl border border-zinc-200 text-zinc-700 text-xs font-semibold hover:bg-zinc-50 transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={salvandoMl}
                onClick={handleSalvarMlConfig}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 transition-colors cursor-pointer disabled:opacity-60 flex items-center justify-center gap-1.5"
              >
                {salvandoMl ? (
                  <>
                    <RotateCw className="size-3.5 animate-spin" />
                    <span>Salvando...</span>
                  </>
                ) : (
                  <span>Salvar</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: CONFIGURAÇÃO TIKTOK SHOP */}
      {modalTiktokAberto && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in"
          onClick={() => setModalTiktokAberto(false)}
        >
          <div
            className="w-full max-w-[340px] bg-white rounded-2xl p-5 shadow-2xl flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-zinc-900">TikTok Shop</h3>
              <button
                type="button"
                onClick={() => setModalTiktokAberto(false)}
                className="text-zinc-400 hover:text-zinc-700 cursor-pointer"
              >
                <X className="size-4" />
              </button>
            </div>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Esta plataforma não está disponível nesta versão. A integração
              será habilitada assim que o programa de afiliados nacional for
              liberado.
            </p>
            <button
              type="button"
              onClick={() => setModalTiktokAberto(false)}
              className="mt-2 w-full py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 transition-colors cursor-pointer"
            >
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
