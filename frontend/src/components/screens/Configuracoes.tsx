import { useState, useEffect } from "react";
import {
  Clock,
  ChevronDown,
  Wifi,
  RotateCw,
  X,
  LogOut,
  QrCode,
  Users,
  AlertTriangle,
} from "lucide-react";
import { api } from "../../services/api";
import { Switch } from "../ui/switch";
import { toast } from "../ui/sonner";
import OnboardingWhatsApp from "../OnboardingWhatsApp";

interface SettingsData {
  scheduler: {
    ativo: boolean;
    horarios: string[];
    limiteDiario: number;
    quantidadePorExecucao: number;
    intervaloEntreMensagensMs: number;
    proximoEnvio: string | null;
    janelaShopeeHoras: number;
  };
  whatsapp: {
    status: "connected" | "disconnected";
    numero: string | null;
    destino: { id: string; nome: string } | null;
    grupos: Array<{ id: string; nome: string }>;
  };
  storage: {
    tipo: string;
    totalPromocoes: number;
  };
}

export default function Configuracoes() {
  const [salvando, setSalvando] = useState(false);
  const [testandoWhatsapp, setTestandoWhatsapp] = useState(false);
  const [desconectandoWhatsapp, setDesconectandoWhatsapp] = useState(false);
  const [modalConfirmarDesconexao, setModalConfirmarDesconexao] = useState(false);
  const [modalOnboardingAberto, setModalOnboardingAberto] = useState(false);
  const [iniciarNoPassoGrupo, setIniciarNoPassoGrupo] = useState(false);
  const [carregando, setCarregando] = useState(true);

  // Form states
  const [autoEnvioAtivo, setAutoEnvioAtivo] = useState(true);
  const [frequencia, setFrequencia] = useState("Diária");
  const [horariosSelecionados, setHorariosSelecionados] = useState<string[]>([]);
  const [seletorHorariosAberto, setSeletorHorariosAberto] = useState(false);
  const [novoHorarioInput, setNovoHorarioInput] = useState("");
  const [limiteDiarioInput, setLimiteDiarioInput] = useState("");

  // Horários predefinidos comuns
  const HORARIOS_PREDEFINIDOS = ["05:00", "08:00", "10:00", "12:00", "14:00", "15:00", "16:00", "18:00", "20:00", "22:00"];

  // Formatar horários para exibição (ex: "12:00 e 18:00")
  const formatarHorariosTexto = (horarios: string[]): string => {
    if (horarios.length === 0) return "Nenhum horário selecionado";
    if (horarios.length === 1) return horarios[0];
    if (horarios.length === 2) return `${horarios[0]} e ${horarios[1]}`;
    const ult = horarios[horarios.length - 1];
    const anteriores = horarios.slice(0, -1).join(", ");
    return `${anteriores} e ${ult}`;
  };

  // Alternar horário selecionado
  const toggleHorario = (hora: string) => {
    if (horariosSelecionados.includes(hora)) {
      if (horariosSelecionados.length === 1) {
        toast.warning("É necessário manter pelo menos 1 horário configurado.");
        return;
      }
      setHorariosSelecionados((prev) => prev.filter((h) => h !== hora).sort());
    } else {
      if (horariosSelecionados.length >= 4) {
        toast.warning("Limite máximo de 4 horários diários atingido.");
        return;
      }
      setHorariosSelecionados((prev) => [...prev, hora].sort());
    }
  };

  // Adicionar horário personalizado
  const handleAdicionarHorarioCustom = () => {
    if (!novoHorarioInput) return;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(novoHorarioInput)) {
      toast.error("Formato inválido. Use o seletor de hora.");
      return;
    }
    if (horariosSelecionados.includes(novoHorarioInput)) {
      toast.info("Este horário já está adicionado.");
      return;
    }
    if (horariosSelecionados.length >= 4) {
      toast.warning("Limite máximo de 4 horários diários atingido.");
      return;
    }
    setHorariosSelecionados((prev) => [...prev, novoHorarioInput].sort());
    setNovoHorarioInput("");
  };

  // Validação estrita do Limite Diário (Máximo 12)
  const handleLimiteChange = (valor: string) => {
    if (valor.trim() === "") {
      setLimiteDiarioInput("");
      return;
    }
    const numeros = valor.replace(/\D/g, "");
    if (!numeros) {
      setLimiteDiarioInput("");
      return;
    }
    const num = parseInt(numeros, 10);
    if (num > 12) {
      toast.warning("O limite máximo permitido é de 12 promoções diárias.");
      setLimiteDiarioInput("12 promoções");
      return;
    }
    setLimiteDiarioInput(`${num} promoções`);
  };

  // Dados do backend
  const [whatsappInfo, setWhatsappInfo] = useState<{
    status: "connected" | "disconnected";
    numero: string | null;
    destino: string | null;
  }>({
    status: "disconnected",
    numero: null,
    destino: null,
  });

  const [bancoTipo, setBancoTipo] = useState("SQLite");

  // Carrega configurações
  const carregarConfiguracoes = async () => {
    try {
      const res = await api.get<SettingsData>("/api/settings");
      if (res.data) {
        const { scheduler, whatsapp, storage } = res.data;

        const estaConectado = whatsapp?.status === "connected";
        const temGrupo = Boolean(whatsapp?.destino?.id);
        setAutoEnvioAtivo(estaConectado && temGrupo ? scheduler.ativo : false);

        if (scheduler.horarios && scheduler.horarios.length > 0) {
          setHorariosSelecionados([...scheduler.horarios].sort());
        } else {
          setHorariosSelecionados([]);
        }

        if (scheduler.limiteDiario) {
          const l = Math.min(scheduler.limiteDiario, 12);
          setLimiteDiarioInput(`${l} promoções`);
        } else {
          setLimiteDiarioInput("");
        }

        if (whatsapp) {
          let numeroFormatado: string | null = null;
          if (whatsapp.numero) {
            const limpo = whatsapp.numero.replace(/\D/g, "");
            const final4 = limpo.slice(-4);
            const ddd = limpo.length >= 4 ? limpo.slice(2, 4) : "11";
            numeroFormatado = `+55 (${ddd}) •••••-${final4}`;
          }

          const nomeDestino = whatsapp.destino?.nome?.trim();
          setWhatsappInfo({
            status: whatsapp.status,
            numero: numeroFormatado,
            destino: nomeDestino || (whatsapp.destino?.id ? "Grupo configurado" : null),
          });
        }

        if (storage?.tipo) {
          setBancoTipo(storage.tipo === "sqlite" ? "SQLite" : storage.tipo);
        }
      }
    } catch (err) {
      console.error("Falha ao carregar configurações:", err);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    carregarConfiguracoes();
  }, []);

  const handleToggleAutoEnvio = (checked: boolean) => {
    if (checked) {
      if (whatsappInfo.status !== "connected") {
        toast.error("Conecte o WhatsApp antes de ativar o envio automático.");
        setIniciarNoPassoGrupo(false);
        setModalOnboardingAberto(true);
        return;
      }
      if (!whatsappInfo.destino) {
        toast.error("Configure um grupo de ofertas antes de ativar o envio automático.");
        setIniciarNoPassoGrupo(true);
        setModalOnboardingAberto(true);
        return;
      }
    }
    setAutoEnvioAtivo(checked);
  };

  // Salvar alterações
  const handleSalvar = async () => {
    setSalvando(true);
    try {
      if (autoEnvioAtivo && whatsappInfo.status !== "connected") {
        toast.error("Não é possível ativar o envio automático com o WhatsApp desconectado.");
        setSalvando(false);
        return;
      }

      if (autoEnvioAtivo && !whatsappInfo.destino) {
        toast.error("Não é possível ativar o envio automático sem um grupo de ofertas configurado.");
        setSalvando(false);
        return;
      }

      // Extrair limite numérico e validar estritamente <= 12
      const matchNum = limiteDiarioInput.match(/\d+/);
      const limiteDiario = matchNum ? parseInt(matchNum[0], 10) : 12;

      if (limiteDiario > 12) {
        toast.error("O limite máximo permitido é de 12 promoções diárias.");
        setLimiteDiarioInput("12 promoções");
        setSalvando(false);
        return;
      }

      if (horariosSelecionados.length === 0) {
        toast.error("Selecione pelo menos um horário de envio.");
        setSalvando(false);
        return;
      }

      const payload = {
        scheduler: {
          ativo: autoEnvioAtivo,
          horarios: horariosSelecionados,
          limiteDiario: Math.min(Math.max(limiteDiario, 1), 12),
        },
      };

      await api.put("/api/settings", payload);
      toast.success("Configurações salvas com sucesso!");
      setSeletorHorariosAberto(false);
      await carregarConfiguracoes();
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || "Erro ao salvar alterações.";
      toast.error(msg);
    } finally {
      setSalvando(false);
    }
  };

  // Testar conexão WhatsApp
  const handleTestarConexao = async () => {
    setTestandoWhatsapp(true);
    try {
      const res = await api.post("/api/whatsapp/test");
      if (res.data?.sucesso) {
        toast.success("Conexão com o WhatsApp ativa e funcionando!");
      } else if (res.data?.diagnostico) {
        toast.info(res.data.diagnostico);
      } else {
        toast.success("Teste de conexão executado.");
      }
      await carregarConfiguracoes();
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || "WhatsApp desconectado ou indisponível.";
      toast.error(msg);
    } finally {
      setTestandoWhatsapp(false);
    }
  };

  const handleDesconectar = async () => {
    setDesconectandoWhatsapp(true);
    try {
      const res = await api.post("/api/whatsapp/disconnect");
      if (res.data?.sucesso) {
        toast.success("WhatsApp desconectado. O envio automático foi pausado.");
        setAutoEnvioAtivo(false);
        setModalConfirmarDesconexao(false);
        await carregarConfiguracoes();
      }
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message || "Erro ao desconectar WhatsApp.";
      toast.error(msg);
    } finally {
      setDesconectandoWhatsapp(false);
    }
  };

  const handleAbrirConexao = () => {
    setIniciarNoPassoGrupo(false);
    setModalOnboardingAberto(true);
  };

  const handleAbrirMudarGrupo = () => {
    setIniciarNoPassoGrupo(true);
    setModalOnboardingAberto(true);
  };

  const handleFecharOnboarding = async () => {
    setModalOnboardingAberto(false);
    await carregarConfiguracoes();
  };

  return (
    <div className="w-full max-w-[390px] mx-auto h-screen overflow-y-auto px-4 pt-6 pb-32 flex flex-col bg-background text-foreground antialiased selection:bg-indigo-100">
      {/* 1. Cabeçalho Principal */}
      <header className="flex flex-col">
        <h1 className="text-[26px] font-bold text-zinc-900 tracking-tight leading-tight">
          Configurações gerais
        </h1>
        <p className="text-sm text-zinc-500 mt-1 font-normal">
          Preferências de automação, conexão e coleta.
        </p>
      </header>

      {/* 2. Card Automação */}
      <section className="mt-5 bg-white rounded-2xl p-5 border border-zinc-200/80 shadow-xs flex flex-col gap-4">
        <h2 className="text-lg font-bold text-zinc-900">Automação</h2>

        {/* Linha Envio Automático */}
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-zinc-900 leading-snug">
              Envio automático
            </span>
            <span className="text-xs text-zinc-500 font-normal">
              {whatsappInfo.status !== "connected"
                ? "Desativado (WhatsApp desconectado)"
                : !whatsappInfo.destino
                ? "Desativado (Grupo não configurado)"
                : autoEnvioAtivo
                ? "Ativado"
                : "Desativado"}
            </span>
          </div>
          <Switch
            checked={autoEnvioAtivo && whatsappInfo.status === "connected" && Boolean(whatsappInfo.destino)}
            onCheckedChange={handleToggleAutoEnvio}
          />
        </div>

        {whatsappInfo.status !== "connected" && (
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-amber-50 border border-amber-200/80 text-[11px] text-amber-800">
            <span>WhatsApp desconectado. O envio automático requer uma conexão ativa.</span>
            <button
              type="button"
              onClick={() => {
                setIniciarNoPassoGrupo(false);
                setModalOnboardingAberto(true);
              }}
              className="font-semibold underline text-amber-900 hover:text-amber-950 ml-2 shrink-0 cursor-pointer"
            >
              Conectar
            </button>
          </div>
        )}

        {whatsappInfo.status === "connected" && !whatsappInfo.destino && (
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-amber-50 border border-amber-200/80 text-[11px] text-amber-800">
            <span>Nenhum grupo de ofertas selecionado para o envio.</span>
            <button
              type="button"
              onClick={() => {
                setIniciarNoPassoGrupo(true);
                setModalOnboardingAberto(true);
              }}
              className="font-semibold underline text-amber-900 hover:text-amber-950 ml-2 shrink-0 cursor-pointer"
            >
              Escolher grupo
            </button>
          </div>
        )}

        <div className="border-t border-zinc-100" />

        {/* Campo Frequência */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-zinc-700">Frequência</label>
          <div className="relative flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900">
            <span>{frequencia}</span>
            <ChevronDown className="size-4 text-zinc-400 shrink-0 pointer-events-none" />
            <select
              aria-label="Frequência de envio"
              value={frequencia}
              onChange={(e) => setFrequencia(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            >
              <option value="Diária">Diária</option>
              <option value="Semanal">Semanal</option>
            </select>
          </div>
        </div>

        {/* Campo Horários */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-zinc-700">Horários</label>
            <button
              type="button"
              onClick={() => setSeletorHorariosAberto((v) => !v)}
              className="text-[11px] text-indigo-600 hover:underline font-medium cursor-pointer"
            >
              {seletorHorariosAberto ? "Fechar" : "Selecionar"}
            </button>
          </div>

          <div
            onClick={() => setSeletorHorariosAberto((v) => !v)}
            className="flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 cursor-pointer hover:border-zinc-300 transition-colors"
          >
            <span className="font-medium text-zinc-900">
              {carregando ? "Carregando..." : formatarHorariosTexto(horariosSelecionados)}
            </span>
            <Clock className="size-4 text-zinc-400 shrink-0" />
          </div>

          {/* Painel Seletor de Horários */}
          {seletorHorariosAberto && (
            <div className="p-3.5 bg-zinc-50 rounded-xl border border-zinc-200 flex flex-col gap-3.5 animate-in fade-in slide-in-from-top-1 mt-1">
              {/* Horários selecionados */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-zinc-700">
                    Horários configurados ({horariosSelecionados.length}/4):
                  </span>
                  <span className="text-[10px] text-zinc-400">
                    Toque no × para remover
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {horariosSelecionados.map((hora) => (
                    <button
                      key={`ativo-${hora}`}
                      type="button"
                      onClick={() => toggleHorario(hora)}
                      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg font-medium bg-indigo-600 text-white shadow-xs hover:bg-indigo-700 transition-all cursor-pointer"
                      title={`Remover ${hora}`}
                    >
                      <span>{hora}</span>
                      <X className="size-3 text-white/80 hover:text-white" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Sugestões rápidas */}
              <div className="pt-2.5 border-t border-zinc-200/80 flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold text-zinc-700">
                  Sugestões rápidas:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {HORARIOS_PREDEFINIDOS.map((hora) => {
                    const ativo = horariosSelecionados.includes(hora);
                    return (
                      <button
                        key={hora}
                        type="button"
                        onClick={() => toggleHorario(hora)}
                        className={`text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                          ativo
                            ? "bg-indigo-100 text-indigo-700 border border-indigo-300 font-semibold"
                            : "bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-100"
                        }`}
                      >
                        {hora} {ativo ? "✓" : "+"}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Adicionar horário personalizado */}
              <div className="pt-2.5 border-t border-zinc-200/80 flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold text-zinc-700">
                  Outro horário:
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={novoHorarioInput}
                    onChange={(e) => setNovoHorarioInput(e.target.value)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-indigo-600"
                  />
                  <button
                    type="button"
                    disabled={!novoHorarioInput}
                    onClick={handleAdicionarHorarioCustom}
                    className="px-3 py-1.5 rounded-lg bg-zinc-900 text-white text-xs font-medium hover:bg-zinc-800 disabled:opacity-40 cursor-pointer"
                  >
                    Adicionar
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Campo Limite Diário */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-zinc-700">Limite diário</label>
          <div className="flex items-center px-3.5 py-2.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus-within:ring-2 focus-within:ring-indigo-600 focus-within:border-transparent">
            <input
              type="text"
              aria-label="Limite diário de promoções"
              value={limiteDiarioInput}
              onChange={(e) => handleLimiteChange(e.target.value)}
              placeholder={carregando ? "Carregando..." : "12 promoções"}
              className="w-full bg-transparent focus:outline-none text-zinc-900 placeholder:text-zinc-400"
            />
          </div>
          <p className="text-[11px] text-zinc-400 leading-normal mt-0.5">
            Até 10 promoções por envio, com intervalo de 30 segundos entre mensagens.
          </p>
        </div>

        {/* Botão Salvar */}
        <button
          type="button"
          disabled={salvando}
          onClick={handleSalvar}
          className="w-full mt-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-60 flex items-center justify-center gap-1.5"
        >
          {salvando ? (
            <>
              <RotateCw className="size-3.5 animate-spin" />
              <span>Salvando...</span>
            </>
          ) : (
            <span>Salvar alterações</span>
          )}
        </button>
      </section>

      {/* Texto informativo de Automação */}
      <p className="text-[11px] text-zinc-400 text-center mt-2 px-2 leading-relaxed">
        As preferências de automação são compartilhadas com Dashboard e Envios.
      </p>

      {/* 3. Card WhatsApp */}
      <section className="mt-5 bg-white rounded-2xl p-5 border border-zinc-200/80 shadow-xs flex flex-col gap-3.5">
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-bold text-zinc-900">WhatsApp</h2>
          {carregando ? (
            <span className="bg-zinc-100 text-zinc-400 text-xs font-medium px-2.5 py-1 rounded-md w-fit">
              Verificando...
            </span>
          ) : whatsappInfo.status === "connected" ? (
            <span className="bg-emerald-50 text-emerald-600 text-xs font-semibold px-2.5 py-1 rounded-md w-fit">
              Conectado
            </span>
          ) : (
            <span className="bg-zinc-100 text-zinc-600 text-xs font-medium px-2.5 py-1 rounded-md w-fit">
              Desconectado
            </span>
          )}
        </div>

        {/* Linha Número */}
        <div className="flex items-center justify-between text-xs pt-1 border-t border-zinc-100">
          <span className="text-zinc-500">Número</span>
          <span className="font-semibold text-zinc-900">
            {carregando ? "Carregando..." : (whatsappInfo.numero || "Não informado")}
          </span>
        </div>

        {/* Linha Conexão */}
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-500">Conexão</span>
          <span className="font-semibold text-zinc-900 font-mono">
            {carregando ? "Verificando..." : (whatsappInfo.status === "connected" ? "Ativa" : "Desconectada")}
          </span>
        </div>

        {/* Linha Destino padrão */}
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-500">Destino padrão</span>
          <span className="font-semibold text-zinc-900">
            {carregando ? "Carregando..." : (whatsappInfo.destino || "Não configurado")}
          </span>
        </div>

        <div className="border-t border-zinc-100 pt-1 flex flex-col gap-2">
          {carregando ? (
            <div className="py-2.5 text-center text-xs text-zinc-400">
              Carregando opções...
            </div>
          ) : whatsappInfo.status === "connected" ? (
            <>
              {/* Botão Mudar grupo */}
              <button
                type="button"
                onClick={handleAbrirMudarGrupo}
                className="w-full py-2.5 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-800 text-xs font-semibold shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <Users className="size-4 text-zinc-600" />
                <span>Mudar grupo de destino</span>
              </button>

              {/* Botão Testar conexão */}
              <button
                type="button"
                disabled={testandoWhatsapp}
                onClick={handleTestarConexao}
                className="w-full py-2.5 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-800 text-xs font-semibold shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                {testandoWhatsapp ? (
                  <>
                    <RotateCw className="size-4 animate-spin text-zinc-600" />
                    <span>Testando conexão...</span>
                  </>
                ) : (
                  <>
                    <Wifi className="size-4 text-zinc-600" />
                    <span>Testar conexão</span>
                  </>
                )}
              </button>

              {/* Botão Desconectar WhatsApp */}
              <button
                type="button"
                disabled={desconectandoWhatsapp}
                onClick={() => setModalConfirmarDesconexao(true)}
                className="w-full py-2.5 rounded-xl border border-rose-200 bg-rose-50/60 hover:bg-rose-100 text-rose-700 text-xs font-semibold shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <LogOut className="size-4 text-rose-600" />
                <span>Desconectar WhatsApp</span>
              </button>
            </>
          ) : (
            <>
              {/* Aviso Desconectado */}
              <div className="p-3 bg-amber-50 border border-amber-200/80 rounded-xl text-amber-800 text-xs flex items-start gap-2.5">
                <AlertTriangle className="size-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="flex flex-col gap-0.5">
                  <span className="font-semibold text-amber-900">WhatsApp Desconectado</span>
                  <span className="text-[11px] text-amber-700 leading-tight">
                    O envio automático foi pausado. Conecte um aparelho para voltar a enviar ofertas.
                  </span>
                </div>
              </div>

              {/* Botão Conectar WhatsApp */}
              <button
                type="button"
                onClick={handleAbrirConexao}
                className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <QrCode className="size-4" />
                <span>Conectar WhatsApp (QR Code)</span>
              </button>
            </>
          )}
        </div>

        <p className="text-[11px] text-zinc-400 leading-normal">
          A conexão é utilizada em envios automáticos e manuais.
        </p>
      </section>

      {/* 4. Card Banco de dados */}
      <section className="mt-5 mb-8 bg-white rounded-2xl p-5 border border-zinc-200/80 shadow-xs flex flex-col gap-3">
        <h2 className="text-lg font-bold text-zinc-900">Banco de dados</h2>

        <div className="flex items-center justify-between text-xs pt-1 border-t border-zinc-100">
          <span className="text-zinc-500">Banco</span>
          <span className="font-semibold text-zinc-900">
            {bancoTipo}
          </span>
        </div>

        <div className="border-t border-zinc-100 pt-2">
          <span className="bg-emerald-50 text-emerald-600 text-xs font-semibold px-2.5 py-1 rounded-md w-fit">
            Conectado
          </span>
        </div>
      </section>

      {/* Modal de confirmação de desconexão */}
      {modalConfirmarDesconexao && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-200"
          onClick={() => setModalConfirmarDesconexao(false)}
        >
          <div
            className="w-full max-w-[360px] bg-white rounded-2xl p-5 shadow-2xl flex flex-col gap-3.5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-rose-600">
              <AlertTriangle className="size-5 shrink-0" />
              <h3 className="text-sm font-bold text-zinc-900">
                Desconectar WhatsApp?
              </h3>
            </div>
            <p className="text-xs text-zinc-600 leading-relaxed">
              Ao desconectar, o envio automático será <strong>pausado imediatamente</strong> e nenhuma promoção será enviada até que você conecte um novo número.
            </p>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                disabled={desconectandoWhatsapp}
                onClick={() => setModalConfirmarDesconexao(false)}
                className="flex-1 py-2.5 rounded-xl border border-zinc-200 text-zinc-700 text-xs font-semibold hover:bg-zinc-50 transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={desconectandoWhatsapp}
                onClick={handleDesconectar}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-60 flex items-center justify-center gap-1.5"
              >
                {desconectandoWhatsapp ? (
                  <>
                    <RotateCw className="size-3.5 animate-spin" />
                    <span>Desconectando...</span>
                  </>
                ) : (
                  <span>Sim, desconectar</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Onboarding / Conexão / Troca de Grupo */}
      {modalOnboardingAberto && (
        <OnboardingWhatsApp
          onConcluido={handleFecharOnboarding}
          onPular={handleFecharOnboarding}
          iniciarNoPassoGrupo={iniciarNoPassoGrupo}
        />
      )}
    </div>
  );
}
