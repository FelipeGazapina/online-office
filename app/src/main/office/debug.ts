// Opt-in logging for the main process. OFFICE_DEBUG=1 turns it on. Plain Node: the MCP server uses it too.
export const logger =
  (tag: string) =>
  (...a: unknown[]) => {
    if (process.env.OFFICE_DEBUG) console.log(`[${tag}]`, ...a);
  };
