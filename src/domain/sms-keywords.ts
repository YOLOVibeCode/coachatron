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
  if (isStopRequest(body)) return 'STOP';
  return null;
}

// ---- a short reply that asks, in its own words, to stop ----------------
//
// The FCC's 2024 consent rule: a reply that reasonably says "stop" (stop,
// quit, end, revoke, opt out, cancel, unsubscribe, and the like) revokes
// consent, even when it is not the bare keyword. A message that only
// contains one of those words while asking for something else, such as a
// coach's "stop the 6pm session", is not a request to stop texting.

/** Words that ask to stop on their own. */
const STOP_VERBS = new Set(['stop', 'unsubscribe', 'unsubscribed', 'unsub', 'optout', 'revoke', 'quit']);
/** Words that ask to stop only when the reply also names the texts or the person. */
const STOP_IF_ABOUT_TEXTS = new Set(['cancel', 'end', 'remove', 'removed']);
/** The texts, or the person getting them. */
const ABOUT_TEXTS = new Set([
  'me', 'text', 'texts', 'texting', 'message', 'messages', 'messaging', 'sms', 'reminder', 'reminders',
  'notification', 'notifications', 'alert', 'alerts', 'subscription', 'list', 'number', 'consent',
]);
/** Words that may sit around those without changing what is asked. */
const FILLER = new Set([
  'a', 'again', 'all', 'already', 'and', 'any', 'anymore', 'asap', 'be', 'can', 'could', 'for', 'from',
  'immediately', 'i', 'it', 'just', 'kindly', 'like', 'more', 'my', 'now', 'of', 'off', 'ok', 'okay', 'out',
  'please', 'pls', 'plz', 'send', 'sending', 'thank', 'thanks', 'thx', 'the', 'these', 'this', 'those', 'to',
  'us', 'want', 'with', 'would', 'you', 'your',
]);

const MAX_STOP_REQUEST_CHARS = 100;
const MAX_STOP_REQUEST_WORDS = 10;

/** Lowercase words only; a few common phrasings become one stop word. */
function stopRequestWords(body: string): string[] {
  const text = body
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\bopt (?:me )?out\b/g, 'optout')
    .replace(/\btake me off\b/g, 'remove me')
    .replace(/\b(?:do not|dont|never) (text|texting|message|messaging|contact)\b/g, 'stop $1')
    .replace(/\bno more\b/g, 'stop');
  return text ? text.split(' ') : [];
}

/** True when a short inbound text, as a whole, asks to stop the texts. */
export function isStopRequest(body: string): boolean {
  if (body.length > MAX_STOP_REQUEST_CHARS) return false;
  const words = stopRequestWords(body);
  if (words.length === 0 || words.length > MAX_STOP_REQUEST_WORDS) return false;
  let strong = false;
  let soft = false;
  let aboutTexts = false;
  for (const word of words) {
    if (STOP_VERBS.has(word)) strong = true;
    else if (STOP_IF_ABOUT_TEXTS.has(word)) soft = true;
    else if (ABOUT_TEXTS.has(word)) aboutTexts = true;
    else if (!FILLER.has(word)) return false;
  }
  return strong || (soft && aboutTexts);
}
