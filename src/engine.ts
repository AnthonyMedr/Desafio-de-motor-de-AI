import { createHash, randomUUID } from 'node:crypto';
import type { Settings } from './config.js';
import type { Conversation, LlmProvider, Message, ModelRequest, ModelRound, ModelStep, Profile, ProfileField, Tenant, ToolCall, ToolResult } from './contracts.js';
import { nextQuestion, normalize, qualify, resolveEvidenceQuote, validateEvidence } from './domain.js';
import { Store } from './store.js';
import { consentForSlot, futureSlots, toolDefinitions, toolSchemas } from './tools.js';

type Job = { conversation: Conversation; batch: Message[]; history: Message[]; id: string; generation: number; handoff: boolean };
class Cancelled extends Error {}
class ToolError extends Error {}
const parseProfile = (c: Conversation): Profile => JSON.parse(c.profile_json) as Profile;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const stableKey = (name: string, args: unknown) => createHash('sha256').update(name + JSON.stringify(canonical(args))).digest('hex');

function requestsHuman(text: string): boolean {
  return normalize(text).split(/[.!?;,\n]/).some(part => {
    if (/\b(?:nao|nunca|talvez|se|caso)\b/.test(part)) return false;
    return /\b(?:quero|preciso|prefiro|gostaria|pode|podem|poderia|posso)\b.{0,40}\b(?:falar|conversar|atendimento|transferir|encaminhar|chamar|acionar)\b.{0,35}\b(?:humano|humana|pessoa|atendente|equipe|consultor)\b/.test(part)
      || /\b(?:quero|gostaria|prefiro|preciso)\b.{0,30}\b(?:equipe|consultor|atendente)\b.{0,40}\b(?:explique|contate|ligue|atenda|ajude|fale)\b/.test(part)
      || /^(?:humano|humana|atendente|consultor)(?: por favor)?$/.test(part.trim());
  });
}

export class Engine {
  private running = new Map<number, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(readonly store: Store, readonly tenants: Map<string, Tenant>, readonly provider: LlmProvider, readonly settings: Settings, readonly now: () => number = Date.now) {}

