import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv, loadTenants } from '../src/config.js';
import type { IncomingMessage, LlmProvider, ModelStep, Profile } from '../src/contracts.js';
import { Engine } from '../src/engine.js';
import { MockProvider } from '../src/llm/mock.js';
import { Store } from '../src/store.js';
import { futureSlots } from '../src/tools.js';

const stores: Store[] = [];
const engines: Engine[] = [];
const paths: string[] = [];
const baseline = Date.parse('2026-11-01T12:00:00.000Z');
const tenant = 'aurora-solar';
const telefone = 'lead-recovery-ficticio';
const message = (texto: string): IncomingMessage => ({
  tenant_id: tenant, telefone, texto, message_id: 'original', autor: 'lead', simulacao: true,
  timestamp: new Date(baseline).toISOString(),
});
const key = (name: string, args: unknown) => createHash('sha256').update(name + JSON.stringify(args)).digest('hex');

function audit(store: Store, conversation: number, name: string, args: object, result: object): void {
  store.db.prepare(`INSERT INTO actions
    (tenant_id,conversation_id,turn_id,name,args_json,result_json,status,key,created_at)
    VALUES (?,?,'interrupted-turn',?,?,?,'success',?,?)`)
    .run(tenant, conversation, name, JSON.stringify(args), JSON.stringify(result), key(name, args), baseline);
}
function interrupted(store: Store, input: IncomingMessage, profile: Profile, tags: string[], stage: string) {
  const created = store.enqueue(input, baseline, 10).conversation;
  store.db.prepare(`INSERT INTO turns(id,tenant_id,conversation_id,state,started_at,model)
    VALUES('interrupted-turn',?,?,'processing',?,'mock')`).run(tenant, created.id, baseline);
  store.db.prepare(`UPDATE messages SET status='processing',turn_id='interrupted-turn' WHERE conversation_id=?`).run(created.id);
  store.db.prepare(`UPDATE conversations SET profile_json=?,tags_json=?,stage=?,closed=1,due_at=NULL WHERE id=?`)
    .run(JSON.stringify(profile), JSON.stringify(tags), stage, created.id);
  return created;
}
function engine(store: Store, now: () => number, provider: LlmProvider = new MockProvider()): Engine {
  const instance = new Engine(store, loadTenants(), provider, { ...loadEnv({}), burstWindowMs: 10, llmMaxRetries: 0 }, now);
  engines.push(instance);
  return instance;
}

afterEach(async () => {
  for (const instance of engines.splice(0)) await instance.stop();
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  }
});

