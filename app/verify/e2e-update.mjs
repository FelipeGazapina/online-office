import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { assert } from './lib.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8'));
const APP_ID = 'com.gazapina.onlineoffice.e2e';
const NAME = 'Online Office E2E';
const V1 = '0.1.900';
const V2 = '0.1.901';
const MIN_FREE = 4e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const processes = () =>
  execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const m = line.trim().match(/^(\d+) (.*)$/);
      return m ? [{ pid: Number(m[1]), command: m[2] }] : [];
    });
const mainProcesses = (exe) => processes().filter((p) => p.command === exe || p.command.startsWith(`${exe} `));
const plist = (app, key) => execFileSync('plutil', ['-extract', key, 'raw', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
const signatureHolds = (app) => spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status === 0;
const requirement = (app) => {
  const r = spawnSync('codesign', ['-d', '-r-', app], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`.split('\n').find((l) => l.startsWith('designated =>'));
};
const freeBytes = (path) => {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
};

const work = realpathSync(mkdtempSync(join(tmpdir(), 'oo-e2e-')));
const installDir = join(work, 'install');
const installed = join(installDir, `${NAME}.app`);
const exe = join(installed, 'Contents/MacOS', NAME);

const feed = { dir: '', corrupt: false, hits: [] };
const badSha = Buffer.alloc(64).toString('base64');
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://feed').pathname.slice(1));
  feed.hits.push(name);
  if (!feed.dir || !readdirSync(feed.dir).includes(name)) return void res.writeHead(404).end();
  const file = join(feed.dir, name);
  if (name === 'latest-mac.yml' && feed.corrupt) {
    return void res.writeHead(200, { 'content-type': 'text/yaml' }).end(readFileSync(file, 'utf8').replace(/sha512: .+/g, `sha512: ${badSha}`));
  }
  res.writeHead(200, { 'content-length': statSync(file).size }).flushHeaders();
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const feedUrl = `http://127.0.0.1:${server.address().port}/`;

function packageVersion(version) {
  assert(existsSync(join(APP_DIR, 'out/main/index.js')), 'pnpm build has written out/, which electron-builder packages');
  assert(freeBytes(work) > MIN_FREE, `at least 4 GB free before packaging v${version}`);
  const output = join(work, `build-${version}`);
  const config = join(work, `builder-${version}.json`);
  const build = {
    ...pkg.build,
    appId: APP_ID,
    productName: NAME,
    afterSign: resolve(APP_DIR, pkg.build.afterSign),
    mac: { ...pkg.build.mac, target: [{ target: 'zip', arch: 'arm64' }] },
    publish: { provider: 'generic', url: feedUrl },
    extraMetadata: { name: 'online-office-e2e', productName: NAME, version },
    directories: { output },
  };
  writeFileSync(config, JSON.stringify(build));
  const r = spawnSync(join(APP_DIR, 'node_modules/.bin/electron-builder'), ['--mac', '--publish', 'never', '--config', config], { cwd: APP_DIR, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`electron-builder failed for v${version}:\n${(r.stdout + r.stderr).split('\n').slice(-30).join('\n')}`);
  rmSync(join(output, 'mac-arm64'), { recursive: true, force: true });
  const files = readdirSync(output);
  assert(files.includes(`Online-Office-${version}-arm64.zip`) && files.includes('latest-mac.yml'), `v${version} packaged as ${files.filter((f) => f.endsWith('.zip')).join(', ')} with latest-mac.yml`);
  return output;
}

const clickChip = (s) => s.eval(`document.querySelector('.update-chip').click()`);
const chipText = (s) => s.eval(`document.querySelector('.update-chip')?.innerText ?? null`);
const collapse = (updates) => updates.filter((x, i, all) => x !== all[i - 1]);
const statuses = async (s) => {
  const seen = collapse(await s.eval('__updates'));
  return seen.slice(seen.indexOf('available'));
};

async function watchUntilGone(s) {
  const deadline = Date.now() + 120000;
  let seen = [];
  let restarting = false;
  while (Date.now() < deadline) {
    try {
      seen = await s.eval('__updates');
      restarting ||= (await chipText(s)) === 'Restarting…';
    } catch {
      return { seen, restarting };
    }
    await sleep(50);
  }
  throw new Error('the app never quit');
}

let app;
try {
  const build1 = packageVersion(V1);
  execFileSync('ditto', ['-x', '-k', join(build1, `Online-Office-${V1}-arm64.zip`), installDir]);
  rmSync(build1, { recursive: true, force: true });
  assert(plist(installed, 'CFBundleShortVersionString') === V1, `v${V1} is installed at ${installDir}`);
  assert(requirement(installed) === `designated => identifier "${APP_ID}"`, 'the installed app is pinned to its bundle identifier');
  feed.dir = packageVersion(V2);

  feed.corrupt = true;
  app = await launch({ exe, env: { OFFICE_DATA_DIR: join(work, 'data') } });
  await app.waitFor('!!window.__office && !!window.office');
  await app.eval('window.__updates = []; window.office.update.subscribe((u) => __updates.push(u.status)); true');

  await until(() => chipText(app), 60000, 'the update chip');
  assert((await chipText(app)) === `Update to v${V2} and restart`, `the chip offers v${V2} on its own after launch`);
  const toast = await app.eval(`document.querySelector('.toasts')?.innerText ?? ''`);
  assert(toast.includes(`Online Office v${V2} is available. Click Update at the top right.`), 'a toast says where to click');
  assert(toast.includes('Press C to free the mouse.'), 'the toast says how to free the mouse in the follow camera');

  await clickChip(app);
  await app.waitFor(`document.querySelector('.update-chip')?.innerText.includes('Update failed')`, 120000);
  const failure = await app.eval(`document.querySelector('.update-chip').title`);
  assert(failure.includes('sha512'), `the chip says the update failed, and why: ${failure}`);
  assert((await statuses(app)).join() === 'available,downloading,update-failed', `the states went ${(await statuses(app)).join(' > ')}`);
  assert((await chipText(app)) === 'Update failed. Check again', 'the chip offers Check again');

  feed.corrupt = false;
  const feedReads = feed.hits.filter((h) => h === 'latest-mac.yml').length;
  await clickChip(app);
  await app.waitFor(`document.querySelector('.update-chip')?.innerText === 'Update to v${V2} and restart'`);
  assert(feed.hits.filter((h) => h === 'latest-mac.yml').length > feedReads, 'Check again re-read latest-mac.yml');
  assert((await statuses(app)).join() === 'available,downloading,update-failed,checking,available', 'the retry went through checking back to available');

  const [before] = mainProcesses(exe);
  assert(before && before.command.includes('--remote-debugging-port'), `v${V1} is running from ${installed}`);
  await clickChip(app);
  const { seen, restarting } = await watchUntilGone(app);
  assert(collapse(seen).slice(-3).join() === 'available,downloading,installing', `one click downloaded and moved to installing (${collapse(seen).join(' > ')})`);
  assert(restarting, 'the chip read Restarting… while Squirrel staged the update');
  await until(() => !processes().some((p) => p.pid === before.pid), 30000, `v${V1} to quit`);
  assert(!processes().some((p) => p.pid === before.pid), `v${V1} quit`);

  const [after] = await until(() => {
    const found = mainProcesses(exe);
    return found.length && found;
  }, 90000, 'the app to relaunch');
  assert(after.pid !== before.pid, `the app relaunched from the same path as pid ${after.pid}`);
  assert(plist(installed, 'CFBundleShortVersionString') === V2, `the installed bundle is v${V2}`);
  assert(signatureHolds(installed), 'the updated bundle passes codesign --verify --deep --strict');
  assert(requirement(installed) === `designated => identifier "${APP_ID}"`, 'the updated bundle is still pinned to the bundle identifier');
  await sleep(2000);
  assert(mainProcesses(exe).some((p) => p.pid === after.pid), 'the relaunched app is still running two seconds later');
  console.log('e2e-update passed');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  // The relaunched app does not inherit the test's environment, so it opens with the default profile and a visible window.
  for (const p of processes()) if (p.command.includes(installDir) || p.command.includes(APP_ID)) process.kill(p.pid, 'SIGKILL');
  spawnSync('launchctl', ['remove', `${APP_ID}.ShipIt`]);
  server.close();
  const caches = join(homedir(), 'Library/Caches');
  const leftovers = [work, join(caches, 'online-office-e2e-updater'), join(homedir(), 'Library/Application Support', NAME)];
  for (const name of readdirSync(caches)) if (name.startsWith(APP_ID)) leftovers.push(join(caches, name));
  for (const path of leftovers) rmSync(path, { recursive: true, force: true });
}
