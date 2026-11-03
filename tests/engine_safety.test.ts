import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, loadTenants, type Settings } from '../src/config.js';
import type { IncomingMessage, LlmProvider, ModelRequest, ModelStep, Profile, ToolCall } from '../src/contracts.js';
import { Engine } from '../src/engine.js';
import { MockProvider } from '../src/llm/mock.js';
import { Store } from '../src/store.js';
import { futureSlots } from '../src/tools.js';

const baseline = Date.parse('2026-11-01T12:00:00.000Z');
const stores: Store[] = [];
const engines: Engine[] = [];
const qualified: Profile = { nome: 'Ana', cidade: 'Recife', propriedade: 'proprio', tipo_imovel: 'casa', conta_luz: 400, pagamento: 'a_vista' };
const call = (name: string, args: unknown): ToolCall => ({ id: name, name, args });
const step = (calls: ToolCall[] = [], text = 'Podemos continuar?'): ModelStep => ({ model: 'scripted', calls, text });
function harness(generate: LlmProvider['generate'], overrides: Partial<Settings> = {}) {
  const store = new Store();
  stores.push(store);
  let now = baseline;
  const provider: LlmProvider = { name: 'scripted', generate };
  const settings = { ...loadEnv({}), burstWindowMs: 10, llmMaxRetries: 0, ...overrides };
  const worker = new Engine(store, loadTenants(), provider, settings, () => now);
  engines.push(worker);
  function enqueue(texto: string, telefone = 'lead-safety-ficticio', profile?: Profile) {
    const input: IncomingMessage = {
      tenant_id: 'aurora-solar', telefone, texto, message_id: `${telefone}-${now}`,
      timestamp: new Date(now).toISOString(), autor: 'lead', simulacao: true,
    };
    const conversation = store.enqueue(input, now, settings.burstWindowMs).conversation;
    if (profile) store.db.prepare('UPDATE conversations SET profile_json=? WHERE id=?').run(JSON.stringify(profile), conversation.id);
    return conversation;
  }
  return { store, worker, enqueue, advance(ms = 10) { now += ms; }, now: () => now };
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});

