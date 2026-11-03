import { z } from 'zod';
import type { ToolDefinition } from './contracts.js';

const field = z.enum(['nome', 'cidade', 'propriedade', 'tipo_imovel', 'conta_luz', 'pagamento', 'cliente_antigo', 'duvida']);
export const toolSchemas = {
  adicionar_tag: z.object({ tag: z.enum(['qualificado', 'desqualificado', 'cliente-antigo', 'duvida', 'atendimento-humano', 'em-qualificacao']) }).strict(),
  mover_estagio: z.object({ estagio: z.string().min(1).max(60) }).strict(),
  atualizar_ficha: z.object({ campo: field, valor: z.union([z.string().min(1).max(150), z.number().finite().nonnegative(), z.boolean()]), source_message_id: z.string().min(1).max(200), evidencia: z.string().min(2).max(2000) }).strict(),
  notificar_equipe: z.object({ resumo: z.string().min(1).max(2000) }).strict(),
  transferir_humano: z.object({ motivo: z.string().min(1).max(500) }).strict(),
  consultar_agenda: z.object({}).strict(),
  marcar_agenda: z.object({ horario: z.iso.datetime({ offset: true }) }).strict(),
};
const descriptions: Record<keyof typeof toolSchemas, string> = {
  adicionar_tag: 'Marca o lead apenas conforme a decisão de qualificação calculada pelo servidor.',
  mover_estagio: 'Atualiza o funil. Estados finais exigem tag compatível; Agendado exige reserva existente.',
  atualizar_ficha: 'Grava somente declaração explícita do lead. Informe message_id da origem e evidencia literal. Campos: nome, cidade, propriedade (proprio/alugado), tipo_imovel (casa/apartamento), conta_luz (número BRL), pagamento (financiado/a_vista), cliente_antigo (true), duvida (true). Não inferir dados nem preencher campos ausentes.',
  notificar_equipe: 'Registra resumo na outbox após reserva confirmada para lead qualificado. O resumo efetivo é construído da ficha pelo servidor.',
  transferir_humano: 'Executa tag e estágio Humano, suspende a IA e registra motivo. Use em dúvida, cliente antigo ou incapacidade de ajudar. Para um lead desqualificado, exige pedido explícito de atendimento humano; oferecer assinatura não autoriza transferência nem comprova interesse.',
  consultar_agenda: 'Consulta horários futuros disponíveis. Espere o resultado antes de oferecer ou confirmar horários.',
  marcar_agenda: 'Reserva horário exato retornado pela consulta neste turno, com consentimento explícito do lead. Não inventar horários.',
};
export const toolDefinitions: ToolDefinition[] = Object.entries(toolSchemas).map(([name, schema]) => {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return { name, description: descriptions[name as keyof typeof descriptions], parameters: json };
});

/** Agenda simulada local: dias úteis às 09h e 14h em São Paulo, com fuso fixo UTC−03:00. */
export function futureSlots(now: number): string[] {
  const local = new Date(now - 3 * 3600_000);
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const slots: string[] = [];
  for (let day = 1; day <= 14; day++) {
    const date = new Date(base + day * 86400_000);
    if ([0, 6].includes(date.getUTCDay())) continue;
    for (const hour of [9, 14]) slots.push(`${date.toISOString().slice(0, 10)}T${hour.toString().padStart(2, '0')}:00:00-03:00`);
  }
  return slots;
}

export function consentForSlot(text: string, slot: string): boolean {
  const normalized = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  // Exigir data e hora ou dia da semana e período; uma confirmação vaga não autoriza reservar qualquer horário.
  if (normalized.includes('?') || /\b(nao|nunca|talvez|cancele|cancelar)\b/.test(normalized)) return false;
  if (!/\b(pode ser|pode marcar|quero agendar|confirmo|aceito|agende|marque)\b/.test(normalized)) return false;
  const date = new Date(Date.parse(slot) - 3 * 3600_000);
  const weekdays = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  const hour = date.getUTCHours();
  const dayMatch = normalized.includes(weekdays[date.getUTCDay()]) || normalized.includes(slot.slice(0, 10));
  const timeText = normalized.replace(/\d{4}-\d{2}-\d{2}t?/g, ' ');
  const timeMatch = normalized.includes(hour < 12 ? 'manha' : 'tarde') || new RegExp(`(?:\\b0?${hour}(?::00|h)\\b|\\bas\\s+0?${hour}\\b)`).test(timeText);
  return dayMatch && timeMatch;
}
