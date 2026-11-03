# Motor de atendimento com IA

API do desafio técnico: múltiplos tenants, memória persistente, qualificação de leads, sete ferramentas, intervenção humana, métricas e avaliação C1–C5.
Implementação pequena em Node.js 24, TypeScript, Express e SQLite. Sem frontend e sem envio de WhatsApp.
O modelo de LLM utilizado nos testes reais é o `gemini-3.5-flash-lite`.


## 1. Como rodar

Com Docker e Compose instalados:

```sh
docker compose up --build
```

A API roda em `http://localhost:3000`, com provedor **mock por padrão**, sem chave e sem rede externa. O volume Docker `atendimento-data` preserva o SQLite ao reiniciar ou recriar o container. O processo executa as migrations e valida os arquivos de tenant ao iniciar. `GET /health` é a verificação de saúde. `docker compose down` encerra o serviço; a opção `-v` também remove o volume e os dados.

Para desenvolver localmente com Node.js 24, instale primeiro as dependências. No Windows, a compilação do `better-sqlite3` pode exigir o Visual Studio Build Tools com a carga **Desktop development with C++**.

```sh
npm ci
npm run dev
```

Copie `.env.example` para `.env` e ajuste os parâmetros do provedor escolhido.

- `npm run build` compila o projeto.
- `npm start` executa a versão compilada.
- `npm run typecheck` verifica os tipos.
- `npm test` executa os testes sem rede.
- `npm run smoke`, depois do build, verifica o serviço compilado por HTTP e sua persistência após reiniciar.

Importe a [coleção do Postman](postman/colecao-teste-postman.json) usando **Import → Files**. As variáveis da coleção já incluem `baseUrl=http://localhost:3000`, `tenant=sol-nascente` e `lead=lead-postman-001`.

Execute **01 - Saúde da API**, depois **02 - Enviar mensagem ao assistente**. Aguarde a janela de 8 segundos mais o processamento do modelo e execute **04 - Consultar conversa e resposta da IA**. Para continuar, edite `texto` no Body de 02 e envie novamente: o ID e o timestamp são gerados a cada envio. Para testar idempotência, use 03, que repete exatamente a última mensagem de 02. Para iniciar outra conversa, altere `lead` nas variáveis. Use as requisições manualmente; o Runner não aguarda automaticamente o processamento assíncrono.

A coleção também inclui intervenção humana, métricas e outro tenant. A chave Gemini fica no `.env` do servidor. O campo `telefone` é uma chave opaca; use identificadores fictícios, sem número real. Os exemplos para extensões de editor continuam em [examples.http](examples.http).

| Método e rota | Uso |
| --- | --- |
| `POST /webhook/mensagem` | Persiste mensagem; retorna 202 com accepted e duplicate |
| `GET /conversas/:tenant_id/:telefone` | Histórico, ficha, tags, estágio e evidências das ações |
| `POST /intervencao` | `{tenant_id, telefone, acao: "assumir" ou "religar"}` |
| `GET /metricas/:tenant_id` | Conversas, qualificação, transferências, consumo e cobertura de custo |
| `GET /health` | Saúde da API |

O webhook recebe `message_id`, `tenant_id`, `telefone`, `texto` e `timestamp` ISO com fuso. `autor` admite lead (padrão) ou humano. `simulacao` é true por padrão e não muda depois da criação da conversa. Repetir a mensagem idêntica retorna duplicate; reutilizar o ID com conteúdo diferente é conflito. A resposta da IA aparece na consulta da conversa depois do processamento.

