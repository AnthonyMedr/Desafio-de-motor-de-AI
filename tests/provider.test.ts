import { describe, expect, it, vi } from 'vitest';
import { loadTenants } from '../src/config.js';
import type { Conversation, Message, ModelRequest, ModelRound } from '../src/contracts.js';
import { GeminiProvider } from '../src/llm/gemini.js';
import { MockProvider } from '../src/llm/mock.js';

const tenant = loadTenants().get('sol-nascente')!;
const conversation: Conversation = { id: 1, tenant_id: tenant.tenant_id, telefone: 'lead-c1', simulacao: 1, mode: 'auto', generation: 0, stage: 'Qualificado', profile_json: '{}', tags_json: '["qualificado"]', due_at: null, closed: 0, created_at: 0, updated_at: 0 };
const message: Message = { id: 1, tenant_id: tenant.tenant_id, conversation_id: 1, message_id: 'lead-1', text: 'pode ser quinta de manhã', author: 'lead', timestamp: '2026-11-01T12:00:00Z', received_at: 0, status: 'done', turn_id: null };
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { tenant, conversation, profile: { nome: 'João Pereira', cidade: 'Caruaru', propriedade: 'proprio', tipo_imovel: 'casa', conta_luz: 480, pagamento: 'financiado' }, history: [message], batch: [message], tools: [{ name: 'consultar_agenda', description: 'Consulta horários.', parameters: { type: 'object', properties: {}, additionalProperties: false } }], rounds: [], signal: new AbortController().signal, now: Date.parse('2026-11-01T12:00:00Z'), ...overrides };
}

describe('Gemini REST sem rede', () => {
  it('preserva parts e assinatura, devolve consultas ao modelo antes de expor texto', async () => {
    const content = { role: 'model', parts: [{ text: 'Texto antes da consulta que não deve ser publicado.' }, { functionCall: { name: 'consultar_agenda', args: {} }, thoughtSignature: 'opaque-signature' }] };
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 2 } }), { status: 200 }));
    fetchStub.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Qual horário você confirma?' }] } }], modelVersion: 'gemini-2.5-flash-version' }), { status: 200 }));
    const provider = new GeminiProvider({ apiKey: 'fake-unit-test-key', fetch: fetchStub });
    const first = await provider.generate(request());
    expect(first.calls[0]!.name).toBe('consultar_agenda');
    expect(first.text).toBeUndefined();
    expect(first.raw).toEqual(content);
    expect(first.usage).toEqual({ input: 12, output: 6, thinking: 2 });
    const round: ModelRound = { step: first, results: [{ id: first.calls[0]!.id, name: 'consultar_agenda', result: { horarios: ['2026-11-05T09:00:00-03:00'] } }] };
    const second = await provider.generate(request({ rounds: [round] }));
    const [url, options] = fetchStub.mock.calls[1]!;
    const body = JSON.parse(String(options!.body));
    expect(String(url)).not.toContain('fake-unit-test-key');
    expect(options!.headers).toMatchObject({ 'x-goog-api-key': 'fake-unit-test-key' });
    expect(body.contents.at(-2)).toEqual(content);
    expect(body.contents.at(-1)).toMatchObject({ role: 'user', parts: [{ functionResponse: { name: 'consultar_agenda', response: { horarios: ['2026-11-05T09:00:00-03:00'] } } }] });
    expect(body.tools[0].functionDeclarations[0].parametersJsonSchema.type).toBe('object');
    expect(String(url)).toContain('/models/gemini-3.5-flash-lite:generateContent');
    expect(second.text).toBe('Qual horário você confirma?');
    expect(second.model).toBe('gemini-2.5-flash-version');
    expect(second.usage).toBeUndefined();
  });
  it('propaga signal e falhas sem expor corpo do provedor ou chave', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive error body', { status: 429 }));
    const provider = new GeminiProvider({ apiKey: 'secret', fetch: fetchStub });
    await expect(provider.generate(request())).rejects.toThrow('Gemini HTTP 429; cota excedida.');
    const controller = new AbortController(); controller.abort();
    await expect(provider.generate(request({ signal: controller.signal }))).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: 404, message: 'modelo gemini-3.5-flash-lite indisponível', hint: 'GEMINI_MODEL' },
    { status: 503, message: 'provedor temporariamente indisponível', hint: 'mais tarde' },
  ])('explica o erro HTTP $status sem expor a resposta privada do provedor', async ({ status, message, hint }) => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-provider-body secret-key', { status }));
    const provider = new GeminiProvider({ apiKey: 'secret-key', fetch: fetchStub });
    const error = await provider.generate(request()).then(
      () => { throw new Error('Era esperada uma falha do provedor.'); },
      caught => caught as Error & { status: number },
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(status);
    expect(error.message).toContain(message);
    expect(error.message).toContain(hint);
    expect(error.message).not.toMatch(/private-provider-body|secret-key/);
  });
});

describe('mock determinístico de ferramentas', () => {
  it('não inventa tokens e consulta antes de marcar um horário consentido', async () => {
    const provider = new MockProvider();
    const first = await provider.generate(request());
    expect(first.usage).toBeUndefined();
    expect(first.calls.map(call => call.name)).toEqual(['consultar_agenda']);
    expect(first.text).toBeUndefined();
    const round: ModelRound = { step: first, results: [{ id: first.calls[0]!.id, name: 'consultar_agenda', result: { horarios: ['2026-11-05T09:00:00-03:00', '2026-11-05T14:00:00-03:00'] } }] };
    const second = await provider.generate(request({ rounds: [round] }));
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]).toMatchObject({ name: 'marcar_agenda', args: { horario: '2026-11-05T09:00:00-03:00' } });
  });
  it('apenas oferece horários quando o lead não consentiu', async () => {
    const provider = new MockProvider();
    const initial = request({ batch: [{ ...message, text: 'financiado' }] });
    const first = await provider.generate(initial);
    const rounds: ModelRound[] = [{ step: first, results: [{ id: first.calls[0]!.id, name: 'consultar_agenda', result: { horarios: ['2026-11-05T09:00:00-03:00'] } }] }];
    const second = await provider.generate({ ...initial, rounds });
    expect(second.calls).toEqual([]);
    expect(second.text).toContain('Qual você confirma?');
  });
  it('pede pagamento faltante após a rajada C3, sem repetir os dados conhecidos', async () => {
    const step = await new MockProvider().generate(request({ profile: { nome: 'Carlos Lima', cidade: 'Olinda', propriedade: 'proprio', tipo_imovel: 'casa', conta_luz: 600 }, batch: [{ ...message, text: 'queria saber como funciona' }] }));
    expect(step.calls).toEqual([]);
    expect(step.text).toContain('financiar');
    expect(step.text).not.toMatch(/cidade|nome|conta|apartamento/);
  });
});
