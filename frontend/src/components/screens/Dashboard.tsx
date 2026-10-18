import { useState, useEffect } from "react";
import {
  Zap,
  Send,
  Download,
  CircleDollarSign,
  AlertCircle,
  RotateCw,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";

interface AtividadeItem {
  id: number | string;
  icone: "send" | "download" | "comissao" | "alerta" | "sync";
  titulo: string;
  detalhe: string;
  detalheDestaque?: string;
  horario: string;
  corIcone?: string;
}

interface BarraHistorico {
  label: string;
  valor: number | null;
  heightPct: number;
  atual: boolean;
}

interface PlataformaItem {
  nome: string;
  conectada: boolean;
  statusTexto?: string;
  coletadas?: number;
  comissaoLiquida?: string;
}

function formatarMoeda(valor: number | null | undefined): string {
  if (valor === null || valor === undefined) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(valor);
}

function gerarBarrasIniciais(): BarraHistorico[] {
  const barras: BarraHistorico[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    barras.push({
      label: `${dd}/${mm}`,
      valor: null,
      heightPct: 8,
      atual: i === 0,
    });
  }
  return barras;
}

const PLATAFORMAS_INICIAIS: PlataformaItem[] = [
  {
    nome: "Shopee",
    conectada: true,
    coletadas: 0,
  },
  {
    nome: "Mercado Livre",
    conectada: true,
    coletadas: 0,
  },
  {
    nome: "TikTok Shop",
    conectada: false,
    statusTexto: "Não configurada",
  },
];

const Dashboard = () => {
  const hoje = new Date();
  const dataCabecalho = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "long",
  }).format(hoje);
  const dataTagHoje = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  }).format(hoje);

  const [automacaoAtiva, setAutomacaoAtiva] = useState(true);
  const [proximoEnvio, setProximoEnvio] = useState("hoje");
  const [coletadasHoje, setColetadasHoje] = useState(0);
  const [enviadasHoje, setEnviadasHoje] = useState(0);
  const [comissaoHoje, setComissaoHoje] = useState("R$ 0,00");
  const [comissao7DiasTotal, setComissao7DiasTotal] = useState("R$ 0,00");
  const [historico7Dias, setHistorico7Dias] = useState<BarraHistorico[]>(gerarBarrasIniciais());
  const [plataformas, setPlataformas] = useState<PlataformaItem[]>(PLATAFORMAS_INICIAIS);
  const [atividades, setAtividades] = useState<AtividadeItem[]>([]);

  useEffect(() => {
    let ativo = true;

    api
      .get("/api/dashboard")
      .then((res) => {
        if (!ativo || !res.data) return;
        const data = res.data;

        // 1. Automação
        if (data.automation) {
          if (typeof data.automation.ativo === "boolean") {
            setAutomacaoAtiva(data.automation.ativo);
          }
          if (data.automation.proximoEnvio) {
            try {
              const rawData = data.automation.proximoEnvio.includes(" ") && !data.automation.proximoEnvio.includes("T")
                ? data.automation.proximoEnvio.replace(" ", "T") + "Z"
                : data.automation.proximoEnvio;
              const d = new Date(rawData);
              if (!isNaN(d.getTime())) {
                const hh = String(d.getHours()).padStart(2, "0");
                const mm = String(d.getMinutes()).padStart(2, "0");
                setProximoEnvio(`hoje às ${hh}:${mm}`);
              }
            } catch {
              // fallback
            }
          }
        }

        // 2. Métricas de hoje
        if (data.today) {
          if (typeof data.today.coletadas === "number") {
            setColetadasHoje(data.today.coletadas);
          }
          if (typeof data.today.enviadas === "number") {
            setEnviadasHoje(data.today.enviadas);
          }
          if (
            data.today.comissaoEstimada?.valor !== undefined &&
            data.today.comissaoEstimada?.valor !== null
          ) {
            setComissaoHoje(formatarMoeda(data.today.comissaoEstimada.valor));
          } else {
            setComissaoHoje("R$ 0,00");
          }
        }

        // 3. Histórico dos últimos 7 dias
        if (Array.isArray(data.commissionHistory) && data.commissionHistory.length > 0) {
          const valores = data.commissionHistory.map(
            (h: { valor: number | null }) => h.valor ?? 0
          );
          const totalVal = valores.reduce((acc: number, curr: number) => acc + curr, 0);
          setComissao7DiasTotal(formatarMoeda(totalVal));

          const maxVal = Math.max(...valores, 50);

          const barras: BarraHistorico[] = data.commissionHistory.map(
            (
              item: { data?: string; date?: string; valor: number | null },
              idx: number,
              arr: unknown[]
            ) => {
              const dataStr = item.data || item.date || "";
              let label = "";
              if (dataStr && dataStr.length >= 10) {
                label = `${dataStr.slice(8, 10)}/${dataStr.slice(5, 7)}`;
              } else {
                const d = new Date();
                d.setDate(d.getDate() - (arr.length - 1 - idx));
                const dd = String(d.getDate()).padStart(2, "0");
                const mm = String(d.getMonth() + 1).padStart(2, "0");
                label = `${dd}/${mm}`;
              }
              const valor = item.valor ?? 0;
              const heightPct =
                valor > 0
                  ? Math.max(16, Math.min(100, Math.round((valor / maxVal) * 90)))
                  : 8;
              const ehUltimo = idx === arr.length - 1;

              return {
                label,
                valor: item.valor,
                heightPct,
                atual: ehUltimo,
              };
            }
          );
          setHistorico7Dias(barras);
        }

        // 4. Desempenho por plataforma
        if (Array.isArray(data.platformPerformance) && data.platformPerformance.length > 0) {
          const listaPlat: PlataformaItem[] = data.platformPerformance.map(
            (p: {
              nome: string;
              available: boolean;
              coletadas?: number;
              comissaoEstimada?: { valor: number | null };
            }) => ({
              nome: p.nome,
              conectada: p.available,
              statusTexto: p.available ? "Conectada" : "Não configurada",
              coletadas: p.coletadas ?? 0,
              comissaoLiquida:
                p.comissaoEstimada?.valor !== undefined && p.comissaoEstimada?.valor !== null
                  ? formatarMoeda(p.comissaoEstimada.valor)
                  : undefined,
            })
          );
          setPlataformas(listaPlat);
        }

        // 5. Últimas atividades reais
        if (Array.isArray(data.recentActivities)) {
          const ativFiltradas = data.recentActivities.filter(
            (a: { tipo?: string }) =>
              a.tipo !== "whatsapp_status" && a.tipo !== "teste_auditoria"
          );

          const listaAtiv: AtividadeItem[] = ativFiltradas.slice(0, 5).map(
            (a: {
              id: number;
              tipo: string;
              titulo: string;
              detalhe: string;
              criadoEm: string;
            }) => {
              let icone: AtividadeItem["icone"] = "sync";
              let corIcone = "text-zinc-600";
              if (a.tipo === "envio" || a.tipo === "sent" || a.tipo === "envio_sucesso") {
                icone = "send";
              } else if (a.tipo === "coleta") {
                icone = "download";
              } else if (a.tipo === "comissao" || a.tipo === "comissao_snapshot") {
                icone = "comissao";
                corIcone = "text-emerald-600";
              } else if (a.tipo === "falha" || a.tipo === "failed") {
                icone = "alerta";
                corIcone = "text-rose-500";
              }

              let horario = "--:--";
              try {
                const rawData = a.criadoEm.includes(" ") && !a.criadoEm.includes("T")
                  ? a.criadoEm.replace(" ", "T") + "Z"
                  : a.criadoEm;
                const dt = new Date(rawData);
                if (!isNaN(dt.getTime())) {
                  horario = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
                }
              } catch {
                // fallback
              }

              return {
                id: a.id,
                icone,
                titulo: a.titulo,
                detalhe: a.detalhe,
                horario,
                corIcone,
              };
            }
          );
          setAtividades(listaAtiv);
        }
      })
      .catch((err) => {
        console.error("Falha ao carregar dashboard:", err);
      });

    return () => {
      ativo = false;
    };
  }, []);

  const alternarAutomacao = async (checked: boolean) => {
    setAutomacaoAtiva(checked);
    try {
      await api.put("/api/settings", { scheduler: { ativo: checked } });
    } catch {
      setAutomacaoAtiva(!checked);
    }
  };

  const renderIconeAtividade = (icone: AtividadeItem["icone"], corIcone?: string) => {
    const cor = corIcone || "text-zinc-600";
    switch (icone) {
      case "send":
        return <Send className={`size-5 ${cor} shrink-0 -rotate-12`} />;
      case "download":
        return <Download className={`size-5 ${cor} shrink-0`} />;
      case "comissao":
        return <CircleDollarSign className={`size-5 ${cor} shrink-0`} />;
      case "alerta":
        return <AlertCircle className={`size-5 ${cor} shrink-0`} />;
      case "sync":
      default:
        return <RotateCw className={`size-5 ${cor} shrink-0`} />;
    }
  };

  return (
    <div className="w-full max-w-[390px] mx-auto h-screen overflow-y-auto px-4 pt-6 pb-32 flex flex-col bg-background text-foreground antialiased selection:bg-indigo-100">
      {/* 1. Cabeçalho */}
      <header className="flex flex-col">
        <h1 className="text-[26px] font-bold text-zinc-900 tracking-tight leading-tight">
          Dashboard
        </h1>
        <p className="text-sm text-zinc-500 mt-1 font-normal">
          Bom dia! Veja o resumo de hoje, {dataCabecalho}.
        </p>
      </header>

      {/* 2. Banner de Automação */}
      <section className="mt-5 bg-[#EEF2FF] border border-indigo-100/60 rounded-2xl p-4 flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-3">
          <Zap className="size-5 text-[#4F46E5] shrink-0" fill="currentColor" fillOpacity={0.15} />
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold text-[#1E1B4B] leading-tight">
              Automação {automacaoAtiva ? "ativa" : "pausada"}
            </h2>
            <p className="text-xs text-[#4F46E5]/80 mt-0.5 font-normal">
              Próximo envio {proximoEnvio}
            </p>
          </div>
        </div>
        <Switch
          checked={automacaoAtiva}
          onCheckedChange={alternarAutomacao}
          aria-label="Alternar status da automação"
        />
      </section>

      {/* 3. Cards de Métricas Rápidas (Grid 2x2) */}
      <section className="mt-4 grid grid-cols-2 gap-3">
        {/* Card 1: Promoções coletadas hoje */}
        <div className="bg-white rounded-2xl px-3.5 py-4 border border-zinc-200/70 shadow-xs flex flex-col justify-between min-h-[96px]">
          <span className="text-[11.5px] text-zinc-500 font-normal tracking-tight whitespace-nowrap">
            Promoções coletadas hoje
          </span>
          <span className="text-[32px] font-bold text-zinc-900 mt-2 leading-none tracking-tight">
            {coletadasHoje}
          </span>
        </div>

        {/* Card 2: Promoções enviadas */}
        <div className="bg-white rounded-2xl px-3.5 py-4 border border-zinc-200/70 shadow-xs flex flex-col justify-between min-h-[96px]">
          <span className="text-[11.5px] text-zinc-500 font-normal tracking-tight whitespace-nowrap">
            Promoções enviadas
          </span>
          <span className="text-[32px] font-bold text-zinc-900 mt-2 leading-none tracking-tight">
            {enviadasHoje}
          </span>
        </div>

        {/* Card 3: Comissões estimada */}
        <div className="bg-white rounded-2xl px-3.5 py-4 border border-zinc-200/70 shadow-xs flex flex-col justify-between min-h-[96px]">
          <span className="text-[11.5px] text-zinc-500 font-normal tracking-tight whitespace-nowrap">
            Comissões estimada
          </span>
          <span className="text-[22px] font-bold text-emerald-600 mt-2 leading-none tracking-tight">
            {comissaoHoje}
          </span>
        </div>

        {/* Slot 4: Contexto Hoje · DD/MM */}
        <div className="px-3.5 py-4 flex flex-col justify-center min-h-[96px]">
          <span className="text-xs text-zinc-600 font-medium">
            Hoje · {dataTagHoje}
          </span>
          <span className="text-xs text-zinc-500 mt-1 leading-relaxed">
            Dados das integrações disponíveis.
          </span>
        </div>
      </section>

      {/* 4. Gráfico: Comissões nos últimos 7 dias */}
      <section className="mt-4 bg-white rounded-2xl p-4 sm:p-5 border border-zinc-200/70 shadow-xs flex flex-col">
        <h2 className="text-base font-bold text-zinc-900 tracking-tight">
          Comissões nos últimos 7 dias
        </h2>

        <div className="flex items-center justify-between mt-2">
          <span className="text-2xl font-bold text-zinc-900 tracking-tight">
            {comissao7DiasTotal}
          </span>
          <span className="bg-zinc-100 text-zinc-600 text-xs font-medium px-2 py-0.5 rounded">
            Shopee
          </span>
        </div>

        {/* Colunas do Gráfico */}
        <div className="mt-6 flex items-end justify-between h-[120px] px-1 gap-2">
          {historico7Dias.map((barra, idx) => (
            <div key={idx} className="flex flex-col items-center flex-1 h-full justify-end">
              <div
                className={`w-full max-w-[32px] rounded-t-sm transition-all duration-300 ${
                  barra.atual ? "bg-[#4338CA]" : "bg-[#C7D2FE]"
                }`}
                style={{ height: `${barra.heightPct}%` }}
              />
              <span className="text-[11px] text-zinc-500 mt-2 font-normal text-center whitespace-nowrap">
                {barra.label}
              </span>
            </div>
          ))}
        </div>

        {/* Nota de rodapé do gráfico */}
        <p className="text-xs text-zinc-500 mt-4 font-normal">
          Comissão líquida • Apenas dados disponíveis
        </p>
      </section>

      {/* 5. Desempenho por plataforma */}
      <section className="mt-7 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-zinc-900 tracking-tight">
            Desempenho por plataforma
          </h2>
          <span className="text-xs text-zinc-500 font-medium">Hoje</span>
        </div>

        <div className="flex flex-col gap-3">
          {plataformas.map((plat, idx) => (
            <div
              key={idx}
              className="bg-white rounded-2xl p-4 border border-zinc-200/70 shadow-xs flex flex-col"
            >
              <div>
                <h3 className="text-base font-bold text-zinc-900 tracking-tight">
                  {plat.nome}
                </h3>
                {plat.conectada ? (
                  <span className="inline-block bg-[#EEF2FF] text-[#4338CA] text-xs font-medium px-2 py-0.5 rounded mt-2">
                    Conectada
                  </span>
                ) : (
                  <span className="inline-block bg-zinc-100 text-zinc-500 text-xs font-medium px-2 py-0.5 rounded mt-2">
                    {plat.statusTexto || "Não configurada"}
                  </span>
                )}
              </div>

              {/* Métricas da plataforma conectada */}
              {plat.conectada && (
                <div className="space-y-2 mt-4 pt-1">
                  {plat.coletadas !== undefined && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-zinc-500 font-normal">Promoções coletadas</span>
                      <span className="font-semibold text-zinc-900">{plat.coletadas}</span>
                    </div>
                  )}
                  {plat.comissaoLiquida && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-zinc-500 font-normal">Comissão líquida estimada</span>
                      <span className="font-bold text-emerald-600">{plat.comissaoLiquida}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 6. Últimas atividades */}
      <section className="mt-7 bg-white rounded-2xl p-4 border border-zinc-200/70 shadow-xs flex flex-col">
        <h2 className="text-base font-bold text-zinc-900 tracking-tight mb-1">
          Últimas atividades
        </h2>

        {atividades.length === 0 ? (
          <div className="py-6 text-center text-xs text-zinc-400">
            Nenhuma atividade recente registrada
          </div>
        ) : (
          <div className="divide-y divide-zinc-100">
            {atividades.map((item) => (
              <div key={item.id} className="py-3.5 flex items-center gap-3">
                {renderIconeAtividade(item.icone, item.corIcone)}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-900 leading-snug">
                    {item.titulo}
                  </p>
                  <p className="text-[11.5px] text-zinc-500 leading-snug mt-0.5">
                    {item.detalhe}
                    {item.detalheDestaque && (
                      <span className="text-rose-500 font-medium cursor-pointer hover:underline">
                        {item.detalheDestaque}
                      </span>
                    )}
                  </p>
                </div>
                <span className="text-xs text-zinc-500 ml-2 shrink-0">
                  {item.horario}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default Dashboard;
