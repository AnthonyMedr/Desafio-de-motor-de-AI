import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from '../src/contracts.js';
import { Store } from '../src/store.js';

const stores: Store[] = [];
const paths: string[] = [];
function memory(): Store {
  const store = new Store();
  stores.push(store);
  return store;
}
function incoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    message_id: 'm1', tenant_id: 'solar-a', telefone: 'lead-ficticio-001', texto: 'Olá!',
    timestamp: '2026-11-01T12:00:00.000Z', autor: 'lead', simulacao: true, ...overrides,
  };
}
function turn(store: Store, id: string, conversationId: number, tenant = 'solar-a', cost: number | null = null): void {
  store.db.prepare(`INSERT INTO turns (id, conversation_id, tenant_id, state, started_at, cost_usd)
    VALUES (?, ?, ?, 'completed', 1000, ?)`).run(id, conversationId, tenant, cost);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  }
});

describe('Store: persistência e idempotência', () => {
  it('reserva o namespace de IDs internos sem criar conversa ou consumir idempotência', () => {
    const store = memory();
    expect(() => store.enqueue(incoming({ message_id: 'ai:turno-interno' }), 1000, 500))
      .toThrow(expect.objectContaining({ code: 'RESERVED_MESSAGE_ID' }));
    expect(store.getConversation('solar-a', incoming().telefone)).toBeUndefined();
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
  });

  it('mantém o escopo tenant + message_id e rejeita mudanças no payload original', () => {
    const store = memory();
    const first = store.enqueue(incoming(), 1000, 500);
    const duplicate = store.enqueue(incoming(), 1400, 500);
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.conversation.due_at).toBe(1500);
    expect(store.messages(first.conversation.id)).toHaveLength(1);
    expect(() => store.enqueue(incoming({ texto: 'Outro conteúdo' }), 1400, 500))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() => store.enqueue(incoming({ telefone: 'outro-lead' }), 1400, 500))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() => store.enqueue(incoming({ timestamp: '2026-11-01T12:00:01.000Z' }), 1400, 500))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    const otherTenant = store.enqueue(incoming({ tenant_id: 'solar-b' }), 1400, 500);
    expect(otherTenant.duplicate).toBe(false);
    expect(otherTenant.conversation.id).not.toBe(first.conversation.id);
    expect(store.snapshot('inexistente', incoming().telefone)).toBeUndefined();
  });

  it('congela simulacao por conversa e mantém rollback quando o payload conflita', () => {
    const store = memory();
    const first = store.enqueue(incoming(), 1000, 500);
    expect(() => store.enqueue(incoming({ message_id: 'm2', simulacao: false }), 1100, 500))
      .toThrow(expect.objectContaining({ code: 'SIMULATION_CONFLICT' }));
    expect(store.messages(first.conversation.id)).toHaveLength(1);
    expect(store.getById(first.conversation.id).due_at).toBe(1500);
  });

  it('reinicia a janela com cada nova lead, sem disparar para mensagem humana', () => {
    const store = memory();
    const first = store.enqueue(incoming(), 1000, 500);
    store.enqueue(incoming({ message_id: 'm2' }), 1300, 500);
    store.enqueue(incoming({ message_id: 'm3', autor: 'humano', texto: 'Bom dia!' }), 1500, 500);
    expect(store.getById(first.conversation.id).due_at).toBe(1800);
    expect(store.messages(first.conversation.id).map((message) => message.status)).toEqual(['pending', 'pending', 'done']);
    const humanOnly = store.enqueue(incoming({ message_id: 'h1', telefone: 'humano-apenas', autor: 'humano' }), 1000, 500);
    expect(humanOnly.conversation.due_at).toBeNull();
  });

  it('suspende o agendamento, audita intervenção e retoma pendências com nova geração', () => {
    const store = memory();
    const first = store.enqueue(incoming(), 1000, 500);
    const human = store.intervene('solar-a', incoming().telefone, 'assumir', 1200, 500)!;
    expect(human).toMatchObject({ mode: 'humano', generation: 1, due_at: null });
    expect(store.enqueue(incoming({ message_id: 'm2' }), 1300, 500).conversation.due_at).toBeNull();
    const resumed = store.intervene('solar-a', incoming().telefone, 'religar', 2000, 500)!;
    expect(resumed).toMatchObject({ id: first.conversation.id, mode: 'auto', generation: 2, due_at: 2500 });
    expect(store.snapshot('solar-a', incoming().telefone)!.intervencoes).toHaveLength(2);
    expect(store.intervene('solar-b', incoming().telefone, 'assumir', 2500, 500)).toBeUndefined();
  });

  it('persiste histórico no disco e recupera batch interrompido preservando turn_id', () => {
    const path = join(tmpdir(), `motor-store-${randomUUID()}.sqlite`);
    paths.push(path);
    const initial = new Store(path);
    const created = initial.enqueue(incoming(), 1000, 500);
    initial.db.prepare(`INSERT INTO turns (id, conversation_id, tenant_id, state, started_at)
      VALUES ('t1', ?, 'solar-a', 'processing', 1500)`).run(created.conversation.id);
    initial.db.prepare(`UPDATE messages SET status = 'processing', turn_id = 't1'`).run();
    initial.db.prepare('UPDATE conversations SET due_at = NULL').run();
    initial.close();
    const reopened = new Store(path);
    stores.push(reopened);
    reopened.recover(2500);
    expect(reopened.messages(created.conversation.id)[0]).toMatchObject({ status: 'pending', turn_id: 't1', text: 'Olá!' });
    expect(reopened.getById(created.conversation.id).due_at).toBe(2500);
    expect(reopened.db.prepare('SELECT state, finished_at FROM turns').get()).toEqual({ state: 'interrupted', finished_at: 2500 });
    expect(reopened.enqueue(incoming(), 3000, 500).duplicate).toBe(true);
    expect(reopened.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 });
  });

  it('impede referências cruzadas entre tenants e proveniência de outra conversa', () => {
    const store = memory();
    const a = store.enqueue(incoming(), 1000, 500).conversation;
    const b = store.enqueue(incoming({ message_id: 'b', telefone: 'outro-lead' }), 1000, 500).conversation;
    turn(store, 't1', a.id);
    expect(() => store.db.prepare(`INSERT INTO interventions (tenant_id, conversation_id, acao, created_at)
      VALUES ('solar-b', ?, 'assumir', 1000)`).run(a.id)).toThrow(/FOREIGN KEY/);
    expect(() => store.db.prepare(`INSERT INTO profile_changes
      (tenant_id, conversation_id, turn_id, campo, value_json, source_message_id, evidence, created_at)
      VALUES ('solar-a', ?, 't1', 'nome', '"Ana"', 'b', 'Ana', 1000)`).run(a.id)).toThrow(/FOREIGN KEY/);
    expect(b.id).not.toBe(a.id);
  });
});

