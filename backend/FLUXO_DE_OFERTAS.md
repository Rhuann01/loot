# Fluxo de ofertas — diagnóstico e proposta Shopee

Data da análise: 11/10/2026. Este relatório resulta da leitura do código TypeScript, documentos do repositório e documentação pública oficial da Shopee. Não foram alterados código, configuração ou banco de dados.

## Resumo

O fluxo produtivo atual é: o primeiro horário do scheduler coleta Mercado Livre pelo Apify, persiste no SQLite, reserva os maiores descontos e envia ao WhatsApp. No envio automático, o link de afiliado do Mercado Livre é gerado depois da reserva e antes de publicar. A chave única já é adequada para plataformas múltiplas: (source_key, external_product_id).

A arquitetura, porém, ainda não desacoplou plataforma/coleta/publicação: ProductSource existe, mas não é usado; o scheduler chama Mercado Livre explicitamente; e só Mercado Livre tem regra de link. Para Shopee, a mudança menos invasiva é completar contratos e registries comuns, preservando SQLite, fila e scheduler únicos.

Problemas confirmados: seleção manual não participa do scheduler; desconto_minimo_global não é aplicado; não existe intervalo entre mensagens do lote; itens podem ficar presos em sending após queda; e a trava de simultaneidade só cobre um processo Node.

## Fluxo atual

1. src/index.ts, iniciar():
   - chama iniciarScheduler();
   - inicia o servidor API;
   - inicia conexão WhatsApp em paralelo.
2. src/auto/scheduler.ts, recarregarScheduler():
   - cria tarefas node-cron em memória com horários persistidos em config;
   - no primeiro horário, se Mercado Livre está ativo, chama processarESalvarOfertas();
   - em cada horário, chama enviarLote().
3. src/scraper/apify.ts, processarESalvarOfertas():
   - busca, valida, ordena e limita ofertas;
   - chama salvarProduto() para cada uma.
4. src/auto/scheduler.ts, enviarLote():
   - chama reservarProdutoParaEnvio(), mudando-o para sending;
   - opcionalmente gera link afiliado;
   - chama enviarProduto();
   - marca sucesso com marcarComoEnviado().

## 1. Coleta do Mercado Livre

Referências de código:

- src/scraper/mercadolivre.ts apenas reexporta buscarOfertas e processarESalvarOfertas de src/scraper/apify.ts.
- buscarOfertas() cria ApifyClient e chama o Actor de terceiros karamelo/mercadolivre-scraper-brasil-portugues. Não é a API oficial do Mercado Livre.
- Entrada enviada ao Actor: keyword = ofertas, scrapeOfertas = true, maxPagesOfertas = 1 e promoted = false.
- A chamada usa timeout = 180, waitSecs = 240 e opcionalmente APIFY_ACTOR_BUILD.
- Há no máximo duas tentativas. O código repete HTTP 408, 425, 429 e 5xx; para erros sem status trata mensagens de autenticação, crédito/cobrança ou não-encontrado como permanentes. São critérios locais, não limites inferidos de APIs.

A função aceita somente objetos que tenham, como strings, estes seis campos: zProdutoLink, eTituloProduto, novoPreco, precoAnterior, precoDiscount e imagemLink. São também os únicos campos do tipo interno OfertaApify retornado por buscarOfertas().

processarESalvarOfertas() extrai o ID MLB da URL com expressão MLB seguido de dígitos, extrai o percentual de precoDiscount, ordena por desconto e limita a APIFY_MAX_PRODUCTS de 1 a 20, padrão 20. Oferta sem ID MLB é descartada. Registra em config a última tentativa, sucesso, resultado e erro.

A coleta persiste link_original e link_afiliado inicialmente com a URL original. Portanto não gera link de afiliado. A exceção é apenas de teste: tests/preparar_amostra_whatsapp.ts chama gerarLinkAfiliado() para montar uma amostra.

## 2. Persistência, identidade e duplicação

src/db/index.ts cria produtos; src/db/queries.ts, salvarProduto(), grava dados. A identidade canônica é source_key + external_product_id, protegida pelo índice único uq_produtos_source_external.

A migração recria bancos que antes tinham unicidade apenas em produto_id_ml, exatamente para permitir IDs externos iguais em lojas distintas. produto_id_ml é compatibilidade de Mercado Livre; marketplace_origem espelha source_key. Nenhum dos dois deve ser identidade Shopee.

