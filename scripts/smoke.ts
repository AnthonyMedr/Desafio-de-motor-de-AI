import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Verificação de ponta a ponta do serviço compilado, módulo nativo SQLite, HTTP e reinício.
const dataRoot = resolve('data');
mkdirSync(dataRoot, { recursive: true });
const folder = mkdtempSync(resolve(dataRoot, 'smoke-'));
let child: ChildProcess | undefined;
let logs = '';
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>(resolveClose => listener.close(() => resolveClose()));
const base = `http://127.0.0.1:${port}`;
async function waitFor<T>(fn: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error(`Timeout: ${label}. ${logs.slice(-1000)}`);
}
async function start() {
  child = spawn(process.execPath, ['dist/server.js'], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, PORT: String(port), DATABASE_PATH: resolve(folder, 'smoke.sqlite'), LLM_PROVIDER: 'mock', BURST_WINDOW_MS: '150', WORKER_INTERVAL_MS: '10' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', data => { logs += String(data); });
  child.stderr?.on('data', data => { logs += String(data); });
  await waitFor(async () => {
    try { const response = await fetch(`${base}/health`); return response.ok ? true : undefined; } catch { return undefined; }
  }, 'health');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  await closed;
  child = undefined;
}
const payload = { message_id: 'smoke-1', tenant_id: 'sol-nascente', telefone: 'lead-smoke', texto: 'Sou Carlos Lima de Olinda, casa própria, conta de uns 600', timestamp: '2026-11-01T12:00:00-03:00', simulacao: true };
async function post() {
  const r = await fetch(`${base}/webhook/mensagem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(r.status, 202);
  return await r.json() as { duplicate: boolean };
}
async function snapshot() { return await (await fetch(`${base}/conversas/sol-nascente/lead-smoke`)).json() as { ficha: { nome?: string }; mensagens: Array<{ author: string }> }; }
try {
  await start();
  assert.equal((await post()).duplicate, false);
  assert.equal((await post()).duplicate, true);
  const before = await waitFor(async () => {
    const result = await snapshot();
    return result.mensagens.filter(m => m.author === 'ia').length ? result : undefined;
  }, 'resposta persistida');
  assert.equal(before.ficha.nome, 'Carlos Lima');
  assert.equal(before.mensagens.filter(m => m.author === 'ia').length, 1);
  await stop();
  await start();
  assert.equal((await post()).duplicate, true);
  await delay(250);
  const after = await snapshot();
  assert.deepEqual(after.ficha, before.ficha);
  assert.equal(after.mensagens.filter(m => m.author === 'ia').length, 1);
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/smoke.json', JSON.stringify({ generated_at: new Date().toISOString(), status: 'passed', provider: 'mock', external_network: false, checks: ['entrypoint compilado inicia', 'health HTTP', 'webhook HTTP202', 'binding nativo SQLite', 'ficha e resposta persistidas', 'idempotência antes e depois do reinício', 'histórico após reinício'] }, null, 2) + '\n');
  console.log('Smoke passou: serviço compilado, HTTP, SQLite e reinício com idempotência.');
} finally {
  await stop();
  // Remover apenas o diretório temporário criado por este script dentro da pasta de dados do projeto.
  if (!folder.startsWith(dataRoot + sep) || !folder.slice(dataRoot.length + 1).startsWith('smoke-')) throw new Error('Diretório temporário fora do escopo.');
  rmSync(folder, { recursive: true, force: true });
}
