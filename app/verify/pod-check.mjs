// No model, no Electron. Guards the rule that a team's pod is made of items and nothing is drawn at a fixed spot:
// 1. no renderer file anchors anything to a team's slot except the empty slot's construction site,
// 2. every pod def has a model, and the model stays within a stone's throw of its own footprint, so a piece that is
//    picked up and moved shows its outline where its geometry is.
// Run from app/: node verify/pod-check.mjs   Exits 1 on any failed check. (An .mjs, so the node type check does not follow it
// into the renderer, whose files need the bundler's types.)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3 } from 'three';
import { ITEM_DEFS } from '../src/shared/space/index.ts';
import { modelOf } from '../src/renderer/src/scene/building/models.ts';
import { check, finish } from './check.ts';

const root = fileURLToPath(new URL('../src/renderer/src', import.meta.url));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(name)) files.push(path);
  }
};
walk(root);

const ANCHORS = /\bblockCenter\b|\brugTiles\b|\bPodBoundary\b|\bPodDecor\b|\bDailyHuddle\b/;
const users = files.filter((f) => ANCHORS.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1));
check(users.length === 1 && users[0] === 'scene/Office.tsx', 'only the construction site of the next empty slot is anchored to a slot', users.join(', '));
const office = readFileSync(join(root, 'scene/Office.tsx'), 'utf8');
check((office.match(/blockCenter\(/g) ?? []).length === 1 && /function GhostSlot/.test(office), 'and it is the one GhostSlot, which draws no block');

// The model sits on its footprint: the allowed bleed is a cell's snap plus a rail's thickness; the huddle's mat reaches out under its chairs.
const BLEED = 0.55;
const pod = Object.keys(ITEM_DEFS).filter((d) => d.startsWith('pod_'));
check(pod.length === 14, `there are ${pod.length} pod defs`);
for (const id of pod) {
  const def = ITEM_DEFS[id];
  const box = new Box3().setFromBufferAttribute(modelOf(id).getAttribute('position'));
  const w = def.w / 2;
  const d = def.d / 2;
  const over = Math.max(-w / 2 - box.min.x, box.max.x - w / 2, -d / 2 - box.min.z, box.max.z - d / 2);
  // A def's footprint is turned for a side rail, whose long side lies along x at rot 0 like the model.
  check(over <= BLEED, `${id}: the model is within ${BLEED} m of its ${w} x ${d} m footprint (over by ${over.toFixed(2)} m)`);
  check(box.min.y >= -0.001 && box.max.y <= def.height + 0.45, `${id}: the model stands on the floor and no taller than ${def.height} m plus its sign or art (top ${box.max.y.toFixed(2)} m)`);
}
for (const id of Object.keys(ITEM_DEFS)) {
  try {
    modelOf(id);
  } catch (err) {
    check(false, `${id} has a model`, String(err));
  }
}
check(true, 'every def has a model for its ghost and its thumbnail');
finish();