salvarProduto() usa INSERT com ON CONFLICT(source_key, external_product_id) DO UPDATE. Logo uma coleta posterior da mesma plataforma/produto não cria outra linha. No conflito atualiza preços, desconto, imagem, origem e criado_em; não atualiza nome, link afiliado, selecionado, enviado ou estado da fila. O contador salvas é de itens processados, não de inserções.

Consequências confirmadas:

- Não há duplicata por produto/plataforma.
- Atualizar criado_em faz oferta pendente parecer recente novamente.
- Produto já enviado continua enviado = 1 se preço/desconto mudar; não retorna à fila.
- Correção de nome na fonte não é refletida.
- envios contém histórico básico, produto_id e enviado_em.

## 3. Seleção e histórico de publicação

Há duas consultas de seleção:

- getMelhoresDescontos(limite) filtra não enviados, pending ou failed, menos de três tentativas e itens na janela janela_fallback_dias, padrão 3; ordena por desconto. É usada só por tests/testar_scheduler.ts.
- reservarProdutoParaEnvio() é a consulta efetivamente usada por enviarLote(). Aplica estados e tentativas, mas não a janela temporal e não define desempate. Em transação, muda para sending, incrementa tentativas e retorna a linha.

getProdutosSelecionadosManualmente() e alternarSelecao() existem, mas enviarLote() não os usa. Portanto seleção manual hoje não prioriza nem restringe envio automático. desconto_minimo_global é configurado e exposto pela API, mas não é consultado por coleta ou fila. Comissão e categoria não entram na ordenação.

marcarComoEnviado() muda o produto para sent e cria envios na mesma transação. Isso evita repetição automática da mesma linha. O histórico não guarda destino, ID/recibo da mensagem, URL enviada ou tentativas falhas. POST /produtos/:id/reenviar publica novamente e cria novo histórico, mas sem motivo/auditoria.

## 4. Geração de link afiliado

O ponto exato do envio agendado é src/auto/scheduler.ts, enviarLote(), depois de reservarProdutoParaEnvio() e antes de enviarProduto():

1. Só entra para source_key igual a mercado_livre, link_original presente e link_afiliado ainda igual ao original.
2. Chama getAffiliateProvider(mercado_livre).generateLink(linkOriginal).
3. src/integrations/registry.ts delega para gerarLinkAfiliado() em src/affiliate/mercadolivre/provider.ts.
4. Em sucesso, atualizarLinkAfiliado() persiste o resultado e o envio usa o valor retornado.

O provider ML usa cookie, CSRF e endpoint web do Link Builder; não é uma API oficial documentada. Se falhar, o scheduler registra aviso e envia URL original. POST /api/affiliate/ml/link também gera sob demanda. Assim, a regra “somente no envio agendado” é verdadeira para publicação automática, mas não é garantia global. O reenvio usa o link armazenado e não o revalida.

## 5. Scheduler, simultaneidade e reinicialização

src/index.ts chama iniciarScheduler() uma vez. iniciarScheduler() chama recarregarScheduler(). A configuração fica em config; tarefas cron ficam apenas em memória e são recriadas a cada boot.

- recarregarScheduler() interrompe tarefas anteriores antes de criar novas. PUT /api/scheduler a chama após salvar configuração, evitando duplicação dentro do processo.
- Há no máximo quatro horários. Só índice zero coleta ML. Todos podem enviar a fração inteira de limite_diario. quantidade_por_execucao é legado e não controla o lote.
- execucaoEmAndamento evita sobreposição somente dentro do processo. Não há lock SQLite/líder para duas instâncias.
- Não há catch-up: restart aguarda próximo cron. Reiniciar após primeiro horário posterga coleta até o próximo primeiro horário.
- Após queda pós-reserva, status fica sending e não é mais selecionado. Não existe recuperação no boot.
- Erro “WhatsApp não está conectado” fica failed, elegível até três tentativas. Outros erros ficam sending por serem ambíguos; também não há reconciliação.
- Cron não tem fuso explícito. O limite diário usa date(now) do SQLite: o fuso operacional precisa ser confirmado.

## 6. WhatsApp

