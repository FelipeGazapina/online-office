// Run with `pnpm build && node verify/cdp.mjs verify/e2e-startup.mjs`.
// This reaches the built Electron main process and catches import-time failures before a window opens.
export default async function startup(s) {
  await s.waitFor('document.querySelector("#root canvas") !== null');
  if (!(await s.eval('document.body.innerText.includes("Gazapina Labs")'))) {
    throw new Error('the office did not render its company panel');
  }
  if (s.logs.some((line) => line.startsWith('exception:'))) {
    throw new Error(`renderer exception: ${s.logs.join('\n')}`);
  }
  console.log('ok: built Electron app opened and rendered the office');
}
