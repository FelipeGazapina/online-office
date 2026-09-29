import type { Provider } from '../../shared/protocol.ts';
import { createClaudeSession } from './claude.ts';
import { createSimulatedSession } from './simulated.ts';
import type { SessionFactory } from './types.ts';

// Keyed by Provider so adding a provider to the contract fails typecheck until it is wired here.
// Mirrors PROVIDERS[p].real: only claude-code is real.
export const ADAPTERS: Record<Provider, SessionFactory> = {
  'claude-code': createClaudeSession,
  codex: createSimulatedSession,
  cursor: createSimulatedSession,
  grok: createSimulatedSession,
};
