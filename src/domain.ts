import type { Decision, Message, Profile, ProfileField, Tenant } from './contracts.js';

export const normalize = (value: string): string => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

/** Extrator simples que aceita apenas padrões explícitos. Declarações ambíguas ou não reconhecidas deixam o campo vazio. */
export function extractFacts(text: string, tenant: Tenant, history: Message[] = []): Profile {
  const profile: Profile = {};
  const normalized = normalize(text);
  // Instruções enviadas pelo lead não são confiáveis; nunca extrair uma ficha hipotética.
  if (/ignore|instrucoes|finja|finge|voce agora|registre|grave (?:na|a) ficha|system\s*:|assistant\s*:|<\/?(?:system|assistant)>/.test(normalized)) return profile;
  const previous = [...history].reverse().find(message => message.author === 'ia');
  const accountContext = previous && /(?:valor|quanto|media).*(?:conta|luz)|conta.*(?:valor|quanto|media)/.test(normalize(previous.text));
  const statements = text.split(/(?<=[.!?;])(?=\s|$)|\n/);
  for (const original of statements) {
    if (original.trimEnd().endsWith('?')) continue;
    const statement = original.replace(/[.!;\n]+$/, '').trim();
    const n = normalize(statement);
    if (!n || /\b(?:meu|minha|meus|minhas)\s+(?:irmao|irma|mae|pai|pais|amigo|amiga|vizinho|vizinha|cliente|tio|tia)\b|\b(?:ele|ela|eles|elas|seu|sua|dele|dela|deles|delas)\b/.test(n)) continue;
    if (/\b(?:hipoteticamente|suponha|imagine|talvez|se|fosse|seria|poderia|quero comprar|pretendo comprar|quero uma|quero ter|procuro|disse|falou|afirmou|respondeu|escreveu|relatou|segundo|preco|orcamento|quanto custa)\b/.test(n)) continue;
    if (/^(?:o |a )?[\p{L}]+(?: [\p{L}]+){0,3}\s+(?:tem|mora|possui|paga)\b/iu.test(statement)) continue;
    const negative = /\bnao\b|\bnunca\b/.test(n);

    if (!negative && /\b(?:ja sou cliente|sou cliente|ja instalei com voces|ja tenho (?:placas|sistema) de voces)\b/.test(n)) profile.cliente_antigo = true;
    if (/\binventario\b|\bnome de outra pessoa\b|\bnao sei\b.*(?:conta|valor|quanto)|(?:conta|valor).*(?:nao sei|nao tenho certeza)|\btenho duvida\b/.test(n)) profile.duvida = true;

    // Aceitar apenas afirmações: perguntas e negações não comprovam um fato afirmativo.
    if (negative) continue;
    if (/\b(?:moro de aluguel|imovel alugad[oa]|casa alugada|apartamento alugado)\b/.test(n) || /^alugad[oa]$/.test(n)) profile.propriedade = 'alugado';
    else if (/\b(?:casa propria|imovel proprio|sou proprietari[oa]|imovel e meu|imovel e minha|e minha,? quitada|e meu,? quitado)\b/.test(n) || /^(?:(?:e )?propri[oa]|(?:e )?minh[ao](?:,? quitad[ao])?)$/.test(n)) profile.propriedade = 'proprio';
    if (/(?:^|,)\s*(?:e (?:uma? )?)?(?:casa|sobrado)(?:\s*(?:,|$)| propria\b| alugad[oa]\b)|\b(?:minha casa|meu sobrado|moro (?:em|numa?) (?:uma? )?(?:casa|sobrado)|(?:imovel|tipo) e (?:uma? )?(?:casa|sobrado))\b/.test(n)) profile.tipo_imovel = 'casa';
    if (/(?:^|,)\s*(?:e (?:uma? )?)?(?:apartamento|ape)(?:\s*(?:,|$)| proprio\b| alugado\b)|\b(?:meu apartamento|meu ape|moro (?:em|num) (?:um )?(?:apartamento|ape)|(?:imovel|tipo) e (?:um )?(?:apartamento|ape))\b/.test(n)) profile.tipo_imovel = 'apartamento';
    if (/^(?:financiad[oa]|financiamento)$|\b(?:quero|prefiro|interesse em|pretendo) financiar\b/.test(n)) profile.pagamento = 'financiado';
    else if (/\ba vista\b/.test(n)) profile.pagamento = 'a_vista';

    const explicitName = statement.match(/(?:meu nome [ée]|me chamo|sou)\s+([\p{L}]+(?:\s+[\p{L}]+){0,4}?)(?=\s+de\s+|\s+e moro\b|[,]|$)/iu);
    const bareName = statement.match(/^([\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+){1,3}),\s*(?:de\s+)?[\p{L}]/u);
    let name = (explicitName?.[1] ?? bareName?.[1])?.trim();
    if (explicitName && /\bsou\s+/i.test(explicitName[0]) && name && !/^[\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+){1,4}$/u.test(name)) name = undefined;
    if (name && !/\b(?:cliente|proprietario|proprietaria|de|recife|olinda|caruaru|casa|apartamento|interessado|interessada)\b/.test(normalize(name))) profile.nome = name;

    const cityMatch = statement.match(/(?:\bmoro em|\bmoro na cidade de|\bsou de|\bcidade [ée])\s+([\p{L}][\p{L} ]+?)(?=,|$)/iu)
      ?? (explicitName || bareName ? statement.match(/^(?:sou\s+)?[\p{L}]+(?:\s+[\p{L}]+){1,3},?\s+de\s+([\p{L}][\p{L} ]+?)(?=,|$)/iu) : null)
      ?? (bareName ? statement.match(/,\s*(?:de\s+)?([\p{L}][\p{L} ]+)$/iu) : null);
    if (cityMatch) {
      const city = cityMatch[1]!.trim();
      if (!/\b(?:quero|preciso|casa|conta|mas|se|talvez)\b/.test(normalize(city))) profile.cidade = tenant.cidades_atendidas.find(item => normalize(item) === normalize(city)) ?? city;
    }
    if (previous && /cidade/.test(normalize(previous.text)) && /^[\p{L} ]+$/u.test(statement)) {
      const knownCity = tenant.cidades_atendidas.find(city => normalize(city) === n);
      if (knownCity) profile.cidade = knownCity;
      else if (!/nome/.test(normalize(previous.text)) && /^[\p{Lu}][\p{L}]+(?:\s+(?:[\p{Lu}][\p{L}]+|d[aeos]+)){0,5}$/u.test(statement)) profile.cidade = statement;
    }
    if (previous && /nome/.test(normalize(previous.text)) && !/cidade/.test(normalize(previous.text)) && /^[\p{Lu}][\p{L}]+(?:\s+(?:[\p{Lu}][\p{L}]+|d[aeos]+)){0,4}$/u.test(statement)) profile.nome = statement;
    const amount = n.match(/\bconta(?: de (?:luz|energia))?\s*(?:(?:vem|fica|e|esta|custa|pago|media|mensal|de|em|por|valor|mensalmente|uns|aproximadamente|r\$)\s*)*([0-9][0-9.,]*)/)
      ?? n.match(/\buns\s+([0-9][0-9.,]*)\s+por mes\b/)
      ?? (accountContext ? n.match(/^\s*(?:r\$\s*)?([0-9][0-9.,]*)\s*(?:reais)?\s*$/) : null);
    if (amount) {
      const numberText = amount[1]!;
      const numeric = numberText.includes(',') || /^\d{1,3}(?:\.\d{3})+$/.test(numberText) ? Number(numberText.replaceAll('.', '').replace(',', '.')) : Number(numberText);
      if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 100_000) profile.conta_luz = numeric;
    }
  }
  return profile;
}

