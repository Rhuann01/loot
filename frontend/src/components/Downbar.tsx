import type { JSX } from "react/jsx-runtime";
import CardIcon from "./ui/CardIcon";
import { LayoutDashboard, Tag, Plug, Send, Settings } from "lucide-react";

type DropBarProps = {
  ativo: number;
  onChange: (index: number) => void;
};
type ItemNav = {
  index: number;
  label: string;
  icon: JSX.Element;
};
const itens: ItemNav[] = [
  { index: 1, label: "Dashboard", icon: <LayoutDashboard size={20} /> },
  { index: 2, label: "Promoções", icon: <Tag size={20} /> },
  { index: 3, label: "Plataformas", icon: <Plug size={20} /> },
  { index: 4, label: "Envios", icon: <Send size={20} /> },
  { index: 5, label: "Configurações", icon: <Settings size={20} /> },
];

const Downbar = ({ ativo, onChange }: DropBarProps) => {
  return (
    <nav className=" bg-white gap-2 flex inset-shadow-sidebar-primary-foreground justify-center w-full h-23 fixed bottom-0 border-t px-2 pt-2.5 pb-4  ">
      {itens.map((it) => (
        <CardIcon
          onClick={() => onChange(it.index)}
          key={it.index}
          label={it.label}
          icon={it.icon}
          ativo={it.index === ativo}
        />
      ))}
    </nav>
  );
};

export default Downbar;
