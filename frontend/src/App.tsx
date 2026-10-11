import type React from "react";
import Downbar from "./components/Downbar";
import Dashboard from "./components/screens/Dashboard";
import Promocoes from "./components/screens/Promocoes ";
import Plataformas from "./components/screens/Plataformas ";
import Envios from "./components/screens/Envios";
import Configuracoes from "./components/screens/Configuracoes";
import { useState } from "react";
import CardLogin from "./components/CardLogin";

const screens: Record<number, React.ReactNode> = {
  1: <Dashboard />,
  2: <Promocoes />,
  3: <Plataformas />,
  4: <Envios />,
  5: <Configuracoes />,
};

function App() {
  const [index, setIndex] = useState(1);
  const [login] = useState(true);

  return (
    <main className=" overflow-hidden w-full bg-background h-full flex flex-col justify-center items-center">
      {login && <CardLogin />}
      {screens[index]}
      <Downbar ativo={index} onChange={setIndex} />
    </main>
  );
}

export default App;