const normalizeEvidence = (text: string): string => normalize(text).replace(/\s+/g, ' ');

/** Recupera uma prova literal, aceitando apenas diferenças de acento, caixa e espaços. */
export function resolveEvidenceQuote(source: string, evidence: string): string | undefined {
  const fragment = evidence.trim();
  if (!fragment) return undefined;
  if (source.includes(fragment)) return fragment;
  // Preservar o original evita registrar como citação um texto reescrito pelo modelo.
  return normalizeEvidence(source).includes(normalizeEvidence(fragment)) ? source : undefined;
}

export function validateEvidence(field: ProfileField, value: unknown, message: Message, tenant: Tenant, history: Message[] = [], evidence?: string): boolean {
  if (message.author !== 'lead') return false;
  const previous = history.filter(item => item.id < message.id);
  const extracted = extractFacts(message.text, tenant, previous);
  if (!Object.hasOwn(extracted, field) || extracted[field] !== value) return false;
  if (evidence === undefined) return true;
  if (resolveEvidenceQuote(message.text, evidence) === undefined) return false;
  evidence = evidence.trim().replace(/\s+/g, ' ');
  if (extractFacts(evidence, tenant, previous)[field] === value) return true;
  if (field === 'propriedade' && value === 'alugado' && normalize(evidence) === 'aluguel') return true;
  // Um trecho literal como "Caruaru" não precisa repetir a frase que já foi validada por inteiro.
  if ((field === 'nome' || field === 'cidade') && typeof value === 'string') return normalizeEvidence(evidence) === normalizeEvidence(value);
  if (field === 'conta_luz' && typeof value === 'number') {
    const literal = evidence.trim().match(/^(?:R\$\s*)?([0-9][0-9.,]*)(?:\s*reais)?$/i)?.[1];
    if (literal) {
      const number = literal.includes(',') || /^\d{1,3}(?:\.\d{3})+$/.test(literal) ? Number(literal.replaceAll('.', '').replace(',', '.')) : Number(literal);
      return Number.isFinite(number) && number === value;
    }
  }
  return false;
}