describe('recuperação de trabalho persistido', () => {
  it('persiste confirmação de transferência e suspensão juntas, mesmo se falhar ao finalizar o turno', async () => {
    const store = new Store();
    stores.push(store);
    const input = message('Preciso falar com a equipe.');
    const conversation = store.enqueue(input, baseline, 10).conversation;
    const provider: LlmProvider = {
      name: 'scripted-handoff',
      async generate() {
        return { model: 'scripted-handoff', calls: [{ id: 'handoff', name: 'transferir_humano', args: { motivo: 'Solicitação de atendimento humano.' } }] };
      },
    };
    // Simular uma falha após confirmar a transação da ferramenta e antes de o worker concluir o processamento.
    store.db.exec(`CREATE TRIGGER fail_turn_finalization BEFORE UPDATE OF state ON turns
      WHEN NEW.state IN ('completed','failed') BEGIN
      SELECT RAISE(ABORT,'falha simulada na finalizacao'); END`);
    const worker = engine(store, () => baseline + 10, provider);
    await expect(worker.tick()).rejects.toThrow('falha simulada na finalizacao');
    let snapshot = store.snapshot(tenant, telefone)!;
    expect(snapshot.conversa.mode).toBe('humano');
    expect(snapshot.mensagens.every(item => item.status === 'done')).toBe(true);
    expect(snapshot.mensagens.filter(item => item.author === 'ia')).toHaveLength(1);
    expect(snapshot.acoes).toContainEqual(expect.objectContaining({ name: 'transferir_humano', status: 'success' }));
    store.db.exec('DROP TRIGGER fail_turn_finalization');
    store.recover(baseline + 1000);
    await worker.tick();
    snapshot = store.snapshot(tenant, telefone)!;
    expect(snapshot.mensagens.filter(item => item.author === 'ia')).toHaveLength(1);
    expect(snapshot.turnos).toEqual([expect.objectContaining({ state: 'interrupted' })]);
  });

  it('termina resposta após reinício entre estágio terminal e publicação, sem repetir ações já auditadas', async () => {
    const path = join(tmpdir(), `motor-recovery-${randomUUID()}.sqlite`);
    paths.push(path);
    const before = new Store(path);
    const input = message('Minha conta de luz é R$ 200.');
    const conversation = interrupted(before, input, { conta_luz: 200 }, ['desqualificado'], 'Desqualificado');
    audit(before, conversation.id, 'adicionar_tag', { tag: 'desqualificado' }, { ok: true, tag: 'desqualificado' });
    audit(before, conversation.id, 'mover_estagio', { estagio: 'Desqualificado' }, { ok: true, estagio: 'Desqualificado' });
    before.close();

    const after = new Store(path);
    stores.push(after);
    const now = baseline + 1000;
    after.recover(now);
    expect(after.getById(conversation.id).due_at).toBe(now);
    expect(after.messages(conversation.id)[0]).toMatchObject({ status: 'pending', turn_id: 'interrupted-turn' });
    await engine(after, () => now).tick();
    const snapshot = after.snapshot(tenant, telefone)!;
    expect(snapshot.mensagens.filter(item => item.author === 'ia')).toHaveLength(1);
    expect(snapshot.mensagens.every(item => item.status === 'done')).toBe(true);
    expect(snapshot.acoes).toHaveLength(2);
    expect(snapshot.turnos).toEqual([expect.objectContaining({ id: 'interrupted-turn', state: 'completed' })]);
    expect(after.enqueue(input, now + 1000, 10).duplicate).toBe(true);
    await engines.at(-1)!.tick();
    expect(after.messages(conversation.id).filter(item => item.author === 'ia')).toHaveLength(1);
  });

  it('preserva reserva e registra uma única notificação ao retomar turno interrompido', async () => {
    const store = new Store();
    stores.push(store);
    const slot = futureSlots(baseline)[0]!;
    const profile: Profile = { nome: 'Ana', cidade: 'Recife', propriedade: 'proprio', tipo_imovel: 'casa', conta_luz: 400, pagamento: 'a_vista' };
    const conversation = interrupted(store, message(`Confirmo a visita em ${slot}.`), profile, ['qualificado'], 'Agendado');
    store.db.prepare('INSERT INTO slots(id,tenant_id,starts_at) VALUES(?,?,?)').run('slot-reservado', tenant, slot);
    store.db.prepare(`INSERT INTO appointments(tenant_id,conversation_id,slot_id,turn_id,created_at)
      VALUES(?,?,'slot-reservado','interrupted-turn',?)`).run(tenant, conversation.id, baseline);
    audit(store, conversation.id, 'adicionar_tag', { tag: 'qualificado' }, { ok: true, tag: 'qualificado' });
    audit(store, conversation.id, 'mover_estagio', { estagio: 'Agendado' }, { ok: true, estagio: 'Agendado' });
    audit(store, conversation.id, 'marcar_agenda', { horario: slot }, { ok: true, horario: slot });
    store.recover(baseline + 1000);
    const worker = engine(store, () => baseline + 1000);
    await worker.tick();
    await worker.tick();
    const snapshot = store.snapshot(tenant, telefone)!;
    expect(snapshot.agendamentos).toHaveLength(1);
    expect(snapshot.notificacoes).toEqual([expect.objectContaining({ simulated: 1, status: 'simulated' })]);
    expect(snapshot.mensagens.filter(item => item.author === 'ia')).toHaveLength(1);
    expect(snapshot.acoes.filter(item => item.name === 'marcar_agenda')).toHaveLength(1);
    expect(snapshot.acoes.filter(item => item.name === 'notificar_equipe')).toHaveLength(1);
  });

  it('reutiliza auditoria e proveniência do mesmo turno após falha temporária do modelo', async () => {
    const store = new Store();
    stores.push(store);
    let now = baseline;
    const input = message('Minha conta de luz é R$ 200.');
    const conversation = store.enqueue(input, now, 10).conversation;
    let failOnce = true;
    const provider: LlmProvider = {
      name: 'scripted-retry',
      async generate(request): Promise<ModelStep> {
        if (!request.rounds.length) return {
          model: 'scripted-retry', calls: [{ id: 'fact', name: 'atualizar_ficha', args: {
            campo: 'conta_luz', valor: 200, source_message_id: input.message_id, evidencia: input.texto,
          } }],
        };
        if (failOnce) { failOnce = false; throw Object.assign(new Error('indisponível temporariamente'), { status: 503 }); }
        return { model: 'scripted-retry', calls: [], text: 'A equipe pode orientar você.' };
      },
    };
    const worker = engine(store, () => now, provider);
    now += 10;
    await worker.tick();
    const firstTurn = store.messages(conversation.id)[0]!.turn_id;
    expect(store.messages(conversation.id)[0]!.status).toBe('pending');
    expect(store.snapshot(tenant, telefone)!.proveniencia).toHaveLength(1);
    now += 1000;
    await worker.tick();
    const snapshot = store.snapshot(tenant, telefone)!;
    expect(snapshot.proveniencia).toHaveLength(1);
    expect(snapshot.acoes.filter(item => item.name === 'atualizar_ficha')).toHaveLength(1);
    expect(snapshot.mensagens.filter(item => item.author === 'ia')).toHaveLength(1);
    expect(snapshot.mensagens[0]!.turn_id).toBe(firstTurn);
    expect(snapshot.turnos).toEqual([expect.objectContaining({ id: firstTurn, state: 'completed' })]);
    expect(snapshot.chamadas_llm).toHaveLength(4);
    expect(store.metrics(tenant).custo_medio_conversa_usd).toBeNull();
  });
});
