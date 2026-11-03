CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  telefone TEXT NOT NULL,
  simulacao INTEGER NOT NULL CHECK (simulacao IN (0, 1)),
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'humano')),
  generation INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'Novo',
  profile_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(profile_json)),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  due_at INTEGER,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, telefone),
  UNIQUE (id, tenant_id)
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'cancelled', 'failed', 'interrupted')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  model TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  error TEXT,
  UNIQUE (id, tenant_id, conversation_id),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('lead', 'humano', 'ia')),
  timestamp TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'done')),
  turn_id TEXT,
  UNIQUE (tenant_id, message_id),
  UNIQUE (tenant_id, conversation_id, message_id),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id),
  FOREIGN KEY (turn_id, tenant_id, conversation_id) REFERENCES turns (id, tenant_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE actions (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  name TEXT NOT NULL,
  args_json TEXT NOT NULL CHECK (json_valid(args_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, turn_id, key),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id),
  FOREIGN KEY (turn_id, tenant_id, conversation_id) REFERENCES turns (id, tenant_id, conversation_id)
);

CREATE TABLE profile_changes (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  campo TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  source_message_id TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id),
  FOREIGN KEY (turn_id, tenant_id, conversation_id) REFERENCES turns (id, tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, conversation_id, source_message_id) REFERENCES messages (tenant_id, conversation_id, message_id)
);

CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  UNIQUE (tenant_id, starts_at),
  UNIQUE (id, tenant_id)
);

CREATE TABLE appointments (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  slot_id TEXT NOT NULL UNIQUE,
  turn_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id),
  FOREIGN KEY (turn_id, tenant_id, conversation_id) REFERENCES turns (id, tenant_id, conversation_id),
  FOREIGN KEY (slot_id, tenant_id) REFERENCES slots (id, tenant_id)
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  channel TEXT NOT NULL,
  simulated INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, turn_id),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id),
  FOREIGN KEY (turn_id, tenant_id, conversation_id) REFERENCES turns (id, tenant_id, conversation_id)
);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  thinking_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id),
  FOREIGN KEY (turn_id, tenant_id, conversation_id) REFERENCES turns (id, tenant_id, conversation_id)
);

CREATE TABLE interventions (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  acao TEXT NOT NULL CHECK (acao IN ('assumir', 'religar')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id)
);

CREATE INDEX conversations_due ON conversations (mode, closed, due_at);
CREATE INDEX messages_pending ON messages (conversation_id, status, id);
CREATE INDEX turns_conversation ON turns (conversation_id, started_at);
CREATE INDEX actions_tenant ON actions (tenant_id, conversation_id, name, status);
CREATE INDEX llm_calls_tenant ON llm_calls (tenant_id, created_at);