describe('permissões do servidor para ferramentas', () => {
  it.each(['minha conta vem uns 350', 'Não quero falar com humano', 'Quanto custa a assinatura?'])(
    'preserva a desqualificação sem aceitar interesse ou atendimento humano inventado: %s', async text => {
      const env = harness(async request => !request.rounds.length
        ? step([call('adicionar_tag', { tag: 'atendimento-humano' }), call('mover_estagio', { estagio: 'Humano' }), call('transferir_humano', { motivo: 'Lead demonstrou interesse na energia solar por assinatura.' })])
        : step([], 'Vou encaminhar seu atendimento para a equipe.'));
      const conversation = env.enqueue(text, 'lead-alugado', { ...qualified, propriedade: 'alugado' });
      env.store.db.prepare("UPDATE conversations SET stage='Desqualificado',tags_json='[\"desqualificado\"]' WHERE id=?").run(conversation.id);
      env.advance();
      await env.worker.tick();
      const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
      expect(snapshot.conversa).toMatchObject({ mode: 'auto', stage: 'Desqualificado' });
      expect(snapshot.tags).toEqual(['desqualificado']);
      expect(snapshot.acoes).toContainEqual(expect.objectContaining({ name: 'transferir_humano', status: 'failed' }));
      expect(snapshot.notificacoes).toHaveLength(0);
      expect(snapshot.mensagens.find(m => m.author === 'ia')!.text).toContain('outra opção possível');
    },
  );

  it.each(['Quero falar com um atendente', 'Quero que a equipe explique a assinatura'])(
    'permite transferência de desqualificado com pedido explícito: %s', async text => {
      const env = harness(async () => step([call('transferir_humano', { motivo: 'Pedido explícito do lead.' })]));
      const conversation = env.enqueue(text, 'pedido-humano', { ...qualified, propriedade: 'alugado' });
      env.advance();
      await env.worker.tick();
      const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
      expect(snapshot.conversa).toMatchObject({ mode: 'humano', stage: 'Humano' });
      expect(snapshot.acoes).toContainEqual(expect.objectContaining({ name: 'transferir_humano', status: 'success' }));
      expect(snapshot.mensagens.filter(m => m.author === 'ia')).toHaveLength(1);
    },
  );

  it('somente o servidor pode autorizar transferência técnica de desqualificado, mesmo com motivo idêntico ao enviado pelo modelo', async () => {
    const motivo = 'Limite de tentativas do processamento atingido.';
    const env = harness(async request => {
      if (!request.rounds.length) return step([call('server-fallback:transferir_humano', { motivo }), call('transferir_humano', { motivo })]);
      throw Object.assign(new Error('Provedor indisponível.'), { status: 503 });
    }, { maxJobAttempts: 1 });
    const conversation = env.enqueue('minha conta vem uns 350', 'falha-tecnica', { ...qualified, propriedade: 'alugado' });
    env.advance();
    await env.worker.tick();
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    const transfers = snapshot.acoes.filter(a => a.name === 'transferir_humano');
    expect(transfers.map(a => a.status)).toEqual(['failed', 'success']);
    expect(transfers[0].key).not.toBe(transfers[1].key);
    expect(snapshot.acoes).toContainEqual(expect.objectContaining({ name: 'server-fallback:transferir_humano', status: 'failed' }));
    expect(transfers[1].key).toMatch(/^server-fallback:/);
    expect(snapshot.conversa).toMatchObject({ mode: 'humano', stage: 'Humano' });
    expect(snapshot.mensagens.filter(m => m.author === 'ia')).toHaveLength(1);
  });

  it('conclui o agendamento com consentimento de quinta de manhã mesmo se o modelo pedir confirmação novamente', async () => {
    const env = harness(async request => !request.rounds.length
      ? step([call('consultar_agenda', {})])
      : step([], 'Fica bom para você às 09:00 de quinta?'));
    const conversation = env.enqueue('pode ser quinta de manhã', 'consentimento-quinta', qualified);
    env.advance();
    await env.worker.tick();
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(snapshot.conversa.stage).toBe('Agendado');
    expect(snapshot.agendamentos).toEqual([expect.objectContaining({ starts_at: '2026-11-05T09:00:00-03:00' })]);
    expect(snapshot.notificacoes).toHaveLength(1);
    expect(snapshot.acoes).toContainEqual(expect.objectContaining({ name: 'marcar_agenda', status: 'success' }));
    expect(snapshot.mensagens.find(m => m.author === 'ia')!.text).toContain('Sua visita está agendada');
  });

  it('não troca a quinta ocupada pela semana seguinte ao concluir um consentimento relativo', async () => {
    const env = harness(async request => !request.rounds.length
      ? step([call('consultar_agenda', {})])
      : step([], 'Vamos escolher outro horário disponível?'));
    const occupied = env.enqueue('Olá!', 'visita-ja-reservada', qualified);
    const slot = '2026-11-05T09:00:00-03:00';
    env.store.db.prepare("UPDATE messages SET status='done' WHERE conversation_id=?").run(occupied.id);
    env.store.db.prepare('UPDATE conversations SET due_at=NULL WHERE id=?').run(occupied.id);
    env.store.db.prepare("INSERT INTO turns(id,tenant_id,conversation_id,state,started_at) VALUES('reserva-existente','aurora-solar',?,'completed',?)").run(occupied.id, baseline);
    env.store.db.prepare('INSERT INTO slots(id,tenant_id,starts_at) VALUES(?,?,?)').run(`aurora-solar:${slot}`, 'aurora-solar', slot);
    env.store.db.prepare("INSERT INTO appointments(tenant_id,conversation_id,slot_id,turn_id,created_at) VALUES('aurora-solar',?,?,'reserva-existente',?)").run(occupied.id, `aurora-solar:${slot}`, baseline);
    const conversation = env.enqueue('pode ser quinta de manhã', 'quinta-ocupada', qualified);
    env.advance();
    await env.worker.tick();
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(snapshot.agendamentos).toHaveLength(0);
    expect(snapshot.notificacoes).toHaveLength(0);
    expect(snapshot.conversa.stage).toBe('Qualificado');
  });

  it('rejeita ferramenta desconhecida, argumentos extras, ficha inventada e encerramento sem pré-condições', async () => {
    const env = harness(async request => !request.rounds.length ? step([
      call('executar_sql', { sql: 'DROP TABLE conversations' }),
      call('atualizar_ficha', { campo: 'nome', valor: 'Pessoa Inventada', source_message_id: request.batch[0]!.message_id, evidencia: 'Olá!' }),
      call('mover_estagio', { estagio: 'Agendado', tenant_id: 'sol-nascente' }),
      call('adicionar_tag', { tag: 'qualificado' }),
      call('notificar_equipe', { resumo: 'Inventei um agendamento.' }),
    ]) : step([], 'Visita agendada e equipe notificada.'));
    const conversation = env.enqueue('Olá!');
    env.advance();
    await env.worker.tick();
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(snapshot.ficha).toEqual({});
    expect(snapshot.proveniencia).toHaveLength(0);
    expect(snapshot.agendamentos).toHaveLength(0);
    expect(snapshot.notificacoes).toHaveLength(0);
    expect(snapshot.tags).not.toContain('qualificado');
    expect(snapshot.conversa).toMatchObject({ closed: 0, stage: 'Qualificacao' });
    expect(snapshot.acoes.filter(action => action.status === 'failed')).toHaveLength(5);
    expect(snapshot.mensagens.find(message => message.author === 'ia')!.text).not.toMatch(/visita agendada/i);
  });

  it.each(['2030-01-01T09:00:00-03:00', '2026-11-02T09:00:00-03:00'])(
    'impede reserva de horário inexistente ou ocupado: %s', async desired => {
      const env = harness(async request => {
        if (!request.rounds.length) return step([call('consultar_agenda', {})]);
        if (request.rounds.length === 1) return step([call('marcar_agenda', { horario: desired })]);
        return step([], 'Sua visita está agendada.');
      });
      const occupied = env.enqueue('Olá!', 'outro-lead', qualified);
      env.store.db.prepare("UPDATE messages SET status='done' WHERE conversation_id=?").run(occupied.id);
      env.store.db.prepare('UPDATE conversations SET due_at=NULL WHERE id=?').run(occupied.id);
      if (desired.startsWith('2026')) {
        env.store.db.prepare(`INSERT INTO turns(id,tenant_id,conversation_id,state,started_at)
          VALUES('other-turn','aurora-solar',?,'completed',?)`).run(occupied.id, baseline);
        env.store.db.prepare('INSERT INTO slots(id,tenant_id,starts_at) VALUES(?,?,?)').run(`aurora-solar:${desired}`, 'aurora-solar', desired);
        env.store.db.prepare(`INSERT INTO appointments(tenant_id,conversation_id,slot_id,turn_id,created_at)
          VALUES('aurora-solar',?,?,'other-turn',?)`).run(occupied.id, `aurora-solar:${desired}`, baseline);
      }
      const target = env.enqueue(`Confirmo a visita em ${desired}.`, 'target-lead', qualified);
      env.advance();
      await env.worker.tick();
      const snapshot = env.store.snapshot('aurora-solar', target.telefone)!;
      expect(snapshot.agendamentos).toHaveLength(0);
      expect(snapshot.acoes).toContainEqual(expect.objectContaining({ name: 'marcar_agenda', status: 'failed' }));
      expect(snapshot.mensagens.find(item => item.author === 'ia')!.text).not.toMatch(/está agendada/i);
    },
  );

  it.each([
    { text: 'Vocês têm segunda de manhã?', slot: futureSlots(baseline)[0]! },
    { text: 'Confirmo a visita em 2026-11-09.', slot: '2026-11-09T09:00:00-03:00' },
  ])('exige consentimento afirmativo com horário, sem inferi-lo de "$text"', async ({ text, slot }) => {
    const env = harness(async request => {
      if (!request.rounds.length) return step([call('consultar_agenda', {})]);
      if (request.rounds.length === 1) return step([call('marcar_agenda', { horario: slot })]);
      return step([], 'Podemos combinar a visita.');
    });
    const conversation = env.enqueue(text, 'consentimento-ambiguo', qualified);
    env.advance();
    await env.worker.tick();
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(snapshot.agendamentos).toHaveLength(0);
    expect(snapshot.acoes).toContainEqual(expect.objectContaining({ name: 'marcar_agenda', status: 'failed' }));
  });

  it('aceita consentimento explícito com data e hora ISO e completa reserva, estágio e notificação', async () => {
    const slot = futureSlots(baseline)[0]!;
    const env = harness(async request => {
      if (!request.rounds.length) return step([call('consultar_agenda', {})]);
      if (request.rounds.length === 1) return step([call('marcar_agenda', { horario: slot })]);
      return step([], 'Podemos concluir a visita.');
    });
    const conversation = env.enqueue(`Confirmo a visita em ${slot}.`, 'consentimento-iso', qualified);
    env.advance();
    await env.worker.tick();
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(snapshot.agendamentos).toEqual([expect.objectContaining({ starts_at: slot })]);
    expect(snapshot.conversa).toMatchObject({ stage: 'Agendado', closed: 1 });
    expect(snapshot.notificacoes).toEqual([expect.objectContaining({ simulated: 1, status: 'simulated' })]);
    expect(snapshot.mensagens.find(message => message.author === 'ia')!.text).toContain(slot);
  });
});

