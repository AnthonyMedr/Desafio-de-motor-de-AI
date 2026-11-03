import type { LlmProvider, ModelRequest, ModelStep, ToolCall } from '../contracts.js';
import { extractFacts, nextQuestion, normalize, qualify } from '../domain.js';

/** Simulador determinístico sem rede. Reconhece as frases documentadas em português e não utiliza um modelo de linguagem. */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';

  async generate(request: ModelRequest): Promise<ModelStep> {
    request.signal.throwIfAborted();
    const { profile, tenant, rounds, conversation } = request;
    const attempted = (name: string, predicate: (args: Record<string, unknown>) => boolean = () => true) => rounds.some(round => round.step.calls.some(call => call.name === name && predicate(call.args as Record<string, unknown>)));
    const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `mock-${rounds.length}-${name}-${JSON.stringify(args)}`, name, args });
    const step = (calls: ToolCall[] = [], text?: string): ModelStep => ({ model: 'mock-deterministic-v1', calls, ...(text ? { text } : {}) });

    const updates: ToolCall[] = [];
    for (const message of request.batch) {
      if (message.author !== 'lead') continue;
      const facts = extractFacts(message.text, tenant, request.history.filter(item => item.id < message.id));
      for (const [campo, valor] of Object.entries(facts)) {
        if (profile[campo as keyof typeof profile] !== valor && !attempted('atualizar_ficha', args => args.campo === campo && args.source_message_id === message.message_id)) {
          updates.push(call('atualizar_ficha', { campo, valor, source_message_id: message.message_id, evidencia: message.text }));
        }
      }
    }
    if (updates.length) return step(updates);

    const decision = qualify(profile, tenant);
    const existingTags = JSON.parse(conversation.tags_json) as string[];
    const stageCall = (stage: string): ToolCall[] => conversation.stage !== stage && !attempted('mover_estagio', args => args.estagio === stage) ? [call('mover_estagio', { estagio: stage })] : [];
    const tagCall = (tag: string): ToolCall[] => !existingTags.includes(tag) && !attempted('adicionar_tag', args => args.tag === tag) ? [call('adicionar_tag', { tag })] : [];

    if (decision.status === 'humano') {
      const calls = [...tagCall(profile.cliente_antigo ? 'cliente-antigo' : 'atendimento-humano'), ...stageCall('Humano')];
      if (!attempted('transferir_humano')) calls.push(call('transferir_humano', { motivo: decision.reason }));
      if (calls.length) return step(calls);
      return step([], 'Vou encaminhar seu atendimento para nossa equipe humana.');
    }
    if (decision.status === 'desqualificado') {
      const calls = [...tagCall('desqualificado'), ...stageCall('Desqualificado')];
      if (calls.length) return step(calls);
      return step([], decision.alternative
        ? 'Existe outra opção possível: energia solar por assinatura, sem instalação. Nossa equipe pode explicar essa alternativa.'
        : `A instalação não atende aos critérios atuais: ${decision.reason} Nossa equipe pode orientar você.`);
    }
    if (decision.status === 'incompleto') {
      const calls = stageCall('Qualificacao');
      if (calls.length) return step(calls);
      const latestText = normalize(request.batch.map(message => message.text).join(' '));
      const identity = /(?:voce|tu).*(?:humano|pessoa|ia|robo)|(?:e|eh) uma? (?:ia|robo)/.test(latestText);
      const guard = /preco|custa|desconto|zerar|economia|garantir/.test(latestText)
        ? 'O consultor apresenta o orçamento após a análise. A economia depende da visita técnica; não prometemos valores ou descontos. '
        : identity ? tenant.pode_dizer_que_e_ia ? 'Sou uma assistente de IA. ' : 'Sou a assistente virtual da empresa. Posso encaminhar você a um atendente. ' : '';
      const greeting = !request.history.some(message => message.author === 'ia')
        ? tenant.tom === 'formal' ? `Olá. Sou ${tenant.nome_assistente}, assistente virtual da ${tenant.nome_empresa}. ` : `Oi! Sou ${tenant.nome_assistente}, assistente virtual da ${tenant.nome_empresa}. `
        : '';
      return step([], greeting + guard + nextQuestion(profile));
    }

    if (conversation.stage === 'Agendado' && !attempted('marcar_agenda')) return step([], 'Sua visita já está agendada. Nossa equipe dará continuidade ao atendimento.');
    const calls = [...tagCall('qualificado'), ...stageCall('Qualificado')];
    if (calls.length && !attempted('marcar_agenda')) return step(calls);
    const question = nextQuestion(profile);
    if (question) return step([], question);

    const consultation = rounds.flatMap(round => round.results).find(result => result.name === 'consultar_agenda');
    if (!consultation && !attempted('consultar_agenda')) return step([call('consultar_agenda', {})]);
    const slots = Array.isArray(consultation?.result.horarios) ? consultation.result.horarios.filter((slot): slot is string => typeof slot === 'string') : [];
    const booking = rounds.flatMap(round => round.results).find(result => result.name === 'marcar_agenda' && result.result.ok !== false && !result.result.error);
    if (booking) {
      const notify: ToolCall[] = [...stageCall('Agendado')];
      if (!attempted('notificar_equipe')) notify.push(call('notificar_equipe', { resumo: `${profile.nome}, ${profile.cidade}: casa própria, conta R$ ${profile.conta_luz}, pagamento ${profile.pagamento}. Visita ${String(booking.result.horario ?? '')}.` }));
      if (notify.length) return step(notify);
      return step([], 'Sua visita foi agendada e a equipe foi avisada. O consultor apresenta o orçamento após a visita; a economia depende da análise técnica.');
    }
    const consent = request.batch.find(message => message.author === 'lead' && /\b(?:pode ser|pode marcar|quero agendar|confirmo|aceito|agende|marque)\b/.test(normalize(message.text)));
    if (consent && !attempted('marcar_agenda')) {
      const wanted = normalize(consent.text);
      const weekdays = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
      const day = weekdays.find(item => wanted.includes(item));
      const period = wanted.includes('manha') ? 'manha' : wanted.includes('tarde') ? 'tarde' : undefined;
      const slot = slots.find(value => {
        if (wanted.includes(normalize(value))) return true;
        if (!day) return false;
        const date = new Date(value);
        const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
        const weekday = normalize(parts.find(part => part.type === 'weekday')!.value);
        const hour = Number(parts.find(part => part.type === 'hour')!.value);
        return weekday.startsWith(day) && !!period && (period === 'manha' ? hour >= 6 && hour < 12 : hour >= 12 && hour < 18);
      });
      if (slot) return step([call('marcar_agenda', { horario: slot })]);
    }
    if (attempted('marcar_agenda')) return step([], 'Esse horário não pôde ser reservado. Vamos escolher outro horário disponível para sua visita?');
    if (!slots.length) return step([], 'Não encontrei horários disponíveis agora. Nossa equipe pode ajudar a combinar a visita.');
    return step([], `Você atende aos critérios. Estes são os horários disponíveis para visita: ${slots.join(', ')}. Qual você confirma?`);
  }
}
