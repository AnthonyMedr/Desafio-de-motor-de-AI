import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, loadTenants } from '../src/config.js';
import type { IncomingMessage, LlmProvider, ModelRequest } from '../src/contracts.js';
import { Engine } from '../src/engine.js';
import { MockProvider } from '../src/llm/mock.js';
import { Store } from '../src/store.js';

describe('motor integrado sem rede', () => {
  let store: Store;
  let engine: Engine;
  let provider: MockProvider;
  let sequence = 0;
  const settings = loadEnv({ BURST_WINDOW_MS: '8000' });
  const tenants = loadTenants();
  const input = (texto: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ message_id: `msg-${++sequence}`, tenant_id: 'sol-nascente', telefone: 'lead-teste', texto, timestamp: new Date().toISOString(), autor: 'lead', simulacao: true, ...extra });
  async function send(text: string, extra: Partial<IncomingMessage> = {}) {
    store.enqueue(input(text, extra), Date.now(), settings.burstWindowMs);
    vi.setSystemTime(Date.now() + settings.burstWindowMs);
    await engine.tick();
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00-03:00'));
    store = new Store();
    provider = new MockProvider();
    engine = new Engine(store, tenants, provider, settings);
  });
  afterEach(async () => { await engine.stop(); store.close(); vi.useRealTimers(); });

  it('processa C1, exige ficha completa, consulta, reserva e notifica apenas em simulação', async () => {
    for (const text of ['boa tarde, quero colocar energia solar', 'João Pereira, de Caruaru', 'é minha, quitada', 'casa', 'uns 480 por mês', 'financiado', 'pode ser quinta de manhã']) await send(text);
    const s = store.snapshot('sol-nascente', 'lead-teste')!;
    expect(s.ficha).toEqual({ nome: 'João Pereira', cidade: 'Caruaru', propriedade: 'proprio', tipo_imovel: 'casa', conta_luz: 480, pagamento: 'financiado' });
    expect(s.tags).toContain('qualificado');
    expect(s.conversa.stage).toBe('Agendado');
    expect(s.agendamentos).toHaveLength(1);
    expect(s.notificacoes).toMatchObject([{ simulated: 1, status: 'simulated' }]);
    expect(s.proveniencia).toHaveLength(6);
    expect(s.acoes.filter(a => a.status === 'failed')).toEqual([]);
    const finalActions = s.acoes.filter(a => a.turn_id === s.mensagens.at(-1)!.turn_id);
    expect(finalActions.findIndex(a => a.name === 'consultar_agenda')).toBeLessThan(finalActions.findIndex(a => a.name === 'marcar_agenda'));
  });
  it('reinicia janela a cada mensagem e usa todas as mensagens da rajada C3', async () => {
    const spy = vi.spyOn(provider, 'generate');
    store.enqueue(input('olá'), Date.now(), 8000);
    vi.setSystemTime(Date.now() + 2000);
    store.enqueue(input('sou Carlos Lima de Olinda, casa própria, conta de uns 600'), Date.now(), 8000);
    vi.setSystemTime(Date.now() + 2000);
    store.enqueue(input('queria saber como funciona'), Date.now(), 8000);
    vi.setSystemTime(Date.now() + 4000);
    await engine.tick();
    expect(spy).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 4000);
    await engine.tick();
    const s = store.snapshot('sol-nascente', 'lead-teste')!;
    expect(s.mensagens.filter(m => m.author === 'ia')).toHaveLength(1);
    expect(s.ficha).toMatchObject({ nome: 'Carlos Lima', cidade: 'Olinda', propriedade: 'proprio', tipo_imovel: 'casa', conta_luz: 600 });
    expect(s.mensagens.at(-1)!.text).toMatch(/financiar|vista/i);
    expect(s.mensagens.at(-1)!.text).not.toMatch(/qual.*nome|qual.*cidade|qual.*conta|próprio ou alugado/i);
  });
  it('reproduz C3 com evidência sem acento e mantém a propriedade e a prova original', async () => {
    const text = 'sou Carlos Lima de Olinda, casa própria, conta de uns 600';
    const replay: LlmProvider = {
      name: 'mock',
      async generate(request) {
        if (request.rounds.length > 0) return { model: 'replay-c3', calls: [], text: 'Você prefere financiar ou pagar à vista?' };
        return { model: 'replay-c3', calls: [
          { id: 'replay-nome', name: 'atualizar_ficha', args: { campo: 'nome', valor: 'Carlos Lima', source_message_id: 'C3-2', evidencia: 'Carlos Lima' } },
          { id: 'replay-cidade', name: 'atualizar_ficha', args: { campo: 'cidade', valor: 'Olinda', source_message_id: 'C3-2', evidencia: 'Olinda' } },
          { id: 'replay-propriedade', name: 'atualizar_ficha', args: { campo: 'propriedade', valor: 'proprio', source_message_id: 'C3-2', evidencia: 'propria' } },
          { id: 'replay-tipo_imovel', name: 'atualizar_ficha', args: { campo: 'tipo_imovel', valor: 'casa', source_message_id: 'C3-2', evidencia: 'casa' } },
          { id: 'replay-conta_luz', name: 'atualizar_ficha', args: { campo: 'conta_luz', valor: 600, source_message_id: 'C3-2', evidencia: '600' } },
        ] };
      },
    };
    engine = new Engine(store, tenants, replay, settings);
    for (const [index, content] of ['olá', text, 'queria saber como funciona'].entries()) {
      store.enqueue(input(content, { message_id: `C3-${index + 1}` }), Date.now(), 8000);
      vi.setSystemTime(Date.now() + 2000);
    }
    vi.setSystemTime(Date.now() + 8000);
    await engine.tick();
    const s = store.snapshot('sol-nascente', 'lead-teste')!;
    expect(s.ficha).toEqual({ nome: 'Carlos Lima', cidade: 'Olinda', propriedade: 'proprio', tipo_imovel: 'casa', conta_luz: 600 });
    expect(s.mensagens.filter(m => m.author === 'ia')).toHaveLength(1);
    expect(s.mensagens.at(-1)!.text).toMatch(/financiar|vista/);
    expect(s.acoes.filter(a => a.status === 'failed')).toEqual([]);
    expect(s.proveniencia.find(p => p.campo === 'propriedade')).toMatchObject({ evidence: text, source_message_id: 'C3-2' });
  });
  it('duplicata antes/depois do processamento não repete resposta ou ações nem estende a janela', async () => {
    const payload = input('moro de aluguel');
    store.enqueue(payload, Date.now(), 8000);
    const due = store.getConversation(payload.tenant_id, payload.telefone)!.due_at;
    vi.setSystemTime(Date.now() + 2000);
    expect(store.enqueue(payload, Date.now(), 8000).duplicate).toBe(true);
    expect(store.getConversation(payload.tenant_id, payload.telefone)!.due_at).toBe(due);
    vi.setSystemTime(due!);
    await engine.tick();
    const before = store.snapshot(payload.tenant_id, payload.telefone)!;
    store.enqueue(payload, Date.now(), 8000);
    vi.setSystemTime(Date.now() + 10000);
    await engine.tick();
    const after = store.snapshot(payload.tenant_id, payload.telefone)!;
    expect(after.mensagens).toHaveLength(2);
    expect(after.acoes).toEqual(before.acoes);
  });
  it('suspende com assumir, registra humano e religar inclui histórico sem extrair afirmações humanas', async () => {
    await send('oi');
    store.intervene('sol-nascente', 'lead-teste', 'assumir', Date.now(), 8000);
    await send('quero continuar');
    await send('O lead se chama Inventado e mora em Recife', { autor: 'humano' });
    expect(store.messages(1).filter(m => m.author === 'ia')).toHaveLength(1);
    const spy = vi.spyOn(provider, 'generate');
    store.intervene('sol-nascente', 'lead-teste', 'religar', Date.now(), 8000);
    vi.setSystemTime(Date.now() + 8000);
    await engine.tick();
    expect(spy.mock.calls[0][0].history.some(m => m.author === 'humano')).toBe(true);
    expect(store.snapshot('sol-nascente', 'lead-teste')!.ficha).toEqual({});
    expect(store.messages(1).filter(m => m.author === 'ia')).toHaveLength(2);
  });
  it('isola ficha, ações e mensagens com mesmo telefone e mesmo message_id entre tenants', async () => {
    await send('sou Carlos Lima de Olinda, casa própria, conta de uns 600', { message_id: 'id-compartilhado' });
    const second = [...tenants.keys()].find(t => t !== 'sol-nascente')!;
    await send('oi', { tenant_id: second, message_id: 'id-compartilhado' });
    expect(store.snapshot(second, 'lead-teste')!.ficha).toEqual({});
    expect(store.metrics(second).total_conversas).toBe(1);
    expect(store.snapshot('sol-nascente', 'lead-teste')!.ficha.nome).toBe('Carlos Lima');
  });
  it('cliente antigo recebe ação de transferência, tag, estágio e uma confirmação; depois IA permanece parada', async () => {
    await send('oi, já instalei com vocês, minha placa parou de gerar');
    await send('ainda está sem gerar');
    const s = store.snapshot('sol-nascente', 'lead-teste')!;
    expect(s.tags).toContain('cliente-antigo');
    expect(s.conversa).toMatchObject({ stage: 'Humano', mode: 'humano' });
    expect(s.mensagens.filter(m => m.author === 'ia')).toHaveLength(1);
    expect(s.acoes.filter(a => a.name === 'transferir_humano' && a.status === 'success')).toHaveLength(1);
  });
  it('preserva consumo desconhecido do mock como null nas métricas', async () => {
    await send('oi');
    const metrics = store.metrics('sol-nascente');
    expect(metrics.tokens_entrada).toBeNull();
    expect(metrics.custo_estimado_usd).toBeNull();
    expect(metrics.custo_medio_conversa_usd).toBeNull();
    expect(metrics.denominador_custo_medio).toBe(0);
  });
  it('aceita Caruaru como evidência literal dentro da apresentação completa do lead', async () => {
    const scripted: LlmProvider = { name: 'scripted', async generate(req) {
      if (!req.rounds.length) return { model: 'scripted', calls: [{ id: 'cidade', name: 'atualizar_ficha', args: { campo: 'cidade', valor: 'Caruaru', source_message_id: req.batch[0].message_id, evidencia: 'Caruaru' } }] };
      return { model: 'scripted', calls: [], text: 'O imóvel é próprio ou alugado?' };
    } };
    engine = new Engine(store, tenants, scripted, settings);
    await send('João Pereira, de Caruaru');
    const s = store.snapshot('sol-nascente', 'lead-teste')!;
    expect(s.ficha.cidade).toBe('Caruaru');
    expect(s.proveniencia).toEqual([expect.objectContaining({ evidence: 'Caruaru', source_message_id: s.mensagens[0].message_id })]);
    expect(s.acoes.filter(a => a.name === 'atualizar_ficha')).toEqual([expect.objectContaining({ status: 'success' })]);
  });
  it('não repete o efeito de ferramenta quando o modelo reordena os mesmos argumentos', async () => {
    const scripted: LlmProvider = { name: 'scripted', async generate(req) {
      const source = req.batch[0];
      if (req.rounds.length > 1) return { model: 'scripted', calls: [], text: 'Em qual cidade fica o imóvel?' };
      const args = req.rounds.length === 0
        ? { campo: 'nome', valor: 'Ana', source_message_id: source.message_id, evidencia: source.text }
        : { evidencia: source.text, source_message_id: source.message_id, valor: 'Ana', campo: 'nome' };
      return { model: 'scripted', calls: [{ id: `call-${req.rounds.length}`, name: 'atualizar_ficha', args }] };
    } };
    engine = new Engine(store, tenants, scripted, settings);
    await send('me chamo Ana');
    const s = store.snapshot('sol-nascente', 'lead-teste')!;
    expect(s.ficha.nome).toBe('Ana');
    expect(s.proveniencia).toHaveLength(1);
    expect(s.acoes.filter(a => a.name === 'atualizar_ficha')).toHaveLength(1);
  });
  it('serializa a conversa e deixa mensagem que chega durante LLM para um lote posterior', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    let requests = 0;
    const batches: string[][] = [];
    const blocking: LlmProvider = { name: 'blocking', async generate(req: ModelRequest) {
      batches.push(req.batch.map(m => m.text));
      if (requests++ === 0) { entered(); await gate; }
      return { model: 'blocking', calls: [], text: 'Qual é seu nome?' };
    } };
    engine = new Engine(store, tenants, blocking, settings);
    store.enqueue(input('primeira'), Date.now(), 8000);
    vi.setSystemTime(Date.now() + 8000);
    const first = engine.tick();
    await entry;
    store.enqueue(input('segunda'), Date.now(), 8000);
    vi.setSystemTime(Date.now() + 8000);
    await engine.tick();
    expect(requests).toBe(1);
    release();
    await first;
    await engine.tick();
    expect(batches).toEqual([['primeira'], ['segunda']]);
    expect(store.messages(1).filter(m => m.author === 'ia')).toHaveLength(2);
  });
});
