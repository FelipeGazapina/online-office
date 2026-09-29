// Half duplex. The employees' voices leak into the microphone, and without a gate both of R4's spoken test lines came back as
// phantom owner speech, which would go straight back to the employee as the next instruction. So nothing the microphone
// hears counts while an employee is speaking, or for a moment after: room reverb lingers, and the voice detector's own
// hangover would otherwise end a segment just after the gate opened.
export function createGate(tailMs: number) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: boolean) => {
    if (next === closed) return;
    closed = next;
    for (const listener of listeners) listener();
  };
  return {
    // Call with true when an employee starts speaking and with false when the speech may have ended.
    speaking(on: boolean) {
      clearTimeout(timer);
      if (on) set(true);
      else timer = setTimeout(() => set(false), tailMs);
    },
    isOpen: () => !closed,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export const TTS_TAIL_MS = 400;
export const gate = createGate(TTS_TAIL_MS);