/** Ponto central das regras de qualificação, para facilitar alterações durante a apresentação. */
export function qualify(profile: Profile, tenant: Tenant): Decision {
  if (profile.cliente_antigo === true) return { status: 'humano', reason: 'cliente-antigo', alternative: false };
  if (profile.duvida === true) return { status: 'humano', reason: 'Dúvida sobre a qualificação; precisa de atendimento humano.', alternative: false };
  if (profile.propriedade === 'alugado' || profile.tipo_imovel === 'apartamento') return { status: 'desqualificado', reason: 'Imóvel alugado ou apartamento.', alternative: true };
  if (typeof profile.conta_luz === 'number' && profile.conta_luz <= tenant.qualificacao.conta_minima_exclusiva) return { status: 'desqualificado', reason: `Conta de luz até R$ ${tenant.qualificacao.conta_minima_exclusiva}.`, alternative: false };
  if (typeof profile.cidade === 'string' && !tenant.cidades_atendidas.some(city => normalize(city) === normalize(profile.cidade as string))) return { status: 'desqualificado', reason: 'Cidade fora da área atendida.', alternative: false };
  if (profile.propriedade !== 'proprio' || profile.tipo_imovel !== 'casa' || typeof profile.conta_luz !== 'number' || typeof profile.cidade !== 'string') return { status: 'incompleto', reason: 'Faltam informações declaradas para qualificar.', alternative: false };
  return { status: 'qualificado', reason: 'Imóvel próprio, casa, conta acima do limite e cidade atendida.', alternative: false };
}

export function nextQuestion(profile: Profile): string {
  if (!profile.nome && !profile.cidade) return 'Qual é seu nome e em qual cidade fica o imóvel?';
  if (!profile.nome) return 'Qual é seu nome?';
  if (!profile.cidade) return 'Em qual cidade fica o imóvel?';
  if (!profile.propriedade) return 'O imóvel é próprio ou alugado?';
  if (!profile.tipo_imovel) return 'É casa ou apartamento?';
  if (profile.conta_luz === undefined) return 'Qual é o valor médio da sua conta de luz por mês?';
  if (!profile.pagamento) return 'Você tem interesse em financiar ou pagar à vista?';
  return '';
}
