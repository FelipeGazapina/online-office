// Per-hop timestamps for the first-reply latency check. OFFICE_TRACE=1 prints one line per hop, in epoch ms.
export const trace = (who: string, hop: string) => {
  if (process.env.OFFICE_TRACE) console.log(`[trace] ${Date.now()} ${who} ${hop}`);
};
