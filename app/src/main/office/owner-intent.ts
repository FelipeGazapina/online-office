// Tells a question from a work order in the owner's free text, so a plain question settles answered and a work order
// still has to show files. Pure and offline: no model, so it costs no latency and works for every harness.
// The default is work. Only text with a question form and no order in it is help, because calling a question work costs a
// "blocked" tag on a good answer, while calling a work order help would let it settle with nothing made.
import type { Intent } from '../../shared/mail.ts';

type OwnerIntent = Extract<Intent, 'work' | 'help'>;

// Verbs that ask for a change to the project. Matched where a clause starts, so "which file adds the route" is not an order.
const ORDER_VERBS = new Set(
  `add build create make write implement fix repair refactor rename remove delete drop update change replace move extract split merge
  rewrite redesign improve optimize optimise polish clean migrate bump upgrade downgrade install configure set enable disable wire hook
  document commit push ship deploy release revert patch tweak adjust apply introduce insert put include support handle
  adicione adicionar crie criar faca faça fazer corrija corrigir conserte consertar implemente implementar escreva escrever
  refatore renomeie remova apague atualize altere mude mudar mova instale configure melhore otimize documente substitua conserta
  coloque ponha inclua`.split(/\s+/),
);

// Wrappers that make an order polite and leave it an order.
const POLITE = [
  /^(?:please|pls|hey|hi|ok|okay|so|also|now|then|and|but|just|go ahead and|por favor|agora|entao|então|e)\b/,
  /^(?:can|could|would|will|should) (?:you|we|u)\b/,
  /^(?:is it|would it be|will it be) possible (?:to|for you to)\b/,
  /^(?:how|what) about\b/,
  /^why (?:don't|dont|not|do not)\b/,
  /^(?:i|we) (?:need|want|would like|'d like|d like) (?:you |us )?to\b/,
  /^(?:you|we) (?:need|should|must|have) to\b/,
  /^let'?s\b/,
  /^(?:voce|você) (?:pode|consegue|poderia)\b/,
  /^(?:pode|poderia|consegue)\b/,
  /^(?:preciso|quero) que (?:voce|você)\b/,
  /^(?:preciso|quero|precisamos) (?:de )?(?:que )?/,
];

// A clause is a question when it opens with one of these.
const ASKS = [
  /^(?:what|whats|what's|which|who|whom|whose|when|where|why|how|whether)\b/,
  /^(?:is|are|was|were|am|do|does|did|has|have|had|can|could|would|will|should|shall|may)\b/,
  /^(?:tell|show|explain|list|describe|summari[sz]e|print|give|find out|look up|check whether|check if|see if|let me know)\b/,
  /^(?:any|anything|status|update|news|progress)\b/,
  /^(?:qual|quais|quem|quando|onde|aonde|como|quanto|quantos|quantas|quanta|por que|porque|por quê|o que|que|será|sera)\b/,
  /^(?:voce sabe|você sabe|me diga|me diz|me mostre|me explique|me fale|mostre|explique|liste|descreva|resuma|diga)\b/,
  /^(?:esta|está|estao|estão|tem|existe|existem|foi|foram|ja|já|deu|da|dá)\b/,
];

const clauses = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/(?<=[.!?;])\s+|\n+|\s+(?:and then|then|and|e depois|depois|e)\s+/)
    .map((c) => c.trim())
    .filter(Boolean);

// Drops fillers, a vocative ("Ana,") and politeness from the front until the first real word.
const VOCATIVE = /^[\w\u00C0-\u024F]+,\s+/;
const stripped = (clause: string): string => {
  let c = clause;
  for (let again = true; again; ) {
    again = false;
    for (const p of [VOCATIVE, ...POLITE]) {
      const next = c.replace(p, '').trim();
      if (next !== c && next) {
        c = next;
        again = true;
      }
    }
  }
  return c;
};

const firstWord = (c: string) => c.split(/[^\w\u00C0-\u024F']+/, 1)[0] ?? '';

// "adding" and "making" are orders too ("how about adding a toggle").
const verbOf = (w: string) => (w.endsWith('ing') ? [w.slice(0, -3), `${w.slice(0, -3)}e`, w.slice(0, -4)] : [w]);

export const isOrder = (clause: string): boolean => verbOf(firstWord(stripped(clause))).some((v) => ORDER_VERBS.has(v));
export const isAsk = (clause: string): boolean => clause.endsWith('?') || ASKS.some((a) => a.test(stripped(clause)));

export const ownerIntent = (text: string): OwnerIntent => {
  const parts = clauses(text);
  if (parts.some(isOrder)) return 'work';
  return parts.some(isAsk) ? 'help' : 'work';
};
