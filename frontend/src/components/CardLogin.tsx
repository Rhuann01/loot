import type React from "react";
import { useState } from "react";
import axios from "axios";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "./ui/label";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { api } from "@/services/api";

interface CardLoginProps {
  onLoginSucesso: () => void;
}

const CardLogin = ({ onLoginSucesso }: CardLoginProps) => {
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);
    setCarregando(true);

    try {
      await api.post("/api/auth/login", { usuario, senha });
      onLoginSucesso();
    } catch (err) {
      let mensagem = "Erro ao realizar login";
      if (axios.isAxiosError(err)) {
        mensagem =
          err.response?.data?.error?.message || err.message || mensagem;
      }
      setErro(mensagem);
    } finally {
      setCarregando(false);
    }
  };

  return (
    <div className=" bg-black/30 backdrop-blur-xs h-screen w-screen px-5 absolute inset-0 flex items-center justify-center">
      <Card className="w-full max-w-sm border-border border-2 ">
        <form onSubmit={handleSubmit} className="contents">
          <CardHeader>
            <CardTitle>Credenciais de acesso</CardTitle>
            <CardDescription>Adcione o nome e senha a baixo</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-6">
              {erro && (
                <div className="text-sm font-medium text-destructive">
                  {erro}
                </div>
              )}
              <div className="grid gap-2">
                <Label htmlFor="user">Usuário</Label>
                <Input
                  id="user"
                  type="text"
                  required
                  value={usuario}
                  onChange={(e) => setUsuario(e.target.value)}
                  disabled={carregando}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="senha">Senha</Label>
                <Input
                  id="senha"
                  type="password"
                  required
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  disabled={carregando}
                />
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button
              type="submit"
              className="w-full p-6"
              disabled={carregando}
            >
              {carregando ? "Carregando..." : "Login"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
};

export default CardLogin;