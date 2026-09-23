export const INTENT_NAMES = [
  'schedule.query',
  'session.roster',
  'money.summary',
  'session.cancel',
  'session.add',
  'session.move',
  'broadcast.send',
  'roster.offer',
  'unknown',
] as const;

export type IntentName = (typeof INTENT_NAMES)[number];

export const WRITE_INTENTS: ReadonlySet<IntentName> = new Set([
  'session.cancel',
  'session.add',
  'session.move',
  'broadcast.send',
  'roster.offer',
]);

export const INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: [...INTENT_NAMES] },
    confidence: { type: 'number' },
    session_id: { type: ['integer', 'null'] },
    session_type_id: { type: ['integer', 'null'] },
    session_type: { type: ['string', 'null'] },
    when: { type: ['string', 'null'] },
    new_when: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    reason: { type: ['string', 'null'] },
  },
  required: ['intent', 'confidence'],
} as const;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteRequest {
  messages: ChatMessage[];
  schema: Record<string, unknown>;
}

export type CompleteFn = (req: CompleteRequest) => Promise<unknown>;

export type IntentSource = 'pattern' | 'model';

export interface ClassifiedIntent {
  intent: IntentName;
  confidence: number;
  session_id: number | null;
  session_type_id: number | null;
  session_type: string | null;
  when: string | null;
  new_when: string | null;
  location: string | null;
  reason: string | null;
  source: IntentSource;
}
