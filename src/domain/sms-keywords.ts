export type InboundKeyword = 'STOP' | 'START' | 'HELP';

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const START_WORDS = new Set(['START', 'UNSTOP']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

export function matchInboundKeyword(body: string, optOutType: string): InboundKeyword | null {
  const type = optOutType.trim().toUpperCase();
  if (type === 'STOP') return 'STOP';
  if (type === 'START') return 'START';
  if (type === 'HELP') return 'HELP';
  const token = body.trim().toUpperCase();
  if (STOP_WORDS.has(token)) return 'STOP';
  if (START_WORDS.has(token)) return 'START';
  if (HELP_WORDS.has(token)) return 'HELP';
  return null;
}