src/whatsapp/connection.ts mantém uma conexão Baileys em memória, com sessão em auth_info. Compartilha a promessa de conexão em andamento. Quedas comuns reconectam após 2.000 ms; logout exige QR novo; conexão substituída não reconecta automaticamente.

src/whatsapp/sender.ts, enviarProduto(), exige socket e whatsapp_grupo_id, monta mensagem e executa sock.sendMessage. Se imagem_url é HTTP(S), envia imagem com legenda; senão texto.

Não existe intervalo configurável entre itens de enviarLote(): próximo item começa quando o anterior resolve. O único intervalo de publicação é entre horários do scheduler; 2.000 ms é apenas reconexão WhatsApp.

Sucesso é registrado após sendMessage resolver, via marcarComoEnviado e envios. Não grava ID de mensagem nem confirmação posterior de entrega. Falha por socket desconectado vira failed; outras viram sending para evitar duplicação. O lote para no primeiro erro.

## 7. Integrações e extensão mínima

Estrutura atual:

- integration_catalog e store_integrations conhecem Mercado Livre, Shopee e TikTok Shop; Shopee inicia indisponível/inativa.
- src/integrations/types.ts declara IntegrationKey, ProductSource e AffiliateProvider.
- src/integrations/registry.ts registra apenas afiliado ML. Não há registry de fontes e ProductSource.fetchProducts() retorna unknown[] sem consumidor.
- src/scraper/apify.ts mistura mapeamento, limite/ordenação e persistência de ML.

A extensão mínima, sem novo scheduler, é:

1. Definir DTO interno tipado de produto coletado: source_key, external_product_id, nome, preços, desconto, imagem, URL original, categoria e comissão opcional.
2. Adaptar ML para produzir esse DTO e centralizar upsert.
3. Criar ShopeeProductSource com API oficial aprovada e o mesmo DTO.
4. Criar registry de coletores; no primeiro horário, o scheduler existente percorre somente integrações ativas.
5. Escolher provider afiliado por produto.source_key e capacidade de link: já fornecido, gerar tardiamente ou indisponível. Gerar somente após reserva e antes de enviar.

## 8. Shopee: documentação verificada

Foram encontrados e verificados:

