// Shared by the no-model check scripts. A failed check is printed and counted, and `finish()` turns the count into the exit code.
let failures = 0;

export const check = (cond: unknown, msg: string, detail = '') => {
  if (cond) console.log('ok:', msg);
  else {
    failures++;
    console.log('FAIL:', detail ? `${msg} | ${detail}` : msg);
  }
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

export function finish(): never {
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
