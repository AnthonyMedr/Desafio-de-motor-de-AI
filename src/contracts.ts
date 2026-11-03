export type Author = 'lead' | 'humano' | 'ia';
export type ProfileField = 'nome' | 'cidade' | 'propriedade' | 'tipo_imovel' | 'conta_luz' | 'pagamento' | 'cliente_antigo' | 'duvida';
export type Profile = Partial<Record<ProfileField, string | number | boolean>>;
export interface Tenant {
  tenant_id: string;
  nome_empresa: string;
  tom: 'formal' | 'informal';
  pode_dizer_que_e_ia: boolean;
  nome_assistente: string;
  horario_atendimento_ia: '24h';
  telefone_notificacao: string;
  cidades_atendidas: string[];
  estagios: string[];
  regras_gerais: string[];
  qualificacao: { conta_minima_exclusiva: number };
}
export interface Conversation {
  id: number; tenant_id: string; telefone: string; simulacao: number;
  mode: 'auto' | 'humano'; generation: number; stage: string;
  profile_json: string; tags_json: string; due_at: number | null; closed: number;
  created_at: number; updated_at: number;
}
export interface Message {
  id: number; tenant_id: string; conversation_id: number; message_id: string;
  text: string; author: Author; timestamp: string; received_at: number;
  status: 'pending' | 'processing' | 'done'; turn_id: string | null;
}
export interface IncomingMessage {
  message_id: string; tenant_id: string; telefone: string; texto: string;
  timestamp: string; autor: 'lead' | 'humano'; simulacao: boolean;
}
export interface ToolCall { id: string; name: string; args: unknown }
export interface ToolResult { id: string; name: string; result: Record<string, unknown> }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface ModelStep {
  calls: ToolCall[]; text?: string; model: string;
  usage?: { input: number | null; output: number | null; thinking?: number | null };
  /** Preserva dados específicos do provedor, como assinaturas de raciocínio do Gemini, entre rodadas de ferramentas. */
  raw?: unknown;
}
export interface ModelRound { step: ModelStep; results: ToolResult[] }
export interface ModelRequest {
  tenant: Tenant; conversation: Conversation; profile: Profile;
  history: Message[]; batch: Message[]; tools: ToolDefinition[];
  rounds: ModelRound[]; signal: AbortSignal; now: number;
}
export interface LlmProvider { readonly name: string; generate(request: ModelRequest): Promise<ModelStep> }
export type Decision = { status: 'incompleto' | 'qualificado' | 'desqualificado' | 'humano'; reason: string; alternative: boolean };
