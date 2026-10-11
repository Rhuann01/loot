import type { JSX } from "react/jsx-runtime";

type CardProp = {
  label: string;
  icon: JSX.Element;
  ativo: boolean;
  onClick: () => void;
};

const CardIcon = ({ label, icon, ativo, onClick }: CardProp) => {
  return (
    <main
      onClick={onClick}
      className={`flex w-20 font-semibold pt-0.5 gap-1.5 flex-col items-center justify-start  ${ativo ? "text-primary" : "text-muted-foreground"} `}
    >
      {icon}
      <span className="text-[0.6rem]">{label}</span>
    </main>
  );
};

export default CardIcon;
