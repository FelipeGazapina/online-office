// The hire modal's Cursor card. Logged out, the card stays clickable and the button
// asks the owner to log in. Logged in, the same card hires. Run:
//   pnpm build:verify && OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-cursor-login.mjs
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3' };

export default async (s) => {
  await s.waitFor('__office.store.getState().company !== null && __office.store.getState().harnesses !== null', 20000);
  await s.eval(`window.office.send(${JSON.stringify({ type: 'create_block', cwd: repo, name: 'Repo' })})`);
  await s.waitFor('__office.store.getState().company.blocks.length === 1', 10000);
  await s.eval(`__office.store.setState({ computerState: 'seated', computerView: 'office', portalMode: true, computerMenu: false })`);
  await s.waitFor(`document.querySelector('.panel.company button') !== null`, 5000);
  const opened = await s.clickText('.panel.company button', 'Hire');
  assert(opened, 'the configuration panel has a Hire button');
  await s.waitFor(`document.querySelector('[data-hud-resize-target="modal-hire"]') !== null`, 5000);

  const card = await s.eval(`(() => {
    const button = [...document.querySelectorAll('.prov-card')].find((el) => el.innerText.includes('Cursor'));
    if (!button) return null;
    const note = button.querySelector('.prov-note')?.innerText ?? '';
    return { disabled: button.disabled, note, on: button.classList.contains('on') };
  })()`);
  assert(card, 'the hire modal lists Cursor');
  const status = await s.eval(`__office.store.getState().harnesses.cursor`);
  assert(status.kind === 'needs_login' || status.kind === 'ready', `Cursor is ${status.kind}${status.version ? ` ${status.version}` : ''}`);

  if (!card.on) assert(await s.clickText('.prov-card', 'Cursor'), 'the Cursor card accepts a click');
  const selected = await s.eval(`(() => {
    const button = [...document.querySelectorAll('.prov-card')].find((el) => el.innerText.includes('Cursor'));
    const primary = document.querySelector('.modal .actions .btn.primary');
    return { on: button.classList.contains('on'), disabled: button.disabled, note: button.querySelector('.prov-note')?.innerText ?? '', primary: primary?.innerText ?? '', primaryDisabled: primary?.disabled ?? true };
  })()`);

  if (status.kind === 'needs_login') {
    assert(selected.disabled === false, 'a logged-out Cursor card can be selected');
    assert(selected.on, 'Cursor is the selected provider');
    assert(selected.note === 'Log in with Cursor to hire', `the note asks for login (${selected.note})`);
    assert(selected.primary === 'Log in with Cursor', `the button is Log in with Cursor (${selected.primary})`);
    assert(selected.primaryDisabled === false, 'the login button is enabled');
  } else {
    assert(selected.note.startsWith('Ready'), `a logged-in card is ready (${selected.note})`);
    assert(selected.primary === 'Hire', `a logged-in card hires (${selected.primary})`);
  }
};
