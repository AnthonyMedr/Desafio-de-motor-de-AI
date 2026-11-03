import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluate, parseEvaluationArgs, type EvaluationReport } from '../scripts/evaluate.js';
import { loadEnv } from '../src/config.js';
import type { LlmProvider, ModelStep } from '../src/contracts.js';
import { MockProvider } from '../src/llm/mock.js';

afterEach(() => { vi.useRealTimers(); });

describe('execução e progresso da avaliação', () => {
  it('seleciona um cenário sem apresentá-lo como cinco casos e respeita os limites recebidos', async () => {
    const settings = { ...loadEnv({}), llmTimeoutMs: 1000, llmTurnTimeoutMs: 5000 };
    const report = await evaluate(new MockProvider(), { scenarioIds: ['C3'], settings });
    expect(report.status).toBe('passed');
    expect(report.selected_scenarios).toEqual(['C3']);
    expect(report.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(report.limits).toMatchObject({ call_timeout_ms: 1000, turn_timeout_ms: 5000 });
    expect(report.results).toHaveLength(1);
    expect(report.metrics?.tokens_entrada).toBeNull();
  });

  it('mostra espera e preserva ficha e ações em parciais antes da resposta final', async () => {
    vi.useFakeTimers();
    const mock = new MockProvider();
    const provider: LlmProvider = { name: 'mock', async generate(request) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return mock.generate(request);
    } };
    const logs: string[] = [];
    const checkpoints: EvaluationReport[] = [];
    const running = evaluate(provider, { scenarioIds: ['C3'], heartbeatMs: 100, onProgress: text => logs.push(text), onCheckpoint: report => checkpoints.push(report) });
    await vi.advanceTimersByTimeAsync(5000);
    const report = await running;
    expect(report.status).toBe('passed');
    expect(logs.some(line => line.includes('Aguardando chamada'))).toBe(true);
    expect(checkpoints.some(r => r.status === 'running' && r.results[0].evidence?.ficha.nome === 'Carlos Lima' && !r.results[0].evidence?.mensagens.some(m => m.author === 'ia'))).toBe(true);
    expect(checkpoints.at(-1)?.status).toBe('passed');
  });

  it('interrompe provedor que ignora o sinal, preserva evidências e não inicia os cenários restantes', async () => {
    const generate = vi.fn(() => new Promise<ModelStep>(() => {}));
    const controller = new AbortController();
    const checkpoints: EvaluationReport[] = [];
    const running = evaluate({ name: 'scripted', generate }, { signal: controller.signal, onCheckpoint: report => checkpoints.push(report) });
    controller.abort(new Error('Parada solicitada no teste.'));
    const report = await running;
    expect(report.status).toBe('interrupted');
    expect(report.reason).toBe('Parada solicitada no teste.');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(report.results[0].evidence?.mensagens[0].text).toBe('boa tarde, quero colocar energia solar');
    expect(report.results.slice(1).every(r => r.status === 'not_executed')).toBe(true);
    expect(checkpoints.at(-1)?.status).toBe('interrupted');
  });

  it('para no primeiro 429, sem consumir outras chamadas reais ou classificar a cota como falha dos cinco casos', async () => {
    const generate = vi.fn(async () => { throw Object.assign(new Error('Gemini HTTP 429; cota excedida.'), { status: 429 }); });
    const settings = { ...loadEnv({}), llmMaxRetries: 3, maxJobAttempts: 3 };
    const report = await evaluate({ name: 'gemini', generate }, { settings });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(report.status).toBe('blocked');
    expect(report.provider_requests).toBe(1);
    expect(report.summary).toMatchObject({ total: 5, failed: 0, blocked: 1, not_executed: 4 });
    expect(report.results[0].evidence?.chamadas_llm[0].error).toMatch(/429/);
    expect(report.results.slice(1).every(r => r.status === 'not_executed' && !r.evidence)).toBe(true);
  });

  it('valida seleção e intervalo da linha de comando', () => {
    expect(parseEvaluationArgs(['--real', '--scenario', 'C2,C3', '--interval-ms', '4000'])).toEqual({ real: true, scenarioIds: ['C2', 'C3'], intervalMs: 4000 });
    expect(parseEvaluationArgs(['--scenario=C1']).scenarioIds).toEqual(['C1']);
    expect(parseEvaluationArgs(['--real']).intervalMs).toBe(8000);
    expect(() => parseEvaluationArgs(['--scenario', 'C9'])).toThrow('Cenário inválido');
    expect(() => parseEvaluationArgs(['--scenario'])).toThrow('Informe um valor');
    expect(() => parseEvaluationArgs(['--interval-ms=-1'])).toThrow('entre 0 e 60000');
  });
});
