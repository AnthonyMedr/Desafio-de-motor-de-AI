import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Conversation, IncomingMessage, Message } from './contracts.js';

interface ActionRow {
  id: number; tenant_id: string; conversation_id: number; turn_id: string; name: string;
  args_json: string; result_json: string; status: 'success' | 'failed'; key: string; created_at: number;
}
interface ProfileChangeRow {
  id: number; tenant_id: string; conversation_id: number; turn_id: string; campo: string;
  value_json: string; source_message_id: string; evidence: string; created_at: number;
}
interface TurnRow {
  id: string; tenant_id: string; conversation_id: number;
  state: 'processing' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  started_at: number; finished_at: number | null; model: string | null; tokens_input: number | null;
  tokens_output: number | null; cost_usd: number | null; latency_ms: number | null; error: string | null;
}
interface NotificationRow {
  id: number; tenant_id: string; conversation_id: number; turn_id: string; summary: string;
  channel: string; simulated: number; status: string; created_at: number;
}
interface LlmCallRow {
  id: number; tenant_id: string; conversation_id: number; turn_id: string; model: string;
  tokens_input: number | null; tokens_output: number | null; thinking_tokens: number | null;
  cost_usd: number | null; latency_ms: number; status: string; error: string | null; created_at: number;
}
interface InterventionRow {
  id: number; tenant_id: string; conversation_id: number; acao: 'assumir' | 'religar'; created_at: number;
}
interface AppointmentRow {
  id: number; tenant_id: string; conversation_id: number; slot_id: string; turn_id: string; created_at: number; starts_at: string;
}

function conflict(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Transações síncronas mantêm cada alteração atômica na instância única do serviço. */
export class Store {
  readonly db: Database.Database;

  constructor(path = ':memory:', migrationsDir = resolve(process.cwd(), 'migrations')) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path);
    try {
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      const applied = this.db.prepare('SELECT name FROM schema_migrations WHERE name = ?');
      const record = this.db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
      for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()) {
        if (applied.get(name)) continue;
        this.transaction(() => {
          this.db.exec(readFileSync(join(migrationsDir, name), 'utf8'));
          record.run(name, Date.now());
        });
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getConversation(tenant: string, telefone: string): Conversation | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE tenant_id = ? AND telefone = ?')
      .get(tenant, telefone) as Conversation | undefined;
  }

  getById(id: number): Conversation {
    const conversation = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined;
    if (!conversation) throw conflict('NOT_FOUND', 'Conversa não encontrada.');
    return conversation;
  }

  messages(id: number): Message[] {
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(id) as Message[];
  }

  enqueue(input: IncomingMessage, now: number, burstMs: number): {
    duplicate: boolean; conversation: Conversation; message_id: string;
  } {
    if (input.message_id.startsWith('ai:')) {
      throw conflict('RESERVED_MESSAGE_ID', 'O prefixo ai: é reservado para respostas do atendimento.');
    }
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT m.*, c.telefone, c.simulacao
        FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
        WHERE m.tenant_id = ? AND m.message_id = ?`).get(input.tenant_id, input.message_id) as
        (Message & { telefone: string; simulacao: number }) | undefined;
      if (existing) {
        if (existing.text !== input.texto || existing.author !== input.autor || existing.timestamp !== input.timestamp
          || existing.telefone !== input.telefone || existing.simulacao !== Number(input.simulacao)) {
          throw conflict('IDEMPOTENCY_CONFLICT', 'message_id já recebido com conteúdo diferente neste tenant.');
        }
        return { duplicate: true, conversation: this.getById(existing.conversation_id), message_id: input.message_id };
      }

      let conversation = this.getConversation(input.tenant_id, input.telefone);
      if (conversation && conversation.simulacao !== Number(input.simulacao)) {
        throw conflict('SIMULATION_CONFLICT', 'simulacao é imutável durante a conversa.');
      }
      if (!conversation) {
        const result = this.db.prepare(`INSERT INTO conversations
          (tenant_id, telefone, simulacao, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
          .run(input.tenant_id, input.telefone, Number(input.simulacao), now, now);
        conversation = this.getById(Number(result.lastInsertRowid));
      }
      this.db.prepare(`INSERT INTO messages
        (tenant_id, conversation_id, message_id, text, author, timestamp, received_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.tenant_id, conversation.id, input.message_id, input.texto, input.autor, input.timestamp,
          now, input.autor === 'lead' ? 'pending' : 'done');
      if (input.autor === 'lead') {
        this.db.prepare(`UPDATE conversations SET due_at = ?, closed = 0, updated_at = ? WHERE id = ?`)
          .run(conversation.mode === 'auto' ? now + burstMs : null, now, conversation.id);
      } else {
        this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversation.id);
      }
      return { duplicate: false, conversation: this.getById(conversation.id), message_id: input.message_id };
    });
  }

  intervene(tenant: string, telefone: string, acao: 'assumir' | 'religar', now: number, burstMs: number): Conversation | undefined {
    return this.transaction(() => {
      const conversation = this.getConversation(tenant, telefone);
      if (!conversation) return undefined;
      const pending = this.db.prepare(`SELECT 1 FROM messages
        WHERE conversation_id = ? AND status IN ('pending', 'processing') LIMIT 1`).get(conversation.id);
      this.db.prepare(`UPDATE conversations SET mode = ?, generation = generation + 1,
        due_at = ?, closed = CASE WHEN ? = 'religar' THEN 0 ELSE closed END, updated_at = ? WHERE id = ?`)
        .run(acao === 'assumir' ? 'humano' : 'auto', acao === 'religar' && pending ? now + burstMs : null,
          acao, now, conversation.id);
      this.db.prepare('INSERT INTO interventions (tenant_id, conversation_id, acao, created_at) VALUES (?, ?, ?, ?)')
        .run(tenant, conversation.id, acao, now);
      return this.getById(conversation.id);
    });
  }

  /** Um processo interrompido pode deixar um lote em processamento; suas mensagens são devolvidas à fila. */
  recover(now: number): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE messages SET status = 'pending' WHERE status = 'processing'`).run();
      this.db.prepare(`UPDATE turns SET state = 'interrupted', finished_at = ?, error = 'Processo reiniciado'
        WHERE state = 'processing'`).run(now);
      this.db.prepare(`UPDATE conversations SET due_at = CASE WHEN mode = 'auto'
        AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id AND status = 'pending')
        THEN COALESCE(due_at, ?) ELSE NULL END`).run(now);
    });
  }

  snapshot(tenant: string, telefone: string) {
    const conversation = this.getConversation(tenant, telefone);
    if (!conversation) return undefined;
    const rows = <T>(table: string) => this.db.prepare(`SELECT * FROM ${table}
      WHERE tenant_id = ? AND conversation_id = ? ORDER BY id`).all(tenant, conversation.id) as T[];
    const actions = rows<ActionRow>('actions');
    const provenance = rows<ProfileChangeRow>('profile_changes');
    return {
      conversa: conversation,
      ficha: JSON.parse(conversation.profile_json) as Record<string, unknown>,
      tags: JSON.parse(conversation.tags_json) as string[],
      mensagens: this.messages(conversation.id),
      acoes: actions.map(({ args_json, result_json, ...row }) => ({ ...row, argumentos: JSON.parse(args_json), resultado: JSON.parse(result_json) })),
      notificacoes: rows<NotificationRow>('notifications'),
      turnos: rows<TurnRow>('turns'),
      agendamentos: this.db.prepare(`SELECT a.*, s.starts_at FROM appointments a JOIN slots s
        ON s.id = a.slot_id AND s.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? AND a.conversation_id = ? ORDER BY a.id`).all(tenant, conversation.id) as AppointmentRow[],
      proveniencia: provenance.map(({ value_json, ...row }) => ({ ...row, valor: JSON.parse(value_json) })),
      chamadas_llm: rows<LlmCallRow>('llm_calls'),
      intervencoes: rows<InterventionRow>('interventions'),
    };
  }

  metrics(tenant: string) {
    const counts = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(EXISTS (SELECT 1 FROM json_each(c.tags_json) WHERE value = 'qualificado')), 0) AS qualified,
      COALESCE(SUM(EXISTS (SELECT 1 FROM actions a WHERE a.conversation_id = c.id
        AND a.tenant_id = c.tenant_id AND a.name = 'transferir_humano' AND a.status = 'success')
        OR EXISTS (SELECT 1 FROM interventions i WHERE i.conversation_id = c.id
        AND i.tenant_id = c.tenant_id AND i.acao = 'assumir')), 0) AS transferred
      FROM conversations c WHERE c.tenant_id = ?`).get(tenant) as { total: number; qualified: number; transferred: number };
    const usage = this.db.prepare(`SELECT COUNT(*) AS calls, SUM(tokens_input) AS input,
      SUM(tokens_output) AS output, SUM(thinking_tokens) AS thinking, SUM(cost_usd) AS cost,
      AVG(latency_ms) AS latency FROM llm_calls WHERE tenant_id = ?`).get(tenant) as {
      calls: number; input: number | null; output: number | null; thinking: number | null; cost: number | null; latency: number | null;
    };
    const turns = this.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(state = 'completed'), 0) AS completed,
      COALESCE(SUM(state = 'failed'), 0) AS failed, AVG(latency_ms) AS latency
      FROM turns WHERE tenant_id = ?`).get(tenant) as { total: number; completed: number; failed: number; latency: number | null };
    const known = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM llm_calls WHERE tenant_id = ? AND cost_usd IS NOT NULL) AS calls,
      (SELECT COUNT(*) FROM turns WHERE tenant_id = ? AND cost_usd IS NOT NULL) AS turns`).get(tenant, tenant) as { calls: number; turns: number };
    const fullCosts = this.db.prepare(`SELECT COUNT(*) AS conversations, AVG(cost) AS average FROM (
      SELECT conversation_id, SUM(cost_usd) AS cost FROM turns WHERE tenant_id = ?
      GROUP BY conversation_id HAVING COUNT(*) > 0 AND SUM(cost_usd IS NULL) = 0
    )`).get(tenant) as { conversations: number; average: number | null };
    const actions = this.db.prepare(`SELECT name AS acao, status, COUNT(*) AS total FROM actions
      WHERE tenant_id = ? GROUP BY name, status ORDER BY name, status`).all(tenant);
    return {
      tenant_id: tenant,
      total_conversas: counts.total,
      leads_qualificados: counts.qualified,
      taxa_qualificacao_pct: counts.total ? counts.qualified / counts.total * 100 : 0,
      transferencias_humano: counts.transferred,
      taxa_transferencia_pct: counts.total ? counts.transferred / counts.total * 100 : 0,
      denominador_taxas: 'Todas as conversas persistidas do tenant; cada conversa é contada uma vez.',
      criterio_qualificacao: 'Tag qualificado presente atualmente.',
      criterio_transferencia: 'Alguma transferência executada com sucesso ou intervenção assumir no histórico.',
      total_turnos: turns.total,
      turnos_concluidos: turns.completed,
      turnos_falhos: turns.failed,
      latencia_media_turno_ms: turns.latency,
      total_chamadas_llm: usage.calls,
      tokens_entrada: usage.input,
      tokens_saida: usage.output,
      tokens_pensamento: usage.thinking,
      custo_estimado_usd: usage.cost,
      custo_medio_conversa_usd: fullCosts.average,
      denominador_custo_medio: fullCosts.conversations,
      cobertura_custo: {
        chamadas_conhecidas: known.calls,
        total_chamadas: usage.calls,
        turnos_conhecidos: known.turns,
        total_turnos: turns.total,
        conversas_com_custo_completo: fullCosts.conversations,
      },
      criterio_custo: 'Soma apenas de custos conhecidos; média por conversa com todos os turnos de custo conhecido. null indica ausência de dados.',
      latencia_media_llm_ms: usage.latency,
      acoes: actions,
    };
  }

  close(): void {
    this.db.close();
  }
}
