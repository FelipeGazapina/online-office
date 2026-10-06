// What the owner's free text is, before it becomes a request. A question settles done with its answer. A work order has to
// show files. The default is work, because calling a question work costs a "blocked" tag on a good answer, while calling a
// work order a question would let it settle with nothing made. Plain Node: the check scripts import it.
import type { Intent } from '../../shared/mail.ts';

export type OwnerIntent = Extract<Intent, 'work' | 'help'>;

// Verbs that ask for a change to the project. A message that opens with one is a work order, and nothing else needs to be
// asked, so most orders skip the model call. Never used to call something a question.
const ORDER_VERBS = `add build create make write implement fix refactor rename remove delete update change replace move extract split merge rewrite
  improve optimize polish migrate bump upgrade install configure document revert patch tweak
  adicione crie corrija conserte implemente escreva refatore renomeie remova apague atualize altere mude mova instale melhore otimize documente`.split(/\s+/);

// "Please, Ana, add ..." opens with fillers and a name. "Update me on ..." and "update on ..." ask for news.
const OPENS_WITH_ORDER = new RegExp(`^(?:(?:please|pls|hey|hi|ok|okay|now|also|and|then|so|just)[\\s,]+|\\p{L}+,\\s+)*(?:${ORDER_VERBS.join('|')})\\b(?!\\s+(?:me|us|on|about)\\b)`, 'iu');

export const isPlainOrder = (text: string): boolean => OPENS_WITH_ORDER.test(text.trim());
