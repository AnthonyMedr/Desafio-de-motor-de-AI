import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Tenant } from './contracts.js';

const requiredStages = ['Novo', 'Qualificacao', 'Qualificado', 'Desqualificado', 'Agendado', 'Humano'];
export const tenantSchema = z.object({
  tenant_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  nome_empresa: z.string().trim().min(1), tom: z.enum(['formal', 'informal']),
  pode_dizer_que_e_ia: z.boolean(), nome_assistente: z.string().trim().min(1),
  horario_atendimento_ia: z.literal('24h'),
  telefone_notificacao: z.string().regex(/^[a-z][a-z0-9-]+$/, 'Use um canal fictício, nunca número real.'),
  cidades_atendidas: z.array(z.string().trim().min(1)).min(1),
  estagios: z.array(z.string()).refine(stages => requiredStages.every(stage => stages.includes(stage)), 'Faltam estágios obrigatórios.'),
  regras_gerais: z.array(z.string().trim().min(1)).min(1),
  qualificacao: z.object({ conta_minima_exclusiva: z.number().finite().nonnegative() }).strict(),
}).strict();

export function loadTenants(directory = resolve('tenants')): Map<string, Tenant> {
  const tenants = new Map<string, Tenant>();
  for (const filename of readdirSync(directory).filter(file => file.endsWith('.json')).sort()) {
    let tenant: Tenant;
    try { tenant = tenantSchema.parse(JSON.parse(readFileSync(resolve(directory, filename), 'utf8'))) as Tenant; }
    catch (error) { throw new Error(`Configuração de tenant inválida (${filename}): ${String(error)}`); }
    if (tenants.has(tenant.tenant_id)) throw new Error(`Tenant duplicado: ${tenant.tenant_id}`);
    tenants.set(tenant.tenant_id, tenant);
  }
  if (tenants.size < 2) throw new Error('Configure pelo menos dois tenants distintos.');
  return tenants;
}

export interface Settings {
  port: number; databasePath: string; tenantsDir: string; burstWindowMs: number;
  workerIntervalMs: number; llmProvider: 'mock' | 'gemini'; geminiApiKey?: string;
  geminiModel: string; llmTimeoutMs: number; llmTurnTimeoutMs: number; llmMaxRounds: number; llmMaxRetries: number;
  inputUsdPerMillion: number; outputUsdPerMillion: number; maxJobAttempts: number;
}

const integer = (fallback: number, max = 86_400_000) => z.coerce.number().int().min(1).max(max).default(fallback);
const settingsSchema = z.object({
  PORT: integer(3000, 65535), DATABASE_PATH: z.string().min(1).default('data/atendimento.sqlite'),
  TENANTS_DIR: z.string().min(1).default('tenants'), BURST_WINDOW_MS: integer(8000), WORKER_INTERVAL_MS: integer(250),
  LLM_PROVIDER: z.enum(['mock', 'gemini']).default('mock'), GEMINI_API_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  GEMINI_MODEL: z.string().regex(/^[a-zA-Z0-9._-]+$/).default('gemini-3.5-flash-lite'),
  LLM_TIMEOUT_MS: integer(30_000), LLM_TURN_TIMEOUT_MS: integer(120_000), LLM_MAX_ROUNDS: integer(8, 16),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1), MAX_JOB_ATTEMPTS: integer(3, 10),
  INPUT_USD_PER_MILLION: z.coerce.number().finite().nonnegative().default(0.30),
  OUTPUT_USD_PER_MILLION: z.coerce.number().finite().nonnegative().default(2.50),
});
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const parsed = settingsSchema.parse(env);
  if (parsed.LLM_PROVIDER === 'gemini' && !parsed.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY é obrigatória quando LLM_PROVIDER=gemini.');
  return {
    port: parsed.PORT, databasePath: parsed.DATABASE_PATH, tenantsDir: parsed.TENANTS_DIR,
    burstWindowMs: parsed.BURST_WINDOW_MS, workerIntervalMs: parsed.WORKER_INTERVAL_MS,
    llmProvider: parsed.LLM_PROVIDER, geminiApiKey: parsed.GEMINI_API_KEY, geminiModel: parsed.GEMINI_MODEL,
    llmTimeoutMs: parsed.LLM_TIMEOUT_MS, llmTurnTimeoutMs: parsed.LLM_TURN_TIMEOUT_MS,
    llmMaxRounds: parsed.LLM_MAX_ROUNDS, llmMaxRetries: parsed.LLM_MAX_RETRIES,
    inputUsdPerMillion: parsed.INPUT_USD_PER_MILLION, outputUsdPerMillion: parsed.OUTPUT_USD_PER_MILLION,
    maxJobAttempts: parsed.MAX_JOB_ATTEMPTS,
  };
}
