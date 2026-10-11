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

const CardLogin = () => {
  return (
    <div className=" bg-black/30 backdrop-blur-xs h-screen w-screen px-5 absolute inset-0 flex items-center justify-center">
      <Card className="w-full max-w-sm border-border border-2 ">
        <CardHeader>
          <CardTitle>Credenciais de acesso</CardTitle>
          <CardDescription>Adcione o nome e senha a baixo</CardDescription>
        </CardHeader>
        <CardContent>
          <form>
            <div className="flex flex-col gap-6">
              <div className="grid gap-2">
                <Label htmlFor="user">Usuário</Label>
                <Input id="user" type="text" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="senha">Senha</Label>
                <Input id="senha" type="password" required />
              </div>
            </div>
          </form>
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full p-6">
            Login
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
};

export default CardLogin;