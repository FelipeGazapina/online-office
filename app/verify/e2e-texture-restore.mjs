// A lost GL context takes every texture off the GPU. The bitmap and canvas textures free their pixels once the GPU has them, so the office
// must read the files and draw the canvases again for the picture to come back. This loses the context of the real office on purpose,
// restores it, and checks that nothing was reported and that two pictures match the ones before: the overview, and a first-person view of
// the lobby sofa, which draws textures the overview had not asked the GPU for since the loss. three uploads a texture the first time a
// draw needs it, so what is on the GPU after the loss is what those pictures drew, not everything that was there before.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9343 node verify/cdp.mjs verify/e2e-texture-restore.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
// A hidden window draws nothing, and there would be nothing to compare.
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_TEST_RUN: '', OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const uploaded = (s) => s.eval('(() => { const m = __office.memory(); return { n: m.textures.top.length, sources: m.counts.textureSources, uploadedMiB: m.textures.uploadedMiB, totalMiB: m.textures.totalMiB, three: m.three.textures }; })()');

export default async function (s) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  await s.sleep(3000);
  const sofa = await s.eval(`__office.instances('sofa')[0]`);
  assert(!!sofa, 'the office has a sofa');
  const home = await s.eval('__office.state().owner');
  const views = async (tag) => {
    // The overview looks at the owner, so both overviews are taken from the same place.
    await s.eval(`__office.teleport(${home.x}, ${home.z}, ${home.yaw})`);
    await s.sleep(2500);
    await s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);
    const iso = await s.shot(`restore-${tag}-iso`);
    await s.press('Tab');
    await s.waitFor('window.__officeCamera && Math.abs(window.__officeCamera.blend - 1) < 0.001', 10000);
    await s.eval(`__office.teleport(${sofa.x}, ${sofa.z + 1.8}, ${Math.PI})`);
    await s.sleep(600);
    const cam = await s.eval('window.__officeCamera');
    await s.drag({ x: 700, y: 400 }, { x: 700, y: 400 + Math.round((cam.pitch + 0.45) / 0.0024) }, 6);
    await s.sleep(800);
    const first = await s.shot(`restore-${tag}-sofa`);
    await s.press('Tab');
    await s.waitFor('window.__officeCamera && Math.abs(window.__officeCamera.blend) < 0.001', 10000);
    await s.sleep(800);
    return { iso, first };
  };
  const before = await uploaded(s);
  const pictures = await views('before');
  console.log('before', JSON.stringify(before));
  assert(before.uploadedMiB > 100, `the textures are on the GPU before the loss (${before.uploadedMiB} MiB)`);

  const logsBefore = s.logs.length;
  await s.eval(`(() => {
    const canvas = document.querySelector('canvas');
    window.__lose = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    window.__events = [];
    canvas.addEventListener('webglcontextlost', () => window.__events.push('lost'));
    canvas.addEventListener('webglcontextrestored', () => window.__events.push('restored'));
    window.__lose.loseContext();
  })()`);
  await s.sleep(800);
  await s.eval('window.__lose.restoreContext()');
  await s.waitFor(`window.__events.includes('restored')`, 10000);
  await s.sleep(4000);
  assert((await s.eval('window.__events.join()')) === 'lost,restored', 'the context was lost and restored');
  const drawn = await uploaded(s);
  console.log('after, before any view', JSON.stringify(drawn));

  const again = await views('after');
  const after = await uploaded(s);
  console.log('after, both views drawn', JSON.stringify(after));
  assert(after.uploadedMiB > drawn.uploadedMiB, `drawing the sofa uploaded more textures (${drawn.uploadedMiB} then ${after.uploadedMiB} MiB)`);
  assert(after.uploadedMiB > before.uploadedMiB * 0.8, `most of the textures are on the GPU again (${before.uploadedMiB} MiB before, ${after.uploadedMiB} MiB after)`);
  const noisy = s.logs.slice(logsBefore).filter((l) => !/THREE\.Clock/.test(l));
  assert(noisy.length === 0, `nothing was reported while the context came back${noisy.length ? `: ${noisy.slice(0, 3).join(' | ')}` : ''}`);
  for (const view of ['iso', 'first']) {
    const out = spawnSync('magick', ['compare', '-metric', 'PSNR', pictures[view], again[view], 'null:'], { encoding: 'utf8' }).stderr;
    console.log(`${view} view before and after the loss: ${out.trim()} dB`);
    assert(Number.parseFloat(out) > 38, `the ${view} picture is the same after the textures came back`);
  }
}
