# Documentação da API — Loot

Este documento descreve os endpoints, contratos de dados, regras de negócio e padrões de resposta da API do Loot.

> **Importante**: Todas as datas, filtros diários e agrupamentos utilizam o fuso horário oficial **`America/Sao_Paulo`** (UTC-3). Nenhuma credencial real, cookie, token ou segredo deve constar nesta documentação ou ser trafegado sem mascaramento.

---

## 1. Autenticação

A API é protegida por autenticação HTTP **Basic Auth**.
- **Headers exigidos**: `Authorization: Basic <credenciais_base64>`
- Em ambientes fora de desenvolvimento local, o uso de credenciais padrão (`admin`/`admin`) é expressamente recusado na inicialização por motivos de segurança.

---

## 2. Padrões de Resposta e Erros

### Formato de Erro Padronizado

Em caso de falha de validação ou erro de negócio, a resposta HTTP retorna código de status apropriado (4xx / 5xx) e o seguinte formato JSON:

```json
{
  "error": {
    "code": "PARAMETRO_INVALIDO",
    "message": "Descrição amigável em português"
  }
}
```

Códigos comuns:
- `PARAMETRO_INVALIDO` (HTTP 400)
- `NAO_AUTORIZADO` (HTTP 401)
- `NAO_ENCONTRADO` (HTTP 404)
- `PLATAFORMA_INDISPONIVEL` (HTTP 422)
- `WHATSAPP_OFFLINE` (HTTP 503)
- `SINCRONIZACAO_FALHOU` (HTTP 502)
- `ERRO_INTERNO` (HTTP 500)

### Paginação

Listagens paginadas utilizam os seguintes parâmetros de query:
- `page`: Número da página (inteiro >= 1, padrão: 1).
- `limit`: Quantidade por página (inteiro entre 1 e 100, padrão: 20).

Envelope retornado:

```json
{
  "items": [],
  "total": 100,
  "page": 1,
  "limit": 20,
  "totalPages": 5
}
```

---

## 3. Status de Promoções e Envios

O ciclo de vida de uma promoção na fila utiliza os seguintes status:
- **`pending`**: Produto coletado, aguardando envio pelo agendador ou seleção.
- **`sent`**: Produto enviado com sucesso para o grupo de WhatsApp.
- **`failed`**: Falha definitiva no envio após o limite de tentativas.
- **`needs_review` / `ambiguous`**: Envio ambíguo (timeout ou confirmação incerta); requer conferência manual (“Verificar”) pelo operador.

### Regras de Comissão e Preços
- **Comissão Shopee**: É sempre tratada como **estimativa** no momento da consulta/coleta (`estimada: true`). Ausência de comissão retorna explicitamente `valor: null` e `disponivel: false`. Nunca é fabricado valor `0`.
- **Preço Original Shopee**: Quando ausente na API, retorna `precoOriginal: null` e não gera linha `De:` na mensagem.
- **TikTok Shop**: Permanece indisponível nesta versão (`available: false`, mensagem: "Não disponível nesta versão").
- **Mercado Livre**: Não gera comissão estimada fabricada. O fluxo de envio manual por link direto é restrito à Shopee; Mercado Livre não é aceito no novo endpoint de envio manual.

---

## 4. Endpoints

### 4.1 Saúde e Diagnóstico

#### `GET /api/health`
Retorna status de funcionamento da API.
- **Resposta (200)**:
  ```json
  { "status": "ok" }
  ```

---

### 4.2 Dashboard

#### `GET /api/dashboard?period=7d`
Retorna métricas agregadas dos últimos 7 dias em `America/Sao_Paulo`.
- **Parâmetros**: `period` (somente `"7d"` suportado atualmente).
- **Resposta (200)**:
  ```json
  {
    "period": "7d",
    "automation": {
      "ativo": true,
      "proximoEnvio": "2026-10-15T12:00:00-03:00",
      "horarios": ["05:00", "12:00", "15:00", "20:00"],
      "limiteDiario": 12,
      "enviadosHoje": 3,
      "disponiveisNaFila": 18
    },
    "today": {
      "coletadas": 25,
      "enviadas": 3,
      "comissaoEstimada": {
        "valor": 12.34,
        "disponivel": true,
        "estimada": true
      }
    },
    "commissionHistory": [
      {
        "data": "2026-10-08",
        "valor": null,
        "disponivel": false,
        "estimada": true
      }
    ],
    "platformPerformance": [
      {
        "plataforma": "shopee",
        "nome": "Shopee",
        "available": true,
        "coletadas": 20,
        "enviadas": 3,
        "falhas": 1,
        "ambiguous": 0,
        "comissaoEstimada": {
          "valor": 12.34,
          "disponivel": true,
          "estimada": true
        }
      },
      {
        "plataforma": "mercado_livre",
        "nome": "Mercado Livre",
        "available": true,
        "coletadas": 5,
        "enviadas": 0,
        "falhas": 0,
        "ambiguous": 0,
        "comissaoEstimada": {
          "valor": null,
          "disponivel": false,
          "estimada": true
        }
      },
      {
        "plataforma": "tiktok_shop",
        "nome": "TikTok Shop",
        "available": false,
        "coletadas": 0,
        "enviadas": 0,
        "falhas": 0,
        "ambiguous": 0,
        "comissaoEstimada": {
          "valor": null,
          "disponivel": false,
          "estimada": true
        },
        "motivo": "Não disponível nesta versão"
      }
    ],
    "recentActivities": []
  }
  ```

---

### 4.3 Produtos e Promoções

#### `GET /api/produtos`
Lista produtos paginados por status.
- **Query params**: `status` (`"all"`, `"pending"`, `"sent"`, `"needs_review"`, `"failed"`), `q` (busca textual), `page`, `limit`.