  start() {
    this.store.recover(this.now());
    this.timer = setInterval(() => { void this.tick().catch(error => console.error(JSON.stringify({ event: 'worker_error', error: String(error) }))); }, this.settings.workerIntervalMs);
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(this.running.values());
  }
  async tick(): Promise<void> {
    if (this.stopping) return;
    const ready = this.store.db.prepare("SELECT * FROM conversations WHERE mode='auto' AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at,id").all(this.now()) as Conversation[];
    const jobs: Promise<void>[] = [];
    for (const conversation of ready) {
      if (this.running.has(conversation.id)) continue;
      const job = this.claim(conversation.id);
      if (!job) continue;
      const promise = this.process(job).finally(() => { this.running.delete(conversation.id); });
      this.running.set(conversation.id, promise);
      jobs.push(promise);
    }
    await Promise.all(jobs);
  }
  private claim(id: number): Job | undefined {
    return this.store.transaction(() => {
      const c = this.store.getById(id);
      if (c.mode !== 'auto' || c.due_at === null || c.due_at > this.now()) return;
      const first = this.store.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND status='pending' ORDER BY id LIMIT 1").get(id) as Message | undefined;
      if (!first) { this.store.db.prepare('UPDATE conversations SET due_at=NULL WHERE id=?').run(id); return; }
      const batch = (first.turn_id
        ? this.store.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND status='pending' AND turn_id=? ORDER BY id").all(id, first.turn_id)
        : this.store.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND status='pending' AND turn_id IS NULL ORDER BY id").all(id)) as Message[];
      const turnId = first.turn_id ?? randomUUID();
      for (const m of batch) this.store.db.prepare("UPDATE messages SET status='processing',turn_id=? WHERE id=?").run(turnId, m.id);
      this.store.db.prepare("INSERT INTO turns(id,tenant_id,conversation_id,state,started_at,model) VALUES(?,?,?,'processing',?,?) ON CONFLICT(id) DO UPDATE SET state='processing',finished_at=NULL,error=NULL").run(turnId, c.tenant_id, id, this.now(), this.provider.name);
      this.store.db.prepare('UPDATE conversations SET due_at=NULL WHERE id=?').run(id);
      const batchIds = new Set(batch.map(m => m.id));
      const history = this.store.messages(id).filter(m => m.author !== 'lead' || m.status === 'done' || batchIds.has(m.id));
      return { conversation: c, batch, history, id: turnId, generation: c.generation, handoff: false };
    });
  }
  private current(job: Job): Conversation {
    const c = this.store.getById(job.conversation.id);
    if (c.generation !== job.generation || (c.mode !== 'auto' && !job.handoff)) throw new Cancelled('Intervenção humana invalidou o turno.');
    return c;
  }
  private async process(job: Job) {
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Tempo máximo do turno excedido.')), this.settings.llmTurnTimeoutMs);
    const rounds: ModelRound[] = [];
    try {
      const tenant = this.tenants.get(job.conversation.tenant_id)!;
      let final: string | undefined;
      for (let round = 0; round < this.settings.llmMaxRounds; round++) {
        const c = this.current(job);
        if (controller.signal.aborted) throw controller.signal.reason;
        const request: ModelRequest = { tenant, conversation: c, profile: parseProfile(c), history: job.history, batch: job.batch, tools: toolDefinitions, rounds, signal: controller.signal, now: this.now() };
        const step = await this.callModel(job, request);
        this.current(job);
        if (step.calls.length > 20) throw new Error('Limite de ferramentas por rodada excedido.');
        if (!step.calls.length) {
          this.ensureOutcome(job, tenant);
          final = this.safeReply(step.text ?? '', job, tenant);
          break;
        }
        const results: ToolResult[] = [];
        for (const call of step.calls) {
          this.current(job);
          if (controller.signal.aborted) throw controller.signal.reason;
          results.push({ id: call.id, name: call.name, result: this.execute(job, tenant, call) });
          if (job.handoff) break;
        }
        rounds.push({ step, results });
        if (job.handoff) { final = 'Vou encaminhar seu atendimento para a equipe. Uma pessoa dará continuidade por aqui.'; break; }
      }
      if (!final) throw new Error('Limite de rodadas de ferramentas excedido.');
      this.store.transaction(() => {
        this.current(job);
        this.store.db.prepare("INSERT OR IGNORE INTO messages(tenant_id,conversation_id,message_id,text,author,timestamp,received_at,status,turn_id) VALUES(?,?,?,?,'ia',?,?,'done',?)").run(job.conversation.tenant_id, job.conversation.id, `ai:${job.id}`, final, new Date(this.now()).toISOString(), this.now(), job.id);
        this.store.db.prepare("UPDATE messages SET status='done' WHERE conversation_id=? AND turn_id=? AND status='processing'").run(job.conversation.id, job.id);
        this.finishTurn(job, 'completed', started);
        this.scheduleRemaining(job, true);
      });
    } catch (error) {
      if (error instanceof Cancelled) {
        this.store.transaction(() => {
          // Devolver apenas este lote à fila. A ação religar deve retomá-lo mesmo se ocorrer durante a chamada ao modelo.
          this.store.db.prepare("UPDATE messages SET status='pending' WHERE conversation_id=? AND turn_id=? AND status='processing'").run(job.conversation.id, job.id);
          this.finishTurn(job, 'cancelled', started, error.message);
          this.scheduleRemaining(job, false);
        });
      } else {
        this.fail(job, error, started);
      }
    } finally { clearTimeout(timeout); }
  }
  private async callModel(job: Job, request: ModelRequest): Promise<ModelStep> {
    for (let attempt = 0; ; attempt++) {
      this.current(job);
      const start = performance.now();
      // Cada chamada tem seu prazo, sem consumir sozinha o orçamento das demais rodadas.
      const callController = new AbortController();
      const callTimeout = setTimeout(() => callController.abort(new Error('Tempo máximo da chamada ao modelo excedido.')), this.settings.llmTimeoutMs);
      const signal = AbortSignal.any([request.signal, callController.signal]);
      try {
        const step = await this.abortable(this.provider.generate({ ...request, signal }), signal);
        const input = step.usage?.input ?? null;
        const output = step.usage?.output ?? null;
        const thinking = step.usage?.thinking ?? null;
        // O adaptador Gemini já inclui os tokens de raciocínio na saída; não somá-los novamente.
        const cost = input === null || output === null ? null : (input * this.settings.inputUsdPerMillion + output * this.settings.outputUsdPerMillion) / 1_000_000;
        this.store.db.prepare("INSERT INTO llm_calls(tenant_id,conversation_id,turn_id,model,tokens_input,tokens_output,thinking_tokens,cost_usd,latency_ms,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'success',?)").run(job.conversation.tenant_id, job.conversation.id, job.id, step.model, input, output, thinking, cost, Math.max(0, Math.round(performance.now() - start)), this.now());
        return step;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.db.prepare("INSERT INTO llm_calls(tenant_id,conversation_id,turn_id,model,latency_ms,status,error,created_at) VALUES(?,?,?,?,?,'failed',?,?)").run(job.conversation.tenant_id, job.conversation.id, job.id, this.provider.name, Math.max(0, Math.round(performance.now() - start)), message.slice(0, 500), this.now());
        if (request.signal.aborted || attempt >= this.settings.llmMaxRetries) throw error;
        const status = (error as { status?: number }).status;
        if (status !== undefined && status !== 429 && status < 500) throw error;
      } finally {
        clearTimeout(callTimeout);
      }
    }
  }
  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private execute(job: Job, tenant: Tenant, call: ToolCall, technicalFallback = false): Record<string, unknown> {
    this.current(job);
    // A autorização técnica vem do servidor e não pode ser simulada pelo texto dos argumentos do LLM.
    const key = (technicalFallback ? 'server-fallback:' : '') + stableKey(call.name, call.args);
    const existing = this.store.db.prepare('SELECT result_json FROM actions WHERE conversation_id=? AND turn_id=? AND key=?').get(job.conversation.id, job.id, key) as { result_json: string } | undefined;
    if (existing) return JSON.parse(existing.result_json);
    try {
      return this.store.transaction(() => {
        this.current(job);
        const schema = toolSchemas[call.name as keyof typeof toolSchemas];
        if (!schema) throw new ToolError('Ferramenta desconhecida.');
        const args = schema.parse(call.args) as Record<string, unknown>;
        const result = this.applyTool(job, tenant, call.name, args, technicalFallback);
        this.audit(job, call, key, result, 'success');
        return result;
      });
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      const result = { ok: false, error: error instanceof Error ? error.message.slice(0, 700) : String(error) };
      this.audit(job, call, key, result, 'failed');
      return result;
    }
  }
  private audit(job: Job, call: ToolCall, key: string, result: Record<string, unknown>, status: string) {
    this.store.db.prepare('INSERT INTO actions(tenant_id,conversation_id,turn_id,name,args_json,result_json,status,key,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(job.conversation.tenant_id, job.conversation.id, job.id, call.name, JSON.stringify(call.args ?? null), JSON.stringify(result), status, key, this.now());
  }
  private applyTool(job: Job, tenant: Tenant, name: string, args: Record<string, unknown>, technicalFallback: boolean): Record<string, unknown> {
    const c = this.current(job);
    const profile = parseProfile(c);
    const decision = qualify(profile, tenant);
    const transferAllowed = technicalFallback || decision.status !== 'desqualificado' || job.batch.some(m => m.author === 'lead' && requestsHuman(m.text));
    const tags: string[] = JSON.parse(c.tags_json);
    const db = this.store.db;
    switch (name) {
      case 'atualizar_ficha': {
        const history = job.history;
        const source = history.find(m => m.message_id === args.source_message_id && m.author === 'lead');
        if (!source || !validateEvidence(args.campo as ProfileField, args.valor, source, tenant, history, String(args.evidencia))) throw new ToolError('Campo sem declaração explícita válida do lead na mensagem de origem.');
        profile[args.campo as ProfileField] = args.valor as string | number | boolean;
        db.prepare('UPDATE conversations SET profile_json=?,updated_at=? WHERE id=?').run(JSON.stringify(profile), this.now(), c.id);
        db.prepare('INSERT INTO profile_changes(tenant_id,conversation_id,turn_id,campo,value_json,source_message_id,evidence,created_at) VALUES(?,?,?,?,?,?,?,?)').run(c.tenant_id, c.id, job.id, args.campo as string, JSON.stringify(args.valor), source.message_id, resolveEvidenceQuote(source.text, String(args.evidencia))!, this.now());
        return { ok: true, ficha: profile, decisao: qualify(profile, tenant) };
      }
      case 'adicionar_tag': {
        const tag = args.tag as string;
        const permitted: Record<string, boolean> = { qualificado: decision.status === 'qualificado', desqualificado: decision.status === 'desqualificado', 'cliente-antigo': profile.cliente_antigo === true, duvida: profile.duvida === true, 'em-qualificacao': decision.status === 'incompleto', 'atendimento-humano': transferAllowed };
        if (!permitted[tag]) throw new ToolError('Tag incompatível com os fatos da ficha.');
        if (!tags.includes(tag)) tags.push(tag);
        const mutuallyExclusive = tag === 'qualificado' ? 'desqualificado' : tag === 'desqualificado' ? 'qualificado' : undefined;
        db.prepare('UPDATE conversations SET tags_json=?,updated_at=? WHERE id=?').run(JSON.stringify(tags.filter(t => t !== mutuallyExclusive && (tag === 'em-qualificacao' || t !== 'em-qualificacao'))), this.now(), c.id);
        return { ok: true, tag };
      }
      case 'mover_estagio': {
        const stage = args.estagio as string;
        if (!tenant.estagios.includes(stage)) throw new ToolError('Estágio não pertence ao tenant.');
        const booked = !!db.prepare('SELECT id FROM appointments WHERE conversation_id=?').get(c.id);
        const allowed: Record<string, boolean> = { Novo: false, Qualificacao: decision.status === 'incompleto' || decision.status === 'qualificado', Qualificado: decision.status === 'qualificado' && tags.includes('qualificado'), Desqualificado: decision.status === 'desqualificado' && tags.includes('desqualificado'), Agendado: decision.status === 'qualificado' && tags.includes('qualificado') && booked, Humano: transferAllowed && tags.some(t => ['cliente-antigo', 'duvida', 'atendimento-humano'].includes(t)) };
        if (!allowed[stage]) throw new ToolError('Pré-condições do estágio não satisfeitas.');
        db.prepare('UPDATE conversations SET stage=?,closed=?,updated_at=? WHERE id=?').run(stage, ['Desqualificado', 'Agendado', 'Humano'].includes(stage) ? 1 : 0, this.now(), c.id);
        return { ok: true, estagio: stage };
      }
      case 'consultar_agenda': {
        if (decision.status !== 'qualificado' || nextQuestion(profile)) throw new ToolError('Complete a qualificação antes de consultar horários.');
        for (const slot of futureSlots(this.now())) db.prepare('INSERT OR IGNORE INTO slots(id,tenant_id,starts_at) VALUES(?,?,?)').run(`${c.tenant_id}:${slot}`, c.tenant_id, slot);
        const slots = db.prepare('SELECT starts_at FROM slots WHERE tenant_id=? AND NOT EXISTS(SELECT 1 FROM appointments WHERE slot_id=slots.id) ORDER BY starts_at').all(c.tenant_id) as { starts_at: string }[];
        return { ok: true, horarios: slots.map(s => s.starts_at).filter(s => Date.parse(s) > this.now()) };
      }
      case 'marcar_agenda': {
        const slot = args.horario as string;
        if (decision.status !== 'qualificado' || nextQuestion(profile)) throw new ToolError('Lead ainda não está apto para agendamento.');
        const consultation = db.prepare("SELECT result_json FROM actions WHERE conversation_id=? AND turn_id=? AND name='consultar_agenda' AND status='success' ORDER BY id DESC LIMIT 1").get(c.id, job.id) as { result_json: string } | undefined;
        if (!consultation || !(JSON.parse(consultation.result_json).horarios as string[]).includes(slot)) throw new ToolError('Horário não foi retornado pela consulta deste turno.');
        if (!job.batch.some(m => consentForSlot(m.text, slot))) throw new ToolError('Horário sem consentimento explícito do lead neste lote.');
        if (Date.parse(slot) <= this.now()) throw new ToolError('Horário no passado.');
        if (db.prepare('SELECT id FROM appointments WHERE conversation_id=?').get(c.id)) throw new ToolError('Conversa já possui agendamento.');
        const row = db.prepare('SELECT id FROM slots WHERE tenant_id=? AND starts_at=? AND NOT EXISTS(SELECT 1 FROM appointments WHERE slot_id=slots.id)').get(c.tenant_id, slot) as { id: string } | undefined;
        if (!row) throw new ToolError('Horário inexistente ou indisponível.');
        db.prepare('INSERT INTO appointments(tenant_id,conversation_id,slot_id,turn_id,created_at) VALUES(?,?,?,?,?)').run(c.tenant_id, c.id, row.id, job.id, this.now());
        return { ok: true, horario: slot };
      }
      case 'notificar_equipe': {
        if (decision.status !== 'qualificado' || !db.prepare('SELECT id FROM appointments WHERE conversation_id=?').get(c.id)) throw new ToolError('Notificação de qualificado exige visita marcada.');
        if (db.prepare('SELECT id FROM notifications WHERE conversation_id=?').get(c.id)) return { ok: true, ja_registrada: true, simulacao: !!c.simulacao };
        const summary = `Lead qualificado: ${JSON.stringify(profile)}. Visita registrada na agenda local.`;
        db.prepare('INSERT OR IGNORE INTO notifications(tenant_id,conversation_id,turn_id,summary,channel,simulated,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(c.tenant_id, c.id, job.id, summary, tenant.telefone_notificacao, c.simulacao, c.simulacao ? 'simulated' : 'pending', this.now());
        return { ok: true, simulacao: !!c.simulacao, status: c.simulacao ? 'simulated' : 'pending', resumo: summary };
      }
      case 'transferir_humano': {
        if (!transferAllowed) throw new ToolError('Lead desqualificado permanece em Desqualificado. A oferta de assinatura não comprova interesse nem pedido de atendimento humano; é necessário pedido explícito do lead.');
        // As ações de encerramento usam uma única transação SQLite: tag, estágio e suspensão.
        const tag = profile.cliente_antigo ? 'cliente-antigo' : profile.duvida ? 'duvida' : 'atendimento-humano';
        this.execute(job, tenant, { id: 'server-tag', name: 'adicionar_tag', args: { tag } }, technicalFallback);
        this.execute(job, tenant, { id: 'server-stage', name: 'mover_estagio', args: { estagio: 'Humano' } }, technicalFallback);
        db.prepare("UPDATE conversations SET mode='humano',generation=generation+1,closed=1,updated_at=? WHERE id=?").run(this.now(), c.id);
        job.generation++;
        job.handoff = true;
        // Persistir a confirmação junto com a suspensão para evitar uma transferência sem resposta em caso de falha.
        db.prepare("INSERT OR IGNORE INTO messages(tenant_id,conversation_id,message_id,text,author,timestamp,received_at,status,turn_id) VALUES(?,?,?,?,'ia',?,?,'done',?)").run(c.tenant_id, c.id, `ai:${job.id}`, 'Vou encaminhar seu atendimento para a equipe. Uma pessoa dará continuidade por aqui.', new Date(this.now()).toISOString(), this.now(), job.id);
        db.prepare("UPDATE messages SET status='done' WHERE conversation_id=? AND turn_id=? AND status='processing'").run(c.id, job.id);
        return { ok: true, motivo: args.motivo, modo: 'humano' };
      }
      default: throw new ToolError('Ferramenta desconhecida.');
    }
  }
  private ensureOutcome(job: Job, tenant: Tenant) {
    const c = this.current(job);
    const profile = parseProfile(c);
    const decision = qualify(profile, tenant);
    const run = (name: string, args: Record<string, unknown>) => this.execute(job, tenant, { id: `server-${name}`, name, args });
    if (decision.status === 'humano') { run('transferir_humano', { motivo: decision.reason }); return; }
    if (decision.status === 'desqualificado') { run('adicionar_tag', { tag: 'desqualificado' }); run('mover_estagio', { estagio: 'Desqualificado' }); return; }
    if (decision.status === 'qualificado') {
      run('adicionar_tag', { tag: 'qualificado' });
      let booked = this.store.db.prepare('SELECT id FROM appointments WHERE conversation_id=?').get(c.id);
      if (!booked && !nextQuestion(profile) && job.batch.length === 1) {
        const query = this.store.db.prepare("SELECT result_json FROM actions WHERE conversation_id=? AND turn_id=? AND name='consultar_agenda' AND status='success' ORDER BY id DESC LIMIT 1").get(c.id, job.id) as { result_json: string } | undefined;
        // Consentimento inequívoco não precisa de outra confirmação: concluir apenas a próxima data solicitada.
        const expected = futureSlots(this.now()).find(slot => consentForSlot(job.batch[0].text, slot));
        const available = query ? (JSON.parse(query.result_json).horarios as string[]) : [];
        const matching = available.filter(slot => expected && slot.slice(0, 10) === expected.slice(0, 10) && consentForSlot(job.batch[0].text, slot));
        if (matching.length === 1) {
          run('marcar_agenda', { horario: matching[0] });
          booked = this.store.db.prepare('SELECT id FROM appointments WHERE conversation_id=?').get(c.id);
        }
      }
      run('mover_estagio', { estagio: booked ? 'Agendado' : 'Qualificado' });
      if (booked && !this.store.db.prepare('SELECT id FROM notifications WHERE conversation_id=?').get(c.id)) run('notificar_equipe', { resumo: 'Resumo derivado da ficha validada pelo servidor.' });
      return;
    }
    run('mover_estagio', { estagio: 'Qualificacao' });
  }
  private safeReply(proposed: string, job: Job, tenant: Tenant): string {
    const c = this.current(job);
    const profile = parseProfile(c);
    const decision = qualify(profile, tenant);
    const text = job.batch.map(m => m.text).join(' ');
    if (job.handoff) return 'Vou encaminhar seu atendimento para a equipe. Uma pessoa dará continuidade por aqui.';
    if (/\b(voce|você).*(humano|pessoa|rob[oô]|\bia\b)|[ée] (uma? )?(ia|pessoa|humano)/i.test(text)) return 'Sou um assistente virtual deste atendimento. Posso ajudar com informações e encaminhar você à equipe.';
    if (decision.status === 'desqualificado') return decision.alternative
      ? 'Para a instalação de placas, seu imóvel não atende aos critérios atuais. Existe outra opção possível: energia solar por assinatura, sem instalação. A equipe pode explicar com mais detalhes.'
      : 'Pelos critérios atuais, não conseguimos seguir com a instalação neste momento. A equipe pode esclarecer outras possibilidades para seu caso.';
    const unsafe = /(?:R\$\s*\d|\d\s*%|garant\w*.{0,40}(zer|econom)|conta.{0,25}(vai|ira|irá).{0,10}zer|sou (?:uma? )?(?:pessoa|human)|nao sou (?:uma? )?(?:ia|robo)|não sou (?:uma? )?(?:ia|robô))/i.test(proposed);
    const booking = this.store.db.prepare('SELECT slots.starts_at FROM appointments JOIN slots ON slots.id=appointments.slot_id WHERE appointments.conversation_id=?').get(c.id) as { starts_at: string } | undefined;
    if (booking) return `Sua visita está agendada para ${booking.starts_at}. O aviso à equipe foi registrado. O orçamento e a economia dependem da avaliação técnica.`;
    if (unsafe || /desconto|quanto custa|pre[cç]o|zerar|ignore suas instru/i.test(text)) return `O consultor apresenta o orçamento após a avaliação técnica. A economia depende da visita; não posso garantir descontos ou conta zerada. ${nextQuestion(profile) || 'Podemos verificar horários para uma visita?'}`;
    if (/agendad[oa]|confirmad[oa].{0,30}visita|equipe.{0,20}notificad/i.test(proposed)) return nextQuestion(profile) || 'Podemos escolher um dos horários disponíveis para a visita?';
    if (nextQuestion(profile)) return proposed.trim() || nextQuestion(profile);
    return proposed.trim() || 'Qual dos horários disponíveis você prefere para uma visita técnica?';
  }
  private scheduleRemaining(job: Job, success: boolean) {
    const c = this.store.getById(job.conversation.id);
    const pending = this.store.db.prepare("SELECT MAX(received_at) AS last FROM messages WHERE conversation_id=? AND status='pending'").get(c.id) as { last: number | null };
    const due = pending.last === null ? null : Math.max(this.now(), pending.last + this.settings.burstWindowMs, c.due_at ?? 0);
    this.store.db.prepare('UPDATE conversations SET due_at=?,attempts=?,updated_at=? WHERE id=?').run(c.mode === 'auto' ? due : null, success ? 0 : (c as Conversation & { attempts: number }).attempts, this.now(), c.id);
  }
  private finishTurn(job: Job, state: string, started: number, error?: string) {
    const usage = this.store.db.prepare('SELECT COUNT(*) n,COUNT(tokens_input) inputs,COUNT(tokens_output) outputs,COUNT(cost_usd) costs,SUM(tokens_input) input,SUM(tokens_output) output,SUM(cost_usd) cost FROM llm_calls WHERE turn_id=?').get(job.id) as Record<string, number | null>;
    this.store.db.prepare('UPDATE turns SET state=?,finished_at=?,tokens_input=?,tokens_output=?,cost_usd=?,latency_ms=?,error=?,model=COALESCE((SELECT model FROM llm_calls WHERE turn_id=? ORDER BY id DESC LIMIT 1),model) WHERE id=?').run(state, this.now(), usage.n === usage.inputs ? usage.input : null, usage.n === usage.outputs ? usage.output : null, usage.n === usage.costs ? usage.cost : null, Math.max(0, Math.round(performance.now() - started)), error ?? null, job.id, job.id);
  }
  private fail(job: Job, error: unknown, started: number) {
    this.store.transaction(() => {
      const c = this.store.getById(job.conversation.id) as Conversation & { attempts: number };
      if (c.generation !== job.generation || (c.mode !== 'auto' && !job.handoff)) {
        this.store.db.prepare("UPDATE messages SET status='pending' WHERE conversation_id=? AND turn_id=? AND status='processing'").run(c.id, job.id);
        this.finishTurn(job, 'cancelled', started, 'Intervenção durante falha do modelo.');
        this.scheduleRemaining(job, false);
        return;
      }
      const attempts = c.attempts + 1;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.finishTurn(job, 'failed', started, message);
      this.store.db.prepare('UPDATE conversations SET attempts=? WHERE id=?').run(attempts, c.id);
      if (attempts >= this.settings.maxJobAttempts || job.handoff) {
        if (!job.handoff) this.execute(job, this.tenants.get(c.tenant_id)!, { id: 'server-failure', name: 'transferir_humano', args: { motivo: 'Limite de tentativas do processamento atingido.' } }, true);
        this.current(job);
        this.store.db.prepare("INSERT OR IGNORE INTO messages(tenant_id,conversation_id,message_id,text,author,timestamp,received_at,status,turn_id) VALUES(?,?,?,?,'ia',?,?,'done',?)").run(c.tenant_id, c.id, `ai:${job.id}`, 'Não consegui concluir o atendimento automático. Encaminhei seu caso para a equipe.', new Date(this.now()).toISOString(), this.now(), job.id);
        this.store.db.prepare("UPDATE messages SET status='done' WHERE conversation_id=? AND turn_id=?").run(c.id, job.id);
        this.scheduleRemaining(job, false);
      } else {
        this.store.db.prepare("UPDATE messages SET status='pending' WHERE conversation_id=? AND turn_id=? AND status='processing'").run(c.id, job.id);
        this.store.db.prepare('UPDATE conversations SET due_at=? WHERE id=?').run(this.now() + Math.min(30_000, attempts * 1000), c.id);
      }
    });
  }
}