describe('limites e concorrência do processamento', () => {
  it('responde após salvar o nome quando as duas chamadas cabem nos prazos individuais, mesmo somando mais de 30 segundos', async () => {
    vi.useFakeTimers();
    const env = harness(async request => {
      if (!request.rounds.length) {
        await new Promise(resolve => setTimeout(resolve, 27_000));
        return step([call('atualizar_ficha', { campo: 'nome', valor: 'Jorge', source_message_id: request.batch[0]!.message_id, evidencia: 'Me chamo Jorge' })]);
      }
      expect(request.profile.nome).toBe('Jorge');
      expect(request.rounds[0].results[0].result.ok).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 18_000));
      return step([], 'Prazer, Jorge! Em qual cidade fica o imóvel?');
    });
    const conversation = env.enqueue('Me chamo Jorge');
    env.advance();
    const processing = env.worker.tick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(env.store.snapshot('aurora-solar', conversation.telefone)!.ficha.nome).toBe('Jorge');
    expect(env.store.snapshot('aurora-solar', conversation.telefone)!.mensagens.filter(m => m.author === 'ia')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    await processing;
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(snapshot.conversa.mode).toBe('auto');
    expect(snapshot.turnos).toEqual([expect.objectContaining({ state: 'completed', error: null })]);
    expect(snapshot.chamadas_llm).toHaveLength(2);
    expect(snapshot.chamadas_llm.every(c => c.status === 'success')).toBe(true);
    expect(snapshot.mensagens.filter(m => m.author === 'ia')).toEqual([expect.objectContaining({ text: 'Prazer, Jorge! Em qual cidade fica o imóvel?' })]);
    expect(snapshot.proveniencia).toHaveLength(1);
    expect(snapshot.acoes.some(a => a.name === 'transferir_humano')).toBe(false);
  });

  it('mantém o limite total do turno mesmo com várias chamadas dentro de seus prazos individuais', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const env = harness(async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 15));
      return step([call('mover_estagio', { estagio: 'Qualificacao' })]);
    }, { llmTimeoutMs: 30, llmTurnTimeoutMs: 40, maxJobAttempts: 1, llmMaxRetries: 2 });
    const conversation = env.enqueue('Olá!');
    env.advance();
    const processing = env.worker.tick();
    await vi.advanceTimersByTimeAsync(40);
    await processing;
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(calls).toBe(3);
    expect(snapshot.turnos).toEqual([expect.objectContaining({ state: 'failed', error: 'Tempo máximo do turno excedido.' })]);
    expect(snapshot.chamadas_llm.filter(c => c.status === 'success')).toHaveLength(2);
    expect(snapshot.conversa.mode).toBe('humano');
    expect(snapshot.mensagens.filter(m => m.author === 'ia')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(env.store.snapshot('aurora-solar', conversation.telefone)!.mensagens.filter(m => m.author === 'ia')).toHaveLength(1);
  });

  it('pode tentar novamente uma chamada que excedeu seu prazo sem reiniciar o prazo total', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const env = harness(async () => {
      if (++calls === 1) return new Promise<ModelStep>(() => {});
      await new Promise(resolve => setTimeout(resolve, 10));
      return step([], 'Em qual cidade fica o imóvel?');
    }, { llmTimeoutMs: 30, llmTurnTimeoutMs: 80, llmMaxRetries: 1, maxJobAttempts: 1 });
    const conversation = env.enqueue('Olá!');
    env.advance();
    const processing = env.worker.tick();
    await vi.advanceTimersByTimeAsync(40);
    await processing;
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(calls).toBe(2);
    expect(snapshot.conversa.mode).toBe('auto');
    expect(snapshot.turnos[0].state).toBe('completed');
    expect(snapshot.chamadas_llm.map(c => c.status)).toEqual(['failed', 'success']);
    expect(snapshot.chamadas_llm[0].error).toBe('Tempo máximo da chamada ao modelo excedido.');
    expect(snapshot.mensagens.filter(m => m.author === 'ia')).toHaveLength(1);
  });

  it('invalida ferramentas e resposta tardia quando humano assume, retomando com histórico atualizado', async () => {
    let release!: (value: ModelStep) => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const deferred = new Promise<ModelStep>(resolve => { release = resolve; });
    const mock = new MockProvider();
    let calls = 0;
    const requests: ModelRequest[] = [];
    const env = harness(async request => {
      requests.push(request);
      if (++calls === 1) { entered(); return deferred; }
      return mock.generate(request);
    });
    const conversation = env.enqueue('Olá!');
    env.advance();
    const processing = env.worker.tick();
    await waiting;
    await env.worker.tick();
    expect(calls).toBe(1);
    env.store.intervene('aurora-solar', conversation.telefone, 'assumir', env.now(), 10);
    env.store.enqueue({
      tenant_id: 'aurora-solar', telefone: conversation.telefone, message_id: 'humano-novo',
      texto: 'A equipe assumiu o atendimento.', timestamp: new Date(env.now()).toISOString(), autor: 'humano', simulacao: true,
    }, env.now(), 10);
    // O modo volta a auto antes de chegar o resultado antigo do LLM; a geração ainda deve invalidá-lo.
    env.store.intervene('aurora-solar', conversation.telefone, 'religar', env.now(), 10);
    release(step([call('transferir_humano', { motivo: 'Resposta tardia do modelo' })], 'Resposta inválida antiga.'));
    await processing;
    let snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(snapshot.acoes).toHaveLength(0);
    expect(snapshot.mensagens.filter(message => message.author === 'ia')).toHaveLength(0);
    expect(snapshot.mensagens[0]!.status).toBe('pending');
    expect(snapshot.turnos).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    expect(snapshot.conversa.mode).toBe('auto');
    await env.worker.tick();
    expect(calls).toBe(1);
    env.advance();
    await env.worker.tick();
    snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(snapshot.mensagens.filter(message => message.author === 'ia')).toHaveLength(1);
    expect(requests.slice(1).some(request => request.history.some(message => message.message_id === 'humano-novo'))).toBe(true);
  });

  it('encerra chamadas que ignoram AbortSignal e faz fallback humano após o limite de tentativas', async () => {
    vi.useFakeTimers();
    const env = harness(() => new Promise<ModelStep>(() => {}), { llmTimeoutMs: 20, maxJobAttempts: 1 });
    const conversation = env.enqueue('Olá!');
    env.advance();
    const processing = env.worker.tick();
    await vi.advanceTimersByTimeAsync(20);
    await processing;
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(snapshot.conversa.mode).toBe('humano');
    expect(snapshot.mensagens.filter(message => message.author === 'ia')).toHaveLength(1);
    expect(snapshot.acoes).toContainEqual(expect.objectContaining({ name: 'transferir_humano', status: 'success' }));
    expect(snapshot.chamadas_llm).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(snapshot.turnos).toEqual([expect.objectContaining({ state: 'failed' })]);
  });

  it('limita rodadas mesmo quando o provedor insiste na mesma ferramenta rejeitada', async () => {
    let calls = 0;
    const env = harness(async () => { calls++; return step([call('consultar_agenda', {})]); }, { llmMaxRounds: 2, maxJobAttempts: 1 });
    const conversation = env.enqueue('Olá!');
    env.advance();
    await env.worker.tick();
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(calls).toBe(2);
    expect(snapshot.acoes.filter(action => action.name === 'consultar_agenda')).toHaveLength(1);
    expect(snapshot.conversa.mode).toBe('humano');
    expect(snapshot.mensagens.filter(message => message.author === 'ia')).toHaveLength(1);
  });

  it('limita tentativas transitórias do provedor sem inventar consumo ou custo', async () => {
    let calls = 0;
    const env = harness(async () => { calls++; throw Object.assign(new Error('provider unavailable'), { status: 503 }); }, { llmMaxRetries: 1, maxJobAttempts: 1 });
    const conversation = env.enqueue('Olá!');
    env.advance();
    await env.worker.tick();
    expect(calls).toBe(2);
    const snapshot = env.store.snapshot('aurora-solar', conversation.telefone)!;
    expect(snapshot.chamadas_llm).toHaveLength(2);
    expect(snapshot.turnos).toEqual([expect.objectContaining({ tokens_input: null, tokens_output: null, cost_usd: null })]);
    expect(env.store.metrics('aurora-solar')).toMatchObject({ tokens_entrada: null, tokens_saida: null, custo_estimado_usd: null });
    expect(snapshot.conversa.mode).toBe('humano');
  });
});