#### `GET /api/produtos/:id`
Retorna detalhes completos do produto, link afiliado, status e última comissão registrada.

#### `GET /api/produtos/:id/attempts`
Lista histórico de tentativas de envio do produto com snapshots de mensagem.

#### `POST /api/produtos/:id/selecionar`
Alterna a seleção prioritária do produto para envio.
- **Corpo**: `{ "selecionado": true }`

#### `POST /api/produtos/:id/reenviar`
Rota idempotente para reenvio manual de produto existente.
- **Header**: `Idempotency-Key: <uuid>`

---

### 4.4 Configurações Agregadas

#### `GET /api/settings`
Retorna visão agregada e segura das configurações do sistema (sem segredos nem referências a backup/restauração).
- **Resposta (200)**:
  ```json
  {
    "scheduler": {
      "ativo": true,
      "horarios": ["05:00", "12:00", "15:00", "20:00"],
      "limiteDiario": 12,
      "quantidadePorExecucao": 3,
      "intervaloEntreMensagensMs": 3000,
      "proximoEnvio": "2026-10-15T12:00:00-03:00",
      "janelaShopeeHoras": 12
    },
    "whatsapp": {
      "status": "connected",
      "numero": "5511999999999",
      "destino": { "id": "120363000000000000@g.us", "nome": "Grupo de Promoções" },
      "grupos": []
    },
    "storage": {
      "tipo": "sqlite",
      "totalPromocoes": 42
    }
  }
  ```

#### `PUT /api/settings`
Atualiza configurações do agendador e janela da Shopee.
- **Campos aceitos**:
  - `ativo`: boolean
  - `horarios`: array de strings `["HH:mm"]` (máximo 4 itens)
  - `limiteDiario`: inteiro entre 1 e 100
  - `quantidadePorExecucao`: inteiro >= 1
  - `intervaloEntreMensagensMs`: inteiro entre 0 e 600.000 ms
  - `janelaShopeeHoras`: inteiro entre 1 e 168 horas
- **Restrição**: Rejeita parâmetros sensíveis, credenciais ou tentativa de ativação de plataformas indisponíveis.

---

### 4.5 Plataformas e Integrações

#### `GET /api/platforms`
Lista o catálogo de plataformas suportadas e seus estados atuais.

#### `GET /api/platforms/:key`
Retorna estado detalhado da plataforma especificada.

#### `PUT /api/platforms/:key/active`
Ativa ou desativa a integração com a plataforma especificada.

#### `POST /api/platforms/:key/sync`
Dispara sincronização manual sob lock distribuído.

#### `GET /api/platforms/:key/config`
Consulta a configuração pública e mascarada da plataforma (credenciais como `appId` e `secret` são sempre mascaradas com asteriscos).

#### `PUT /api/platforms/:key/config`
Atualiza credenciais da plataforma (Shopee). Resposta retorna valores estritamente mascarados.

---

### 4.6 WhatsApp

#### `GET /api/whatsapp/status`
Retorna estado da conexão (`conectado`, `conectando`, `desconectado`), booleano `conectado` e necessidade de QR Code.

#### `GET /api/whatsapp/qr`
Retorna imagem PNG do QR code para pareamento quando desconectado.

#### `POST /api/whatsapp/reconnect`
Solicita reinício limpo da conexão com o WhatsApp.

#### `GET /api/whatsapp/groups`
Lista grupos disponíveis na conta conectada.

#### `PUT /api/whatsapp/group`
Define o grupo de destino configurado para envio de promoções.
- **Corpo**: `{ "groupId": "120363000000000000@g.us" }`

#### `DELETE /api/whatsapp/group`
Desvincula o grupo de destino configurado.

#### `POST /api/whatsapp/test`
Verifica a conexão com o WhatsApp e validação do grupo de destino configurado.
- Não envia nenhuma mensagem ao grupo.
- Não gera QR code desnecessariamente.
- Retorna diagnóstico em português ou erro `503 WHATSAPP_OFFLINE` quando desconectado.

---

### 4.7 Envios e Envio Manual Shopee

#### `GET /api/sends`
Lista paginada de envios realizados e tentativas com filtros por plataforma e status.

#### `GET /api/sends/summary`
Resumo das métricas de envio do dia (enviados hoje, limite, próximo envio).

#### `GET /api/sends/:attemptId/message`
Retorna o snapshot exato da mensagem de texto formatada enviada na tentativa.

#### `POST /api/sends/manual/resolve`
Valida e extrai identificador de oferta de uma URL direta da Shopee.
- Exclusivo para Shopee (`https://shopee.com.br/...` ou `https://s.shopee.com.br/...`).
- Mercado Livre não é aceito.

#### `POST /api/sends/manual/preview`
Gera prévia da mensagem e dados do produto a partir de link Shopee resolvido.

#### `POST /api/sends/manual/send`
Executa o envio manual de um produto Shopee.
- Requer header `Idempotency-Key`.
- Realiza recheca de preço e disponibilidade antes do envio.

---

### 4.8 Atividades

#### `GET /api/activities`
Lista o registro cronológico de auditoria do sistema (sincronizações, rechecagens, alterações de agendamento, envios e limpezas de retenção).
- Nenhum detalhe expõe dados sensíveis, cookies, tokens ou secrets.

---

### 4.9 Retenção e Limpeza Automática

- A política padrão de retenção de histórico é de **90 dias**.
- Produtos com status `sent` ou `failed` sem histórico relevante (sem envios confirmados, sem snapshots de mensagem, sem snapshots de comissão e sem atividades atreladas) são limpos com segurança.
- Produtos em fila ativa (`pending`, `sending`, `ambiguous`) nunca são apagados pela retenção.
- Não há endpoints nem opções de interface para exclusão manual de produtos nem backup/restauração.
