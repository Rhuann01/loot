import { conectarWhatsApp, getSock } from "../src/whatsapp/connection.js";
import { enviarProduto } from "../src/whatsapp/sender.js";

await conectarWhatsApp();

setTimeout(async () => {
  await enviarProduto({
    nome: "Vibrato Perfum",
    preco_atual: "7,30",
    preco_original: "10",
    link_afiliado: "https://www.mercadolivre.com.br/exemplo",
    imagem_url:
      "https://i.pinimg.com/736x/57/10/74/571074e8a912d4e1c285900656b5e931.jpg",
    parcelas: "12x de R$7,71",
    frete_gratis: true,
  });
  console.log("mensagem enviada!");
}, 3000);

/* setTimeout(async () => {
  const sock = getSock()
  if (!sock) return

  const grupos = await sock.groupFetchAllParticipating()

  Object.values(grupos).forEach((grupo) => {
    console.log(`Nome: ${grupo.subject} | ID: ${grupo.id}`)
  })
}, 3000) */
