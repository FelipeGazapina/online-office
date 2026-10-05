import { testRun } from '../../testRun.ts';

// Test-only render counters. The chat promises that a streamed token redraws the live bubble and nothing else.
export const renders: Record<string, number> = {};
export const countRender = (name: string) => {
  if (testRun) renders[name] = (renders[name] ?? 0) + 1;
};
