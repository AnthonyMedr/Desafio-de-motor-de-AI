import { createApp } from './api.js';
import { loadEnv, loadTenants } from './config.js';
import { Engine } from './engine.js';
import { GeminiProvider } from './llm/gemini.js';
import { MockProvider } from './llm/mock.js';
import { Store } from './store.js';

const settings = loadEnv();
const tenants = loadTenants(settings.tenantsDir);
const store = new Store(settings.databasePath);
const provider = settings.llmProvider === 'gemini'
  ? new GeminiProvider({ apiKey: settings.geminiApiKey!, model: settings.geminiModel })
  : new MockProvider();
const engine = new Engine(store, tenants, provider, settings);
const app = createApp(store, tenants, settings);
const server = app.listen(settings.port, () => {
  engine.start();
  console.log(JSON.stringify({ event: 'started', port: settings.port, provider: provider.name, tenants: [...tenants.keys()] }));
});
server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await engine.stop();
  store.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
