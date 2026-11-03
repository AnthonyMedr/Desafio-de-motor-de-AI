import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import type { Settings } from './config.js';
import type { Tenant } from './contracts.js';
import { Store } from './store.js';

const tenantId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
const phone = z.string().regex(/^[a-zA-Z0-9+_-]{3,64}$/);
const webhook = z.object({
  message_id: z.string().trim().min(1).max(200).refine(id => !id.startsWith('ai:'), 'Prefixo reservado.'),
  tenant_id: tenantId, telefone: phone, texto: z.string().trim().min(1).max(4000),
  timestamp: z.iso.datetime({ offset: true }), autor: z.enum(['lead', 'humano']).default('lead'),
  simulacao: z.boolean().default(true),
}).strict();
const intervention = z.object({ tenant_id: tenantId, telefone: phone, acao: z.enum(['assumir', 'religar']) }).strict();
const pathSchema = z.object({ tenant_id: tenantId, telefone: phone.optional() });

export function createApp(store: Store, tenants: Map<string, Tenant>, settings: Settings, now: () => number = Date.now) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  function knownTenant(id: string) {
    if (!tenants.has(id)) throw Object.assign(new Error('Tenant não encontrado.'), { code: 'TENANT_NOT_FOUND', status: 404 });
  }
  app.get('/health', (_req, res) => {
    store.db.prepare('SELECT 1').get();
    res.json({ status: 'ok', provider: settings.llmProvider });
  });
  app.post('/webhook/mensagem', (req, res) => {
    const payload = webhook.parse(req.body);
    knownTenant(payload.tenant_id);
    const result = store.enqueue(payload, now(), settings.burstWindowMs);
    res.status(202).json({ accepted: true, duplicate: result.duplicate, message_id: result.message_id });
  });
  app.get('/conversas/:tenant_id/:telefone', (req, res) => {
    const params = pathSchema.parse(req.params);
    knownTenant(params.tenant_id);
    const conversation = store.snapshot(params.tenant_id, params.telefone!);
    if (!conversation) throw Object.assign(new Error('Conversa não encontrada.'), { code: 'CONVERSATION_NOT_FOUND', status: 404 });
    res.json(conversation);
  });
  app.post('/intervencao', (req, res) => {
    const payload = intervention.parse(req.body);
    knownTenant(payload.tenant_id);
    const conversation = store.intervene(payload.tenant_id, payload.telefone, payload.acao, now(), settings.burstWindowMs);
    if (!conversation) throw Object.assign(new Error('Conversa não encontrada.'), { code: 'CONVERSATION_NOT_FOUND', status: 404 });
    res.json({ tenant_id: conversation.tenant_id, telefone: conversation.telefone, modo: conversation.mode, geracao: conversation.generation });
  });
  app.get('/metricas/:tenant_id', (req, res) => {
    const params = pathSchema.parse(req.params);
    knownTenant(params.tenant_id);
    res.json(store.metrics(params.tenant_id));
  });
  app.use((_req, res) => { res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada.' } }); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Entrada inválida.', details: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } }); return; }
    const code = (error as { code?: string }).code;
    if (code === 'IDEMPOTENCY_CONFLICT' || code === 'SIMULATION_CONFLICT') { res.status(409).json({ error: { code, message: error.message } }); return; }
    const status = Number(error.status) || 500;
    if (status === 400 || status === 413 || status === 415) { res.status(status).json({ error: { code: 'INVALID_BODY', message: 'Corpo JSON inválido ou excedeu o limite permitido.' } }); return; }
    if (status === 404) { res.status(404).json({ error: { code, message: error.message } }); return; }
    console.error(JSON.stringify({ event: 'request_error', message: error.message }));
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Falha interna no serviço.' } });
  };
  app.use(errors);
  return app;
}