- [Explorer oficial Open API Afiliados Shopee](https://open-api.affiliate.shopee.com.br/explorer): solicita AppId e Secret; sem credencial válida não expõe schema/operações.
- [Programa de Afiliados Shopee](https://help.shopee.com.br/portal/4/article/93461-Programa-de-Afiliados): confirma links personalizados.
- [Termos do Programa](https://help.shopee.com.br/portal/10/article/124094-Programa-de-Afiliados-da-Shopee-Termos-e-Condi%C3%A7%C3%B5es): confirma links disponibilizados pela plataforma e mídia aprovada.

A documentação pública acessível não permite afirmar endpoints, parâmetros, assinatura, permissões, paginação, campos, validade de link, cotas ou limites. Assim, não é seguro inventá-los.

A proposta é obter AppId/Secret de homologação, consultar o schema autenticado no Explorer/portal e implementar exclusivamente as operações autorizadas. Se a API expuser catálogo/ofertas e links, usar somente ela — sem scraping Shopee. Se expuser conversão de URL mas não catálogo, pedir à Shopee a fonte oficial adicional autorizada, e não substituir a lacuna por scraping.

Confirmar antes de implementar:

- operações disponíveis ao afiliado brasileiro e campos: ID estável, preço, preço anterior, imagem, URL, desconto, comissão, estoque/validade;
- autenticação, assinatura, escopos e renovação;
- geração de link ou link já fornecido; validade/reuso permitido;
- paginação, filtros, erros/retry e limites efetivamente publicados;
- aprovação de WhatsApp/grupo e mídia cadastrada como canal de divulgação.

Comportamento proposto, condicionado a isso:

- segredos SHOPEE_APP_ID e SHOPEE_SECRET fora do banco; estado operacional em store_integrations;
- source_key igual a shopee e external_product_id igual ao ID oficial;
- URL original persistida; link afiliado já retornado não é convertido novamente; conversão obrigatória é feita somente após reserva;
- não usar sessao_afiliado, modelo específico de cookie/CSRF manual ML, para credenciais oficiais Shopee.

## Problemas confirmados e hipóteses

Confirmados:

- ML é coletado por Actor Apify de terceiros.
- Deduplicação por plataforma/produto existe.
- Geração tardia ocorre só no caminho automático ML; endpoints/testes podem gerar fora dele.
- Seleção manual e desconto mínimo não afetam envio automático.
- Produção ignora janela temporal; não há intervalo entre mensagens.
- Sending abandonado não é recuperado.
- Trava é local ao processo.
- Histórico é mínimo; Shopee não possui coletor/provider executável.

A validar:

- Contrato/versionamento real do Actor Apify.
- Fuso de data do SQLite contra o dia de negócio.
- Se resolução de sendMessage é confirmação operacional suficiente.
- Schema, permissões e regras da API Shopee, inclusive WhatsApp.

## Alterações mínimas necessárias

1. DTO comum e ingestão/upsert centralizado.
2. Registry de coletores e scheduler único para ativos.
3. Provider escolhido por plataforma/capacidade e chamado pós-reserva.
4. Regra única para seleção manual, desconto mínimo, janela, desempate e reenvio.
5. Recuperação/auditoria de reservas antigas e lock se houver múltiplas instâncias.
6. Intervalo configurável e histórico de tentativa/sucesso com destino/ID de mensagem.
7. Adaptador Shopee somente após schema oficial autenticado.

## Plano de implementação e testes de aceitação

### Etapa 1 — contrato e persistência comum

Criar DTO e centralizar ingestão, mantendo o índice atual.

- ML e Shopee com mesmo ID externo criam duas linhas.
- Recoleta da mesma chave mantém uma linha e atualiza campos definidos.
- Recoleta não limpa sent sem regra explícita.
- ML preserva o resultado mapeado atual.

### Etapa 2 — seleção e fila

Unificar consulta/reserva e definir seleção manual, desconto mínimo, janela, desempate e recuperação.

- Seleção manual tem precedência acordada.
- Produto abaixo do mínimo não é reservado automaticamente.
- Produto fora da janela segue fallback documentado.
- Empates têm ordem estável.
- Falha conhecida reexecuta até limite; queda não deixa reserva invisível.
- Sucesso cria um histórico; reenvio intencional cria histórico distinguível.

### Etapa 3 — publicação e link tardio

Generalizar provider e inserir intervalo no mesmo enviarLote().

- Coletor nunca chama provider de link.
- Link é pedido uma vez, depois da reserva.
- Falha segue política testada e auditada.
- Lote respeita intervalo configurado.
- Sucesso/falha registra dados operacionais suficientes.

### Etapa 4 — Shopee oficial

Com credencial de homologação, documentar schema real e implementar só operações autorizadas.

- Credencial inválida não derruba outras integrações.
- Resposta oficial vira DTO sem scraping.
- Recoletas Shopee não duplicam.
- Link tardio só ocorre no envio quando documentação exigir; link já fornecido não converte.
- Paginação/filtros/retry seguem documentação efetiva, sem limites supostos.

### Etapa 5 — scheduler único

Fazer o scheduler atual executar coletores ativos e definir exclusão multi-instância quando aplicável.

- Alterar horários não duplica tarefas locais.
- Horários simultâneos não sobrepõem lote local.
- Restart recria tarefas e aplica política às reservas.
- Em multi-instância, apenas uma instância coleta/envia por janela, ou há prova de reserva atômica.
- Falha de um coletor não bloqueia envio pendente nem outros coletores.

## Testes existentes e lacunas

Os testes são scripts manuais/integração, não suíte unitária isolada. npm test compila e executa apenas tests/testar_ml_cookies.ts, que cobre adição, substituição e remoção de cookies.

- testar_scraper.ts imprime retorno real Apify.
- testar_scheduler.ts coleta e envia até três itens, com lógica antiga e sem scheduler/reserva reais.
- preparar_amostra_whatsapp.ts coleta e gera links de teste.
- testar_whatsapp_conexao.ts usa QR, conexão e grupos reais.
- testar_whatsapp_promocao.ts envia promoção real.
- testar_whatsappp.ts está comentado.

Faltam testes automatizados de schema/migração/índice, upsert, seleção, reserva concorrente, limite diário, restart, cron, geração tardia/fallback, WhatsApp, histórico, registry e Shopee. As etapas devem acrescentar SQLite temporário e doubles de Apify/API/WhatsApp antes de integração com credenciais reais.

