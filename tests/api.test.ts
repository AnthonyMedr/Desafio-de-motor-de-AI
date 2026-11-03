import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api.js';
import { loadEnv, loadTenants } from '../src/config.js';
import { Store } from '../src/store.js';

describe('contrato HTTP', () => {
  let store: Store;
  const settings = loadEnv({});
  const tenants = loadTenants();
  beforeEach(() => { store = new Store(); });
  afterEach(() => { store.close(); });
  const payload = { message_id: 'test-1', tenant_id: 'sol-nascente', telefone: 'lead-http', texto: 'oi', timestamp: '2026-11-01T12:00:00-03:00' };
  it('health, aceite assíncrono, duplicata e consulta sem resposta imediata', async () => {
    const app = createApp(store, tenants, settings);
    expect((await request(app).get('/health')).body.status).toBe('ok');
    expect((await request(app).post('/webhook/mensagem').send(payload)).body).toMatchObject({ accepted: true, duplicate: false });
    expect((await request(app).post('/webhook/mensagem').send(payload)).body.duplicate).toBe(true);
    const conversation = await request(app).get('/conversas/sol-nascente/lead-http');
    expect(conversation.body.mensagens).toHaveLength(1);
    expect(conversation.body.conversa.simulacao).toBe(1);
    expect((await request(app).get('/metricas/sol-nascente')).body.total_conversas).toBe(1);
  });
  it('valida schema, JSON, autor, namespace reservado e erro uniforme', async () => {
    const app = createApp(store, tenants, settings);
    for (const body of [{ ...payload, texto: '' }, { ...payload, timestamp: 'amanha' }, { ...payload, autor: 'ia' }, { ...payload, message_id: 'ai:reserved' }, { ...payload, extra: true }]) {
      const r = await request(app).post('/webhook/mensagem').send(body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    const malformed = await request(app).post('/webhook/mensagem').set('Content-Type', 'application/json').send('{');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_BODY');
  });
  it('tenant/conversa desconhecido 404; idempotência divergente e simulação mutável 409', async () => {
    const app = createApp(store, tenants, settings);
    expect((await request(app).get('/metricas/desconhecido')).status).toBe(404);
    expect((await request(app).get('/conversas/sol-nascente/ausente')).status).toBe(404);
    await request(app).post('/webhook/mensagem').send(payload);
    expect((await request(app).post('/webhook/mensagem').send({ ...payload, texto: 'mudou' })).status).toBe(409);
    expect((await request(app).post('/webhook/mensagem').send({ ...payload, message_id: 'test-2', simulacao: false })).body.error.code).toBe('SIMULATION_CONFLICT');
  });
  it('intervenção exige conversa e aceita apenas assumir/religar', async () => {
    const app = createApp(store, tenants, settings);
    const base = { tenant_id: payload.tenant_id, telefone: payload.telefone };
    expect((await request(app).post('/intervencao').send({ ...base, acao: 'assumir' })).status).toBe(404);
    await request(app).post('/webhook/mensagem').send(payload);
    expect((await request(app).post('/intervencao').send({ ...base, acao: 'assumir' })).body.modo).toBe('humano');
    expect((await request(app).post('/intervencao').send({ ...base, acao: 'religar' })).body.modo).toBe('auto');
    expect((await request(app).post('/intervencao').send({ ...base, acao: 'desligar' })).status).toBe(400);
  });
});