describe('Store: métricas', () => {
  it('conta conversas únicas e inclui intervenção assumir no histórico das transferências', () => {
    const store = memory();
    const a = store.enqueue(incoming(), 1000, 500).conversation;
    const b = store.enqueue(incoming({ message_id: 'b', telefone: 'outro-lead' }), 1000, 500).conversation;
    store.enqueue(incoming({ tenant_id: 'solar-b' }), 1000, 500);
    store.db.prepare(`UPDATE conversations SET tags_json = '["qualificado"]' WHERE id = ?`).run(a.id);
    store.intervene('solar-a', incoming().telefone, 'assumir', 1100, 500);
    store.intervene('solar-a', incoming().telefone, 'religar', 1200, 500);
    turn(store, 't1', b.id);
    store.db.prepare(`INSERT INTO actions
      (tenant_id, conversation_id, turn_id, name, args_json, result_json, status, key, created_at)
      VALUES ('solar-a', ?, 't1', 'transferir_humano', '{}', '{}', 'success', 'transfer', 1000)`).run(b.id);
    expect(store.metrics('solar-a')).toMatchObject({
      total_conversas: 2, leads_qualificados: 1, taxa_qualificacao_pct: 50,
      transferencias_humano: 2, taxa_transferencia_pct: 100,
      custo_estimado_usd: null, custo_medio_conversa_usd: null, denominador_custo_medio: 0,
    });
    expect(store.metrics('solar-b')).toMatchObject({ total_conversas: 1, leads_qualificados: 0, transferencias_humano: 0 });
  });

  it('exclui conversas com custo desconhecido da média e conserva soma parcial conhecida', () => {
    const store = memory();
    const a = store.enqueue(incoming(), 1000, 500).conversation;
    const b = store.enqueue(incoming({ message_id: 'b', telefone: 'outro-lead' }), 1000, 500).conversation;
    turn(store, 'a1', a.id, 'solar-a', 0.04);
    turn(store, 'a2', a.id, 'solar-a', 0.06);
    turn(store, 'b1', b.id, 'solar-a', 0.02);
    turn(store, 'b2', b.id, 'solar-a', null);
    const insert = store.db.prepare(`INSERT INTO llm_calls
      (tenant_id, conversation_id, turn_id, model, tokens_input, tokens_output, cost_usd, latency_ms, status, created_at)
      VALUES ('solar-a', ?, ?, 'modelo', ?, ?, ?, 100, 'success', 1000)`);
    insert.run(a.id, 'a1', 100, 30, 0.04);
    insert.run(a.id, 'a2', 200, 40, 0.06);
    insert.run(b.id, 'b1', 50, 10, 0.02);
    insert.run(b.id, 'b2', null, null, null);
    const result = store.metrics('solar-a');
    expect(result.custo_estimado_usd).toBeCloseTo(0.12);
    expect(result.custo_medio_conversa_usd).toBeCloseTo(0.1);
    expect(result.denominador_custo_medio).toBe(1);
    expect(result.cobertura_custo).toEqual({ chamadas_conhecidas: 3, total_chamadas: 4, turnos_conhecidos: 3, total_turnos: 4, conversas_com_custo_completo: 1 });
    expect(result).toMatchObject({ tokens_entrada: 350, tokens_saida: 80 });
  });
});
