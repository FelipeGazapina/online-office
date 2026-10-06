// The translucent preview of what the current tool would build: a wall with a handle at its free end, a whole room, the
// tiles about to be painted, the wall about to get a door, or the furniture with its footprint and a front arrow.
// Green means the building's own rules accept it, red means they do not. Nothing here decides; BuildInput does.
import { useFrame, useThree } from '@react-three/fiber';
import { Edges, Html } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import { BackSide, BufferGeometry, CircleGeometry, Color, DoubleSide, Float32BufferAttribute, MeshBasicMaterial, MeshStandardMaterial, RingGeometry, ShaderMaterial, Shape, Vector2 } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cellBounds, ITEM_DEFS, STORY_H, WALL_HALF, YAW, footprint, rotateLocal, stairsInfo, type Item, type Vec2 } from '../../../../shared/space/index.ts';
import { draft, type Ghost } from '../../hud/build/state.ts';
import { useStore } from '../../store.ts';
import { modelOf } from './models.ts';

const GREEN = '#2fe06a';
const RED = '#ff4d4d';
const WHITE = '#ffffff';
const DRAW = '#2d9cff';
const tone = (ok: boolean) => (ok ? GREEN : RED);

// The footprint and the arrow draw through walls and furniture: a ghost inside a room has to stay readable from outside.
const basic = (color: string, opacity: number, depthTest = true) => new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest, side: DoubleSide });
const MATERIALS = {
  wall: basic('#9fd0ff', 0.42),
  wallErase: basic(RED, 0.5),
  cap: basic(DRAW, 1, false),
  capRed: basic(RED, 1, false),
  rail: basic(DRAW, 0.95, false),
  railRed: basic(RED, 0.95, false),
  dot: basic(WHITE, 1, false),
  wallGreen: basic(GREEN, 0.5),
  wallRed: basic(RED, 0.5),
  fillWhite: basic(WHITE, 0.28),
  fillGreen: basic(GREEN, 0.34, false),
  fillRed: basic(RED, 0.38, false),
  padGreen: basic(GREEN, 0.7, false),
  padRed: basic(RED, 0.72, false),
  hole: basic('#ffb347', 0.6, false),
  landing: basic(GREEN, 0.35, false),
  turnDisc: basic('#232640', 0.85, false),
  keyline: basic('#232640', 0.7, false),
  turnArrow: basic(WHITE, 1, false),
  post: basic(WHITE, 0.95),
  arrowGreen: basic(GREEN, 0.95, false),
  arrowRed: basic(RED, 0.95, false),
};
// The piece is tinted to the verdict's colour, not just lit by it: a pale piece over pale floor reads as glass.
const ghostModel = (ok: boolean, depthTest: boolean) =>
  new MeshStandardMaterial({ vertexColors: true, color: ok ? '#3fd97e' : '#ff5c5c', transparent: true, opacity: depthTest ? 0.92 : 0.28, emissive: ok ? GREEN : RED, emissiveIntensity: 0.22, depthWrite: false, depthTest });
const MODEL_OK = ghostModel(true, true);
const MODEL_BAD = ghostModel(false, true);
const XRAY_OK = ghostModel(true, false);
const XRAY_BAD = ghostModel(false, false);

