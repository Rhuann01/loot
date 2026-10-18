import type React from "react";
import Downbar from "./components/Downbar";
import Dashboard from "./components/screens/Dashboard";
import Promocoes from "./components/screens/Promocoes";
import Plataformas from "./components/screens/Plataformas";
import Envios from "./components/screens/Envios";
import Configuracoes from "./components/screens/Configuracoes";
import OnboardingWhatsApp from "./components/OnboardingWhatsApp";
import { useState, useEffect } from "react";
import CardLogin from "./components/CardLogin";
import { api, eventoAuth } from "./services/api";
import { Toaster } from "./components/ui/sonner";

const screens: Record<number, React.ReactNode> = {
  1: <Dashboard />,
  2: <Promocoes />,
  3: <Plataformas />,
  4: <Envios />,
  5: <Configuracoes />,
};

function App() {
  const [index, setIndex] = useState(1);
  const [autenticado, setAutenticado] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [mostrarOnboarding, setMostrarOnboarding] = useState(false);
  const [iniciarNoPassoGrupo, setIniciarNoPassoGrupo] = useState(false);

  const verificarNecessidadeOnboarding = async () => {
    if (sessionStorage.getItem("onboarding_ignorado") === "true") {
      return;
    }

    try {
      const res = await api.get("/api/settings");
      const { whatsapp } = res.data || {};
      const conectado = whatsapp?.status === "connected";
      const temGrupo = Boolean(whatsapp?.destino?.id);

      if (!conectado) {
        setIniciarNoPassoGrupo(false);
        setMostrarOnboarding(true);
      } else if (!temGrupo) {
        setIniciarNoPassoGrupo(true);
        setMostrarOnboarding(true);
      }
    } catch (err) {
      console.warn("Não foi possível verificar status de onboarding:", err);
    }
  };

  useEffect(() => {
    const handleDesautenticado = () => {
      setAutenticado(false);
      setMostrarOnboarding(false);
    };

    eventoAuth.addEventListener("desautenticado", handleDesautenticado);

    api
      .get("/api/auth/me")
      .then(() => {
        setAutenticado(true);
        verificarNecessidadeOnboarding();
      })
      .catch(() => {
        setAutenticado(false);
      })
      .finally(() => {
        setCarregando(false);
      });

    return () => {
      eventoAuth.removeEventListener("desautenticado", handleDesautenticado);
    };
  }, []);

  const handleLoginSucesso = () => {
    setAutenticado(true);
    verificarNecessidadeOnboarding();
  };

  const handlePularOnboarding = () => {
    sessionStorage.setItem("onboarding_ignorado", "true");
    setMostrarOnboarding(false);
  };

  const handleConcluirOnboarding = () => {
    sessionStorage.removeItem("onboarding_ignorado");
    setMostrarOnboarding(false);
  };

  return (
    <main className=" overflow-hidden w-full bg-background h-full flex flex-col justify-center items-center">
      <Toaster />
      {carregando ? (
        <div className="text-muted-foreground text-sm">Carregando...</div>
      ) : !autenticado ? (
        <CardLogin onLoginSucesso={handleLoginSucesso} />
      ) : (
        <>
          {screens[index]}
          <Downbar ativo={index} onChange={setIndex} />
          {mostrarOnboarding && (
            <OnboardingWhatsApp
              onConcluido={handleConcluirOnboarding}
              onPular={handlePularOnboarding}
              iniciarNoPassoGrupo={iniciarNoPassoGrupo}
            />
          )}
        </>
      )}
    </main>
  );
}

export default App;