Para usar Gemini (modelo utilizado nos testes), configure `LLM_PROVIDER=gemini` e `GEMINI_API_KEY` no `.env`, então recrie o serviço com `docker compose up --build -d`. O modelo padrão é `gemini-3.5-flash-lite`. A [documentação oficial de preços](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite) lista opção gratuita; disponibilidade e limites dependem da conta/região. A [documentação de function calling](https://ai.google.dev/gemini-api/docs/function-calling) descreve o protocolo usado pelo adaptador. Sem chave, continue com mock.

Sem `GEMINI_API_KEY`, `npm run evaluate:real` registra a avaliação como não executada. Com uma chave válida, o comando usa o provedor real e pode consumir cota.

Se aparecer `Gemini HTTP 404`, confira `GEMINI_MODEL`. Erros 503 indicam indisponibilidade temporária do provedor. Após atingir o limite de tentativas, o serviço transfere para humano e pausa a conversa; use `/intervencao` com `religar` antes de continuar com uma nova mensagem e um novo `message_id`.

## 2. Arquitetura

```text
HTTP → validação → SQLite → worker no mesmo processo → LLM
                                                       ↓
        resposta + métricas ← regras + ferramentas validadas
```

O HTTP confirma a persistência antes de responder. A pendência fica no banco. O worker agrupa mensagens, carrega tenant/ficha/histórico, solicita propostas ao provedor e devolve resultados das ferramentas ao modelo antes da resposta final.

Os arquivos principais são `src/api.ts` (rotas), `src/engine.ts` (orquestração), `src/domain.ts` (qualificação e evidências), `src/store.ts` (SQLite), `src/llm/` (provedores), `migrations/` e `tenants/`. O contrato HTTP está resumido na seção anterior; as decisões de arquitetura e limitações estão descritas nas seções seguintes.

## 3. Decisões e motivos

- **SQLite e worker local:** O SQLite permite manter transações, migrations e pendências persistidas em um único serviço, sem depender de um SGBD externo. Como há apenas uma instância do worker, o bloqueio de execução por conversa é local ao processo.
- **Rajada com debounce:** Cada mensagem nova do lead reinicia a janela usando o horário de recepção do servidor. Mensagens duplicadas e mensagens humanas não reiniciam a janela. Mensagens que chegam durante o processamento do LLM formam o próximo lote para resposta.
- **Idempotência no banco:** O escopo é `(tenant_id, message_id)`, e payloads divergentes que reutilizam um ID são rejeitados. A conversa é identificada por `(tenant_id, telefone)`, sendo `telefone` uma chave opaca dentro do tenant.
- **Memória verificável:** atualizar a ficha exige uma mensagem do lead, `source_message_id` e um trecho de `evidencia`, com tolerância a diferenças de acentuação, caixa e espaços. O valor é validado de forma determinística tanto no texto completo quanto no trecho. Isso impede selecionar uma frase fora de contexto para esconder uma negativa. Informações ausentes permanecem ausentes, e o histórico humano fornece contexto, mas não comprova uma declaração do lead.
- **Regras no servidor:** `src/domain.ts` aplica os critérios do Anexo B e o limite configurado por tenant. Uma conta igual a R$ 250 desqualifica; nesse critério, somente valores acima do limite qualificam. Leads em imóveis alugados ou apartamentos recebem a alternativa por assinatura. Dúvidas e clientes antigos são encaminhados para atendimento humano.
- **Ferramentas validadas:** `adicionar_tag`, `mover_estagio`, `atualizar_ficha`, `notificar_equipe`, `transferir_humano`, `consultar_agenda` e `marcar_agenda`. O servidor decide as permissões e o estado e não aceita a reserva de um horário inexistente, ocupado ou passado. A reserva exige uma afirmação explícita com data e hora ou com dia da semana e período; perguntas e negações são recusadas. A conclusão exige tag e estágio, enquanto perguntas intermediárias mantêm o atendimento em andamento.
- **Intervenção segura:** assumir o atendimento suspende a automação e invalida a geração do turno. A autorização é conferida antes das ações e da resposta, e religar a automação não recupera uma resposta invalidada. A ferramenta `transferir_humano` grava a confirmação ao lead, a pausa, a tag e o estágio na mesma transação. Mensagens humanas entram apenas no histórico.
- **Desqualificação preservada:** oferecer energia por assinatura não comprova interesse nem autoriza transferência. Para um lead desqualificado, tag/estágio de atendimento humano e transferência exigem pedido explícito do lead ou uma falha técnica autorizada pelo próprio servidor. O motivo escrito pelo modelo não concede essa permissão.
- **Simulação e notificação:** `simulacao=true` é o padrão. A outbox registra, uma vez por conversa, o que seria enviado. Fora da simulação, a notificação é registrada com o estado `pending`.
- **Prompt e provedor:** as configurações do tenant e o histórico são enviados ao adaptador. O prompt orienta o tom e as regras; schemas, evidências e validações no código aplicam os limites. Tempo, rodadas e tentativas são controlados por variáveis de ambiente.

A agenda mock oferece horários futuros às 09h e 14h nos próximos 14 dias corridos, somente de segunda a sexta, em America/Sao_Paulo (UTC−03:00), persistidos e reservados por tenant. Configurações JSON são carregadas na inicialização: depois de alterar, reinicie. A política de não se identificar espontaneamente nunca autoriza afirmar que a IA é uma pessoa.

O tempo de espera inclui a janela de rajada e as chamadas ao modelo. Com Gemini, consultar após 10 segundos pode mostrar o turno ainda em `processing`. `LLM_TIMEOUT_MS=30000` limita cada chamada; `LLM_TURN_TIMEOUT_MS=120000` limita o turno inteiro, incluindo ferramentas e novas tentativas. Esses limites são separados para que uma chamada de extração mais lenta não impeça o modelo de formular a resposta final após a ferramenta.

## 4. Custo estimado por conversa

Preços configuráveis em **USD por milhão de tokens**: entrada `0.30` e saída `2.50` para Gemini 3.5 Flash-Lite, modelo utilizado nos testes, conforme a [tabela oficial](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite). A saída inclui tokens de raciocínio quando informados pelo provedor. A estimativa de um turno soma todas as rodadas e tentativas cujo consumo esteja disponível:

```text
custo_turno_usd = (tokens_entrada × preco_entrada + tokens_saida × preco_saida) / 1.000.000
custo_conversa_usd = soma dos turnos da conversa
```

Exemplo **hipotético**, sem representar medição: 2.000 tokens de entrada e 500 de saída custariam `US$ 0,00185`. Conversas com múltiplas rodadas podem consumir mais. A cota gratuita pode resultar em cobrança efetiva zero; a estimativa continua mostrando o preço de tabela. Preço estimado não é uma fatura.

Os custos reais dependem do consumo informado pelo provedor. O relatório `reports/evaluation-real.json` é atualizado por `npm run evaluate:real`; quando a chave está ausente, ele registra `skipped` e não apresenta consumo.

O mock e as respostas sem dados de uso mantêm tokens e custos como desconhecidos, sem atribuir zero artificialmente. As métricas informam a cobertura, e a média de custo considera apenas conversas cujos turnos possuem dados completos. Os percentuais de qualificados e transferidos usam todas as conversas do tenant como denominador: qualificação considera a tag atual, enquanto transferência considera o histórico de intervenção ou transferência. Custos parciais são separados dos custos completos.

Para reduzir: agrupar rajadas, limitar contexto com memória estruturada e resumo verificável, reduzir rodadas desnecessárias, testar prompts com os cenários e usar um modelo menor se mantiver os critérios. Resumos e cache precisam preservar as evidências e o isolamento do tenant.

## 5. Resultado da avaliação

```sh
npm test
npm run typecheck
npm run build
npm run smoke
npm run evaluate
npm run evaluate:real
```

Os comandos acima devem ser executados no ambiente local ou no container antes da entrega. `npm run smoke` gera `reports/smoke.json` quando a verificação de HTTP, SQLite, reinício e idempotência é concluída com sucesso.

`npm run evaluate` executa a avaliação determinística e gera os arquivos `reports/evaluation-mock.md` e `reports/evaluation-mock.json`. A avaliação real mais recente terminou com **5 de 5 cenários aprovados**:

| Cenário | Gemini real |
| --- | --- |
| C1 — Caminho feliz | Passou |
| C2 — Imóvel alugado | Passou |
| C3 — Rajada e informações em uma única mensagem | Passou |
| C4 — Cliente antigo | Passou |
| C5 — Tentativa de manipular a IA | Passou |

Em **03/11/2026**, a [avaliação real](reports/evaluation-real.md) registrou `status: passed`, com **5 aprovados, 0 reprovados, 0 bloqueados e 0 não executados**. O [relatório real em JSON](reports/evaluation-real.json) contém as evidências completas da execução.

### Progresso, interrupção e seleção de cenários

O script imprime cenário, mensagem, chamada, rodada e tempo decorrido enquanto espera o modelo. Ele usa os limites do `.env`; não substitui silenciosamente o prazo por 60 segundos. A execução real faz uma pausa padrão de 8 segundos entre turnos para reduzir rajadas contra a cota gratuita. Essa pausa é configurável e não garante disponibilidade de cota.

Para avaliar somente C1 com pausa maior:

```sh
npm run evaluate:real -- --scenario C1 --interval-ms 12000
```

Para executar todos os cinco com a mesma pausa:

```sh
npm run evaluate:real -- --interval-ms 12000
```

Durante a execução, `reports/evaluation-real.partial.json` e `.md` são atualizados; ao selecionar C1, os arquivos usam `evaluation-real-C1.partial`. `Ctrl+C` encerra e salva o parcial como interrupted. Esses arquivos são evidências para inspeção, não retomada automática: uma nova execução reinicia os casos selecionados em um banco isolado.

Erros de cota ou acesso, como HTTP 429 ou 404, interrompem novas chamadas reais: o caso atual fica blocked e os restantes not_executed. Isso é distinto de falhar nos critérios de negócio. Os testes mockados continuam sem consumo faturado: tokens e custo ficam null.

## 6. Limitações conhecidas

- Sem autenticação/autorização de usuários: tenant_id vem do corpo/rota. O isolamento das consultas não substitui identidade autenticada.
- Uma instância por banco. Não executar várias réplicas contra o mesmo volume como se fosse uma fila distribuída.
- Agenda mock local, sem calendário externo, feriados ou capacidade de vendedores. Outbox sem consumidor, sem WhatsApp e sem notificações externas.
- Uma visita e uma notificação por conversa; reagendamento, cancelamento e múltiplas visitas exigem um fluxo novo.
- Validador de evidências é conservador e cobre os campos do desafio; variações linguísticas podem exigir nova pergunta em vez de preencher a ficha.
- Sem frontend, streaming, busca externa ou gestão de usuários. Mudanças de tenant exigem reinício.
- Timeout/retry não constituem transação com o fornecedor LLM. Retentativas podem consumir cota; consumo ausente fica explicitamente desconhecido.
- Integração real depende de chave, rede e disponibilidade/cota do provedor. Avaliação mockada não substitui avaliação real.

## 7. Próximos passos para 100 empresas

Autenticar a origem e associar o tenant à credencial; proteger segredos e acesso aos dados. Migrar para um banco adequado à operação, adquirir trabalhos com leases e particionar pela conversa para permitir workers concorrentes. Manter unicidade de mensagens e efeitos no banco.

Adicionar consumidor de outbox com chave idempotente, retentativas e confirmação de entrega; integrar agenda real com reserva atômica. Aplicar limites de consumo e rate limiting por tenant, expor filas/falhas/latência com alertas, definir retenção e acesso aos dados e testar backup/restauração. Versionar configurações e prompts e avaliar regressões com conversas reais anonimizadas, separando qualidade do modelo e invariantes do motor.