// The piece's silhouette in a band of fixed screen width: a dark outer line and a light inner one in the verdict's colour,
// so the outline holds against pale floors, dark floors and busy ones. The back faces are pushed outward on screen.
const RESOLUTION = { value: new Vector2(1440, 900) };
const RIM_INK = 4;
const RIM_TONE = 2;
const rim = (color: string, px: number) =>
  new ShaderMaterial({
    uniforms: { uColor: { value: new Color(color) }, uPx: { value: px }, uRes: RESOLUTION },
    vertexShader: `uniform float uPx; uniform vec2 uRes;
      void main() {
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 away = (projectionMatrix * vec4(normalize(normalMatrix * normal), 0.0)).xy;
        p.xy += normalize(away + 1e-6) * (2.0 * uPx / uRes) * p.w;
        gl_Position = p;
      }`,
    fragmentShader: `uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    side: BackSide,
    depthWrite: false,
  });
const RIM = { ink: rim('#232640', RIM_INK), ok: rim('#a6ffc4', RIM_TONE), bad: rim('#ffb0b0', RIM_TONE) };
const hulls = new Map<string, BufferGeometry>();
/** The model's shape with its vertices welded and smoothly shaded, so pushing it outward does not tear it at the corners. */
function hullOf(def: string): BufferGeometry {
  let g = hulls.get(def);
  if (!g) {
    const src = modelOf(def);
    const bare = new BufferGeometry().setAttribute('position', src.getAttribute('position').clone());
    if (src.index) bare.setIndex(src.index.clone());
    g = mergeVertices(bare, 1e-4);
    g.computeVertexNormals();
    hulls.set(def, g);
  }
  return g;
}

const T = WALL_HALF * 2 + 0.04;

function WallBox({ a, b, material, bad = false, probe, capped = true }: { a: Vec2; b: Vec2; material: MeshBasicMaterial; bad?: boolean; probe?: Record<string, unknown>; capped?: boolean }) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const yaw = Math.atan2(-(b.z - a.z), b.x - a.x);
  const mid: [number, number, number] = [(a.x + b.x) / 2, STORY_H / 2, (a.z + b.z) / 2];
  return (
    <>
      <mesh position={mid} rotation-y={yaw} material={material} renderOrder={6} userData={probe}>
        <boxGeometry args={[len + T, STORY_H, T]} />
        <Edges color="#e8f4ff" threshold={20} />
      </mesh>
      {capped && (
        <mesh position={[mid[0], STORY_H + 0.04, mid[2]]} rotation-y={yaw} material={bad ? MATERIALS.capRed : MATERIALS.cap} renderOrder={9}>
          <boxGeometry args={[len + T + 0.06, 0.1, T + 0.1]} />
        </mesh>
      )}
    </>
  );
}

/** A colored band flat on the floor along a wall's line: where the wall will stand, readable from any angle. */
function Strip({ a, b, bad }: { a: Vec2; b: Vec2; bad: boolean }) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  return (
    <mesh position={[(a.x + b.x) / 2, 0.08, (a.z + b.z) / 2]} rotation={[-Math.PI / 2, 0, Math.atan2(b.z - a.z, b.x - a.x)]} material={bad ? MATERIALS.railRed : MATERIALS.rail} renderOrder={10}>
      <planeGeometry args={[len + 0.2, 0.24]} />
    </mesh>
  );
}

const dotGeo = new CircleGeometry(0.2, 20);
const ringGeo = new RingGeometry(0.3, 0.4, 28);

/** A corner dot, or with `ring` the snapping cursor: a ring around a dot on the grid vertex the pointer is closest to. */
function Dot({ at, ring = false, bad = false }: { at: Vec2; ring?: boolean; bad?: boolean }) {
  return (
    <group position={[at.x, 0.1, at.z]} rotation-x={-Math.PI / 2}>
      <mesh geometry={dotGeo} material={bad ? MATERIALS.railRed : MATERIALS.dot} renderOrder={13} userData={{ probe: ring ? 'snap-dot' : 'corner-dot', x: at.x, z: at.z }} />
      {ring && <mesh geometry={ringGeo} material={bad ? MATERIALS.railRed : MATERIALS.rail} renderOrder={12} />}
    </group>
  );
}

function EdgeLabel({ a, b, meters, bad = false }: { a: Vec2; b: Vec2; meters: number; bad?: boolean }) {
  return (
    <Html position={[(a.x + b.x) / 2, 0.25, (a.z + b.z) / 2]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`bh-edge${bad ? ' bad' : ''}`} data-testid="edge-length">
        {meters} m
      </div>
    </Html>
  );
}

const paintMaterials = new Map<string, MeshBasicMaterial>();
/** The swatch's own color, nearly solid so the surface reads as already painted. Flat floor previews draw through walls. */
function swatchMaterial(color: string, ok: boolean, flat: boolean): MeshBasicMaterial {
  const key = `${color}${ok}${flat}`;
  let m = paintMaterials.get(key);
  if (!m) paintMaterials.set(key, (m = new MeshBasicMaterial({ color: ok ? color : RED, transparent: true, opacity: 0.88, depthWrite: false, depthTest: !flat, side: DoubleSide })));
  return m;
}
const OUTLINE_OK = basic(WHITE, 1, false);
const OUTLINE_BAD = basic(RED, 1, false);

// Floor tiles in the paint's color, ringed by an outline along the edges that face unpainted ground.
function PaintTiles({ tiles, color, ok }: { tiles: readonly Vec2[]; color: string; ok: boolean }) {
  const edge = useMemo(() => {
    const has = new Set(tiles.map((t) => `${t.x},${t.z}`));
    const pos: number[] = [];
    const h = 0.04;
    const bar = (x0: number, z0: number, x1: number, z1: number) => pos.push(x0, 0, z0, x0, 0, z1, x1, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z1);
    for (const t of tiles) {
      if (!has.has(`${t.x},${t.z - 1}`)) bar(t.x - h, t.z - h, t.x + 1 + h, t.z + h);
      if (!has.has(`${t.x},${t.z + 1}`)) bar(t.x - h, t.z + 1 - h, t.x + 1 + h, t.z + 1 + h);
      if (!has.has(`${t.x - 1},${t.z}`)) bar(t.x - h, t.z - h, t.x + h, t.z + 1 + h);
      if (!has.has(`${t.x + 1},${t.z}`)) bar(t.x + 1 - h, t.z - h, t.x + 1 + h, t.z + 1 + h);
    }
    return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pos, 3));
  }, [tiles]);
  return (
    <>
      <Tiles tiles={tiles} material={swatchMaterial(color, ok, true)} probe={{ probe: 'paint-preview', surface: 'floor', tiles: tiles.length }} />
      <mesh geometry={edge} material={ok ? OUTLINE_OK : OUTLINE_BAD} position-y={0.03} renderOrder={11} />
    </>
  );
}

function Post({ at }: { at: Vec2 }) {
  return (
    <group position={[at.x, 0, at.z]}>
      <mesh position-y={(STORY_H + 0.35) / 2} material={MATERIALS.post}>
        <cylinderGeometry args={[0.045, 0.045, STORY_H + 0.35, 10]} />
      </mesh>
      <mesh position-y={STORY_H + 0.38} material={MATERIALS.post}>
        <sphereGeometry args={[0.1, 12, 10]} />
      </mesh>
      <mesh position-y={0.12} rotation-x={Math.PI} material={MATERIALS.post}>
        <coneGeometry args={[0.1, 0.22, 10]} />
      </mesh>
    </group>
  );
}

function Tiles({ tiles, material, probe }: { tiles: readonly Vec2[]; material: MeshBasicMaterial; probe?: Record<string, unknown> }) {
  const geo = useMemo(() => {
    const g = new BufferGeometry();
    const pos: number[] = [];
    for (const t of tiles) pos.push(t.x, 0.05, t.z, t.x, 0.05, t.z + 1, t.x + 1, 0.05, t.z, t.x + 1, 0.05, t.z, t.x, 0.05, t.z + 1, t.x + 1, 0.05, t.z + 1);
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    return g;
  }, [tiles]);
  return <mesh geometry={geo} material={material} renderOrder={6} userData={probe} />;
}

const BORDER = 0.06;
const ITEM_BORDER = 0.15;

// `ink` adds a dark stroke just outside the border: the coloured border then shows on pale floors as well as dark ones.
function Rect({ x0, z0, x1, z1, color, fill, border = BORDER, ink = false, probe }: { x0: number; z0: number; x1: number; z1: number; color: string; fill: MeshBasicMaterial | null; border?: number; ink?: boolean; probe?: Record<string, unknown> }) {
  const edge = useMemo(() => new MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false }), [color]);
  const w = x1 - x0;
  const d = z1 - z0;
  const bar = (x: number, z: number, bw: number, bd: number, material = edge, y = 0.07, order = 10) => (
    <mesh position={[x, y, z]} rotation-x={-Math.PI / 2} material={material} renderOrder={order}>
      <planeGeometry args={[bw, bd]} />
    </mesh>
  );
  const outline = (grow: number, material: MeshBasicMaterial, y: number, order: number) => (
    <>
      {bar((x0 + x1) / 2, z0, w + border + 2 * grow, border + 2 * grow, material, y, order)}
      {bar((x0 + x1) / 2, z1, w + border + 2 * grow, border + 2 * grow, material, y, order)}
      {bar(x0, (z0 + z1) / 2, border + 2 * grow, d + 2 * grow, material, y, order)}
      {bar(x1, (z0 + z1) / 2, border + 2 * grow, d + 2 * grow, material, y, order)}
    </>
  );
  return (
    <group>
      {fill && (
        <mesh position={[(x0 + x1) / 2, 0.05, (z0 + z1) / 2]} rotation-x={-Math.PI / 2} material={fill} renderOrder={6} userData={probe}>
          <planeGeometry args={[w, d]} />
        </mesh>
      )}
      {ink && outline(0.07, MATERIALS.keyline, 0.065, 9)}
      {outline(0, edge, 0.07, 10)}
    </group>
  );
}

// Which side of the item people use it from: the chair side of a desk, else the +z face the models are drawn toward.
function frontOf(item: Item): { at: Vec2; yaw: number } {
  const def = ITEM_DEFS[item.def];
  const c = { x: def.w / 2, z: def.d / 2 };
  let dir = { x: 0, z: 1 };
  if (def.seat) {
    const dx = def.seat.exit.x - c.x;
    const dz = def.seat.exit.z - c.z;
    dir = Math.abs(dx) > Math.abs(dz) ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) };
  }
  const reach = (Math.abs(dir.x) * def.w + Math.abs(dir.z) * def.d) / 2 + 0.7;
  const p0 = rotateLocal(def, item.rot, c);
  const p1 = rotateLocal(def, item.rot, { x: c.x + dir.x * reach, z: c.z + dir.z * reach });
  return { at: { x: (item.x + p1.x) / 2, z: (item.z + p1.z) / 2 }, yaw: Math.atan2(p1.z - p0.z, p1.x - p0.x) };
}

const arrowShape = (() => {
  const s = new Shape();
  s.moveTo(0.34, 0);
  s.lineTo(-0.2, 0.3);
  s.lineTo(-0.2, -0.3);
  s.closePath();
  return s;
})();

const turnRing = new RingGeometry(0.16, 0.24, 28, 1, 0.5, Math.PI * 1.45);
const turnHead = (() => {
  const t = new Shape();
  t.moveTo(0.2, -0.02);
  t.lineTo(0.37, 0.1);
  t.lineTo(0.06, 0.16);
  t.closePath();
  return t;
})();

const discRim = new RingGeometry(0.46, 0.55, 28);

// The curved arrow that says this piece turns: the keys , and . and the Turn button do it. It sits on the ghost's back
// right corner, half on the footprint, in the verdict's colour, and grows with the piece: a plant gets a small one.
function TurnMark({ box, ok }: { box: { x0: number; z0: number; x1: number; z1: number }; ok: boolean }) {
  const radius = Math.min(0.9, Math.max(0.26, Math.min(box.x1 - box.x0, box.z1 - box.z0) * 0.3));
  const at = { x: box.x1, z: box.z0 };
  return (
    <group position={[at.x, 0.09, at.z]} rotation-x={-Math.PI / 2} scale={radius / 0.46} userData={{ probe: 'turn-mark', ...at, r: radius, ok }}>
      <mesh geometry={discRim} material={ok ? MATERIALS.arrowGreen : MATERIALS.arrowRed} renderOrder={10} />
      <mesh material={MATERIALS.turnDisc} renderOrder={11}>
        <circleGeometry args={[0.46, 24]} />
      </mesh>
      <mesh geometry={turnRing} material={MATERIALS.turnArrow} renderOrder={12} />
      <mesh material={MATERIALS.turnArrow} renderOrder={12}>
        <shapeGeometry args={[turnHead]} />
      </mesh>
    </group>
  );
}

// The piece itself, tinted by the verdict, outlined, and again through whatever stands in front of it.
function ItemModel({ item, ok }: { item: Item; ok: boolean }) {
  const f = footprint(ITEM_DEFS[item.def], item.rot);
  const at: [number, number, number] = [item.x / 2 + f.w / 4, 0, item.z / 2 + f.d / 4];
  const hull = hullOf(item.def);
  return (
    <>
      <mesh geometry={hull} material={RIM.ink} position={at} rotation-y={YAW[item.rot]} renderOrder={6} />
      <mesh geometry={hull} material={ok ? RIM.ok : RIM.bad} position={at} rotation-y={YAW[item.rot]} renderOrder={7} userData={{ probe: 'ghost-rim', ok }} />
      <mesh geometry={modelOf(item.def)} material={ok ? XRAY_OK : XRAY_BAD} position={at} rotation-y={YAW[item.rot]} renderOrder={8} />
      <mesh geometry={modelOf(item.def)} material={ok ? MODEL_OK : MODEL_BAD} position={at} rotation-y={YAW[item.rot]} renderOrder={9} />
    </>
  );
}

const CAGE_HEIGHT = 2.4;
const CAGE_EDGE = 0.07;
function Cage({ x0, z0, x1, z1, color }: { x0: number; z0: number; x1: number; z1: number; color: string }) {
  const material = useMemo(() => new MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false }), [color]);
  const w = x1 - x0;
  const d = z1 - z0;
  const edge = (key: string, at: [number, number, number], size: [number, number, number]) => (
    <mesh key={key} position={at} material={material} renderOrder={10}>
      <boxGeometry args={size} />
    </mesh>
  );
  return (
    <group>
      {[0, CAGE_HEIGHT].flatMap((y) => [
        edge(`n${y}`, [(x0 + x1) / 2, y, z0], [w + CAGE_EDGE, CAGE_EDGE, CAGE_EDGE]),
        edge(`s${y}`, [(x0 + x1) / 2, y, z1], [w + CAGE_EDGE, CAGE_EDGE, CAGE_EDGE]),
        edge(`w${y}`, [x0, y, (z0 + z1) / 2], [CAGE_EDGE, CAGE_EDGE, d + CAGE_EDGE]),
        edge(`e${y}`, [x1, y, (z0 + z1) / 2], [CAGE_EDGE, CAGE_EDGE, d + CAGE_EDGE]),
      ])}
      {[[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([x, z]) => edge(`p${x},${z}`, [x, CAGE_HEIGHT / 2, z], [CAGE_EDGE, CAGE_HEIGHT, CAGE_EDGE]))}
    </group>
  );
}

function BlockGhost({ items, ok }: { items: readonly Item[]; ok: boolean }) {
  const box = cellBounds(items);
  if (!box) return null;
  const [x0, z0, x1, z1] = [box.x0 / 2, box.z0 / 2, box.x1 / 2, box.z1 / 2];
  return (
    <>
      <Rect x0={x0} z0={z0} x1={x1} z1={z1} color={tone(ok)} fill={ok ? MATERIALS.padGreen : MATERIALS.padRed} border={ITEM_BORDER} ink probe={{ probe: 'block-footprint', ok, x0, z0, w: x1 - x0, d: z1 - z0, pieces: items.length }} />
      <Cage x0={x0} z0={z0} x1={x1} z1={z1} color={tone(ok)} />
      <TurnMark box={{ x0, z0, x1, z1 }} ok={ok} />
      {items.map((item) => (
        <ItemModel key={item.id} item={item} ok={ok} />
      ))}
    </>
  );
}

function BlockSelect({ items }: { items: readonly Item[] }) {
  const box = cellBounds(items);
  if (!box) return null;
  return (
    <>
      <Cage x0={box.x0 / 2} z0={box.z0 / 2} x1={box.x1 / 2} z1={box.z1 / 2} color={WHITE} />
      <mesh position={[(box.x0 + box.x1) / 4, 0.05, (box.z0 + box.z1) / 4]} rotation-x={-Math.PI / 2} material={MATERIALS.fillWhite} renderOrder={5} userData={{ probe: 'block-select', pieces: items.length, w: (box.x1 - box.x0) / 2, d: (box.z1 - box.z0) / 2 }}>
        <planeGeometry args={[(box.x1 - box.x0) / 2, (box.z1 - box.z0) / 2]} />
      </mesh>
      {items.map((item) => (
        <ItemGhost key={item.id} item={item} ok outline />
      ))}
    </>
  );
}

function ItemGhost({ item, ok, outline }: { item: Item; ok: boolean; outline: boolean }) {
  const def = ITEM_DEFS[item.def];
  const f = footprint(def, item.rot);
  const x0 = item.x / 2;
  const z0 = item.z / 2;
  const x1 = x0 + f.w / 2;
  const z1 = z0 + f.d / 2;
  const front = useMemo(() => frontOf(item), [item]);
  const color = outline ? WHITE : tone(ok);
  return (
    <>
      <Rect x0={x0} z0={z0} x1={x1} z1={z1} color={color} fill={outline ? null : ok ? MATERIALS.padGreen : MATERIALS.padRed} border={ITEM_BORDER} ink={!outline} probe={{ probe: 'footprint', ok, x0, z0, w: x1 - x0, d: z1 - z0 }} />
      {!outline && (
        <>
          {ITEM_DEFS[item.def].kind !== 'stairs' && <TurnMark box={{ x0, z0, x1, z1 }} ok={ok} />}
          <ItemModel item={item} ok={ok} />
          <mesh position={[front.at.x, 0.07, front.at.z]} rotation={[-Math.PI / 2, 0, front.yaw]} material={ok ? MATERIALS.arrowGreen : MATERIALS.arrowRed} renderOrder={7}>
            <shapeGeometry args={[arrowShape]} />
          </mesh>
        </>
      )}
    </>
  );
}

// Where the stairs will cut through the floor above: the hole tiles in amber and the landing the stairs arrive on.
function StairHole({ item }: { item: Item }) {
  const info = stairsInfo(item, ITEM_DEFS[item.def]);
  const landing = info.landing;
  return (
    <group position-y={STORY_H}>
      <Tiles tiles={info.holeTiles.map((t) => ({ x: t.tx, z: t.tz }))} material={MATERIALS.hole} />
      <Rect x0={landing.tx} z0={landing.tz} x1={landing.tx + 1} z1={landing.tz + 1} color={GREEN} fill={MATERIALS.landing} probe={{ probe: 'stair-hole', tiles: info.holeTiles.length }} />
    </group>
  );
}

function Shown({ g, level, stories }: { g: Ghost; level: number; stories: number }) {
  switch (g.kind) {
    case 'vertex':
      return (
        <>
          <Dot at={g.at} ring />
          <Post at={g.at} />
        </>
      );
    case 'run': {
      if (!g.refs.length) {
        return (
          <>
            <Dot at={g.end} ring />
            <Post at={g.end} />
          </>
        );
      }
      const bad = g.erase || !g.ok;
      const mat = bad ? MATERIALS.wallErase : MATERIALS.wall;
      return (
        <>
          <Strip a={g.start} b={g.end} bad={bad} />
          <WallBox a={g.start} b={g.end} material={mat} bad={bad} />
          <Dot at={g.start} ring bad={bad} />
          <Dot at={g.end} ring bad={bad} />
          <Post at={g.end} />
          <EdgeLabel a={g.start} b={g.end} meters={g.refs.length} bad={bad} />
        </>
      );
    }
    case 'room': {
      const { x, z, w, h } = g.rect;
      const mat = g.ok ? MATERIALS.wall : MATERIALS.wallErase;
      const bad = !g.ok;
      const a = { x, z };
      const b = { x: x + w, z };
      const c = { x: x + w, z: z + h };
      const d = { x, z: z + h };
      return (
        <>
          <Tiles tiles={Array.from({ length: w * h }, (_, i) => ({ x: x + (i % w), z: z + Math.floor(i / w) }))} material={g.ok ? MATERIALS.fillWhite : MATERIALS.fillRed} />
          {[[a, b, w], [b, c, h], [c, d, w], [d, a, h]].map(([p, q, n]) => (
            <group key={`${(p as Vec2).x},${(p as Vec2).z}`}>
              <Strip a={p as Vec2} b={q as Vec2} bad={bad} />
              <WallBox a={p as Vec2} b={q as Vec2} material={mat} bad={bad} />
              <EdgeLabel a={p as Vec2} b={q as Vec2} meters={n as number} bad={bad} />
            </group>
          ))}
          {[a, b, d].map((p) => <Dot key={`${p.x},${p.z}`} at={p} bad={bad} />)}
          <Dot at={c} ring bad={bad} />
          <Post at={c} />
        </>
      );
    }
    case 'tiles':
      return g.color ? <PaintTiles tiles={g.tiles} color={g.color} ok={g.ok} /> : <Tiles tiles={g.tiles} material={g.ok ? MATERIALS.fillGreen : MATERIALS.fillRed} />;
    case 'walls':
      return (
        <>
          {g.walls.map((w) => (
            <WallBox
              key={`${w.d}${w.x},${w.z}`}
              a={{ x: w.x, z: w.z }}
              b={w.d === 'e' ? { x: w.x + 1, z: w.z } : { x: w.x, z: w.z + 1 }}
              material={g.color ? swatchMaterial(g.color, g.ok, false) : g.ok ? MATERIALS.wallGreen : MATERIALS.wallRed}
              probe={g.color ? { probe: 'paint-preview', surface: 'wall' } : undefined}
              capped={false}
            />
          ))}
        </>
      );
    case 'item':
      return (
        <>
          <ItemGhost item={g.item} ok={g.ok} outline={false} />
          {ITEM_DEFS[g.item.def].stairs && stories > level + 1 && <StairHole item={g.item} />}
        </>
      );
    case 'outline':
      return <ItemGhost item={g.item} ok outline />;
    case 'block':
      return <BlockGhost items={g.items} ok={g.ok} />;
    case 'blockSelect':
      return <BlockSelect items={g.items} />;
  }
}

export function GhostLayer() {
  const size = useThree((t) => t.size);
  useEffect(() => {
    RESOLUTION.value.set(size.width, size.height);
  }, [size]);
  const level = useStore((s) => s.build?.level ?? 0);
  const stories = useStore((s) => s.building?.stories.length ?? 1);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [seen, setSeen] = useState(-1);
  useFrame(() => {
    if (draft.version === seen) return;
    setSeen(draft.version);
    setGhost(draft.ghost);
  });
  if (!ghost) return null;
  return (
    <group position-y={level * STORY_H}>
      <Shown g={ghost} level={level} stories={stories} />
    </group>
  );
}
