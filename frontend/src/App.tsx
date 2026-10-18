import type React from "react";
import Downbar from "./components/Downbar";
import Dashboard from "./components/screens/Dashboard";
import Promocoes from "./components/screens/Promocoes";
import Plataformas from "./components/screens/Plataformas";
import Envios from "./components/screens/Envios";
import Configuracoes from "./components/screens/Configuracoes";
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

  useEffect(() => {
    const handleDesautenticado = () => {
      setAutenticado(false);
    };

    eventoAuth.addEventListener("desautenticado", handleDesautenticado);

    api
      .get("/api/auth/me")
      .then(() => {
        setAutenticado(true);
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

  return (
    <main className=" overflow-hidden w-full bg-background h-full flex flex-col justify-center items-center">
      <Toaster />
      {carregando ? (
        <div className="text-muted-foreground text-sm">Carregando...</div>
      ) : !autenticado ? (
        <CardLogin onLoginSucesso={() => setAutenticado(true)} />
      ) : (
        <>
          {screens[index]}
          <Downbar ativo={index} onChange={setIndex} />
        </>
      )}
    </main>
  );
}

export default App;
