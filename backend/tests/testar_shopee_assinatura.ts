import assert from "node:assert/strict";
import { calcularAssinatura } from "../src/integrations/shopee/client.js";

const appId = "123456";
const secret = "demo";
const timestamp = 1577836800;
const body =
  '{"query":"{\\nbrandOffer{\\n    nodes{\\n        commissionRate\\n        offerName\\n    }\\n}\\n}"}';
const assinaturaEsperada =
  "dc88d72feea70c80c52c3399751a7d34966763f51a7f056aa070a5e9df645412";

const assinatura = calcularAssinatura(appId, timestamp, body, secret);

assert.equal(assinatura, assinaturaEsperada);

console.log("Resultado: assinatura Shopee passou");
