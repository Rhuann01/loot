import { useEffect, useState } from "react";

type SchedulerConfig = {
  ativo: boolean;
  horarios: string[];
  quantidade_por_execucao: number;
};

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001/api";

function App() {
  const [config, setConfig] = useState<SchedulerConfig>({
    ativo: true,
    horarios: [],
    quantidade_por_execucao: 3,
  });
  const [novoHorario, setNovoHorario] = useState("08:00");
  const [mensagem, setMensagem] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/scheduler`)
      .then((res) => {
        if (!res.ok) throw new Error("Não foi possível carregar a configuração");
        return res.json() as Promise<SchedulerConfig>;
      })
      .then(setConfig)
      .catch((erro: Error) => setMensagem(erro.message))
      .finally(() => setCarregando(false));
  }, []);

  function adicionarHorario() {
    if (config.horarios.includes(novoHorario)) return;
    setConfig((atual) => ({
      ...atual,
      horarios: [...atual.horarios, novoHorario].sort(),
    }));
  }

  function removerHorario(horario: string) {
    setConfig((atual) => ({
      ...atual,
      horarios: atual.horarios.filter((item) => item !== horario),
    }));
  }

  async function salvar() {
    setMensagem("");
    const res = await fetch(`${API_URL}/scheduler`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });

    const data = await res.json();
    if (!res.ok) {
      setMensagem(data.erro ?? "Não foi possível salvar");
      return;
    }

    setConfig(data);
    setMensagem("Configuração salva com sucesso.");
  }

  if (carregando) return <main className="pagina">Carregando...</main>;

  return (
    <main className="pagina">
      <section className="card">
        <p className="eyebrow">LOOT</p>
        <h1>Agendamento de envios</h1>
        <p className="descricao">
          Escolha os horários em que o sistema deve enviar as ofertas para o WhatsApp.
        </p>

        <label className="switch-row">
          <input
            type="checkbox"
            checked={config.ativo}
            onChange={(event) =>
              setConfig((atual) => ({ ...atual, ativo: event.target.checked }))
            }
          />
          <span>Envio automático ativo</span>
        </label>

        <div className="campo">
          <label htmlFor="quantidade">Ofertas por execução</label>
          <input
            id="quantidade"
            type="number"
            min="1"
            max="100"
            value={config.quantidade_por_execucao}
            onChange={(event) =>
              setConfig((atual) => ({
                ...atual,
                quantidade_por_execucao: Number(event.target.value),
              }))
            }
          />
        </div>

        <div className="campo">
          <label htmlFor="horario">Adicionar horário</label>
          <div className="horario-form">
            <input
              id="horario"
              type="time"
              value={novoHorario}
              onChange={(event) => setNovoHorario(event.target.value)}
            />
            <button type="button" onClick={adicionarHorario}>Adicionar</button>
          </div>
        </div>

        <div className="horarios">
          {config.horarios.map((horario) => (
            <div className="horario" key={horario}>
              <span>{horario}</span>
              <button type="button" onClick={() => removerHorario(horario)} aria-label={`Remover ${horario}`}>
                ×
              </button>
            </div>
          ))}
        </div>

        <button className="salvar" type="button" onClick={salvar}>
          Salvar configuração
        </button>

        {mensagem && <p className="mensagem">{mensagem}</p>}
      </section>
    </main>
  );
}

export default App;
