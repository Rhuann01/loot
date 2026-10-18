import { useState, useEffect, useMemo } from "react";
import {
  Users,
  CheckCircle2,
  RotateCw,
  Search,
  ArrowRight,
  Smartphone,
} from "lucide-react";
import { api } from "../services/api";
import { toast } from "./ui/sonner";

interface Grupo {
  id: string;
  nome: string;
  participantes?: number;
}

interface OnboardingWhatsAppProps {
  onConcluido: () => void;
  onPular: () => void;
  iniciarNoPassoGrupo?: boolean;
}

export default function OnboardingWhatsApp({
  onConcluido,
  onPular,
  iniciarNoPassoGrupo = false,
}: OnboardingWhatsAppProps) {
  const [passo, setPasso] = useState<1 | 2>(iniciarNoPassoGrupo ? 2 : 1);

  useEffect(() => {
    if (iniciarNoPassoGrupo) {
      setPasso(2);
    }
  }, [iniciarNoPassoGrupo]);

  // Estado Passo 1: QR Code e Conexão
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [conectado, setConectado] = useState(false);
  const [gerandoQr, setGerandoQr] = useState(false);
  const [erroQr, setErroQr] = useState<string | null>(null);

  // Estado Passo 2: Grupos
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [carregandoGrupos, setCarregandoGrupos] = useState(false);
  const [grupoSelecionadoId, setGrupoSelecionadoId] = useState<string>("");
  const [buscaGrupo, setBuscaGrupo] = useState("");
  const [salvandoGrupo, setSalvandoGrupo] = useState(false);

  // ==========================================
  // PASSO 1: MONITORAMENTO E BUSCA DO QR CODE
  // ==========================================
  const buscarQrEStatus = async () => {
    try {
      const resStatus = await api.get<{
        conectado: boolean;
        estado: string;
      }>("/api/whatsapp/status");

      if (resStatus.data?.conectado) {
        setConectado(true);
        setPasso(2);
        return;
      }

      const resQr = await api.get<{ qr: string | null }>("/api/whatsapp/qr");
      if (resQr.data?.qr) {
        setQrCode(resQr.data.qr);
        setErroQr(null);
      }
    } catch (err: any) {
      console.warn("Erro ao verificar status do WhatsApp:", err);
    }
  };

  const handleForcarNovoQr = async () => {
    setGerandoQr(true);
    setErroQr(null);
    try {
      await api.post("/api/whatsapp/reconnect", { forcarNovoQr: true });
      await buscarQrEStatus();
      toast.success("Novo QR Code solicitado!");
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message || "Não foi possível gerar novo QR Code.";
      setErroQr(msg);
      toast.error(msg);
    } finally {
      setGerandoQr(false);
    }
  };

  useEffect(() => {
    if (passo === 1) {
      buscarQrEStatus();
      const intervalo = setInterval(buscarQrEStatus, 2000);
      return () => clearInterval(intervalo);
    }
  }, [passo]);

  // ==========================================
  // PASSO 2: CARREGAMENTO E SELEÇÃO DE GRUPOS
  // ==========================================
  const carregarGrupos = async () => {
    setCarregandoGrupos(true);
    try {
      const res = await api.get<{
        grupos: Grupo[];
        grupoSelecionadoId: string | null;
      }>("/api/whatsapp/groups");

      const lista = res.data?.grupos || [];
      setGrupos(lista);

      if (res.data?.grupoSelecionadoId) {
        setGrupoSelecionadoId(res.data.grupoSelecionadoId);
      } else if (lista.length > 0 && !grupoSelecionadoId) {
        setGrupoSelecionadoId(lista[0].id);
      }
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message || "Erro ao carregar grupos do WhatsApp.";
      toast.error(msg);
    } finally {
      setCarregandoGrupos(false);
    }
  };

  useEffect(() => {
    if (passo === 2) {
      carregarGrupos();
    }
  }, [passo]);

  const gruposFiltrados = useMemo(() => {
    if (!buscaGrupo.trim()) return grupos;
    const termo = buscaGrupo.toLowerCase();
    return grupos.filter((g) => g.nome.toLowerCase().includes(termo));
  }, [grupos, buscaGrupo]);

  const handleSalvarGrupo = async () => {
    if (!grupoSelecionadoId) {
      toast.warning("Selecione um grupo para continuar.");
      return;
    }

    setSalvandoGrupo(true);
    try {
      const res = await api.put("/api/whatsapp/group", {
        groupId: grupoSelecionadoId,
      });

      if (res.data?.sucesso) {
        toast.success("Grupo de promoções configurado com sucesso!");
        onConcluido();
      }
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message || "Erro ao salvar grupo de destino.";
      toast.error(msg);
    } finally {
      setSalvandoGrupo(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-[420px] bg-white rounded-3xl p-6 shadow-2xl border border-zinc-200/90 flex flex-col gap-5 animate-in fade-in zoom-in-95 duration-200">
        {/* Cabeçalho do Onboarding */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full uppercase tracking-wider">
              {passo === 1 ? "Etapa 1 de 2" : "Etapa 2 de 2"}
            </span>
            <button
              type="button"
              onClick={onPular}
              className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors cursor-pointer"
            >
              Configurar mais tarde
            </button>
          </div>

          <h2 className="text-xl font-bold text-zinc-900 tracking-tight mt-1">
            {passo === 1 ? "Conecte seu WhatsApp" : "Selecione o Grupo de Ofertas"}
          </h2>
          <p className="text-xs text-zinc-500 leading-relaxed">
            {passo === 1
              ? "Escaneie o código abaixo com o celular para que o Loot possa disparar promoções."
              : "Escolha em qual grupo do WhatsApp as ofertas selecionadas serão publicadas."}
          </p>
        </div>

        {/* ======================================================== */}
        {/* ETAPA 1: QR CODE */}
        {/* ======================================================== */}
        {passo === 1 && (
          <div className="flex flex-col items-center gap-4">
            <div className="relative w-60 h-60 bg-zinc-50 rounded-2xl border-2 border-dashed border-zinc-200 flex items-center justify-center p-3 shadow-inner">
              {conectado ? (
                <div className="flex flex-col items-center gap-2 text-emerald-600 animate-in zoom-in-90">
                  <CheckCircle2 className="size-14" />
                  <span className="text-sm font-semibold">WhatsApp Conectado!</span>
                </div>
              ) : qrCode ? (
                <img
                  src={qrCode}
                  alt="QR Code WhatsApp"
                  className="w-full h-full object-contain rounded-xl"
                />
              ) : (
                <div className="flex flex-col items-center gap-3 text-zinc-400 px-4 text-center">
                  <RotateCw className="size-8 animate-spin text-indigo-600" />
                  <span className="text-xs">Gerando QR Code do WhatsApp...</span>
                </div>
              )}
            </div>

            {erroQr && (
              <p className="text-xs text-rose-500 text-center font-medium">
                {erroQr}
              </p>
            )}

            {/* Instruções de escaneamento */}
            <div className="w-full bg-zinc-50 rounded-xl p-3 border border-zinc-200/80 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-zinc-800 text-xs font-semibold">
                <Smartphone className="size-4 text-indigo-600" />
                <span>Como escanear:</span>
              </div>
              <ol className="text-[11px] text-zinc-500 flex flex-col gap-1 list-decimal list-inside pl-1 leading-normal">
                <li>Abra o WhatsApp no seu smartphone</li>
                <li>Toque em <b>Dispositivos Conectados</b></li>
                <li>Toque em <b>Conectar Dispositivo</b> e aponte para o QR</li>
              </ol>
            </div>

            <button
              type="button"
              disabled={gerandoQr}
              onClick={handleForcarNovoQr}
              className="w-full py-2.5 rounded-xl border border-zinc-200 hover:bg-zinc-50 text-zinc-700 text-xs font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <RotateCw className={`size-3.5 ${gerandoQr ? "animate-spin" : ""}`} />
              <span>{gerandoQr ? "Gerando..." : "Atualizar QR Code"}</span>
            </button>
          </div>
        )}

        {/* ======================================================== */}
        {/* ETAPA 2: ESCOLHA DO GRUPO */}
        {/* ======================================================== */}
        {passo === 2 && (
          <div className="flex flex-col gap-3.5">
            {/* Campo de pesquisa de grupos */}
            <div className="relative flex items-center">
              <Search className="size-4 text-zinc-400 absolute left-3 pointer-events-none" />
              <input
                type="text"
                placeholder="Buscar grupo por nome..."
                value={buscaGrupo}
                onChange={(e) => setBuscaGrupo(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-zinc-200 bg-zinc-50/50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-600 transition-colors"
              />
            </div>

            {/* Lista de grupos */}
            <div className="max-h-60 overflow-y-auto flex flex-col gap-2 pr-1 rounded-xl">
              {carregandoGrupos ? (
                <div className="py-8 flex flex-col items-center justify-center gap-2 text-zinc-400">
                  <RotateCw className="size-5 animate-spin text-indigo-600" />
                  <span className="text-xs">Carregando grupos do WhatsApp...</span>
                </div>
              ) : gruposFiltrados.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-400">
                  Nenhum grupo encontrado com este nome.
                </div>
              ) : (
                gruposFiltrados.map((g) => {
                  const selecionado = grupoSelecionadoId === g.id;
                  return (
                    <div
                      key={g.id}
                      onClick={() => setGrupoSelecionadoId(g.id)}
                      className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                        selecionado
                          ? "border-indigo-600 bg-indigo-50/60 shadow-xs"
                          : "border-zinc-200 bg-white hover:border-zinc-300"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${
                            selecionado
                              ? "bg-indigo-600 text-white"
                              : "bg-zinc-100 text-zinc-500"
                          }`}
                        >
                          <Users className="size-4" />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span
                            className={`text-xs font-semibold truncate ${
                              selecionado ? "text-indigo-950" : "text-zinc-900"
                            }`}
                          >
                            {g.nome}
                          </span>
                          {g.participantes !== undefined && (
                            <span className="text-[10px] text-zinc-400 font-normal">
                              {g.participantes} participante
                              {g.participantes === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>
                      </div>

                      <div
                        className={`size-4 rounded-full border flex items-center justify-center shrink-0 ${
                          selecionado
                            ? "border-indigo-600 bg-indigo-600"
                            : "border-zinc-300 bg-white"
                        }`}
                      >
                        {selecionado && (
                          <div className="size-1.5 rounded-full bg-white" />
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Botão de confirmação */}
            <button
              type="button"
              disabled={salvandoGrupo || !grupoSelecionadoId || carregandoGrupos}
              onClick={handleSalvarGrupo}
              className="w-full mt-2 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {salvandoGrupo ? (
                <>
                  <RotateCw className="size-4 animate-spin" />
                  <span>Salvando grupo...</span>
                </>
              ) : (
                <>
                  <span>Concluir e Ir para o Painel</span>
                  <ArrowRight className="size-4" />
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
