// The translucent preview of what the current tool would build: a wall with a handle at its free end, a whole room, the
// tiles about to be painted, the wall about to get a door, or the furniture with its footprint and a front arrow.
// Green means the building's own rules accept it, red means they do not. Nothing here decides; BuildInput does.
import { useFrame } from '@react-three/fiber';
import { Edges } from '@react-three/drei';
import { useMemo, useState } from 'react';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, MeshBasicMaterial, MeshStandardMaterial, Shape } from 'three';
import { ITEM_DEFS, STORY_H, WALL_HALF, YAW, footprint, rotateLocal, type Item, type Vec2 } from '../../../../shared/space/index.ts';
import { draft, type Ghost } from '../../hud/build/state.ts';
import { useStore } from '../../store.ts';
import { modelOf } from './models.ts';

const GREEN = '#2fe06a';
const RED = '#ff4d4d';
const WHITE = '#ffffff';
const tone = (ok: boolean) => (ok ? GREEN : RED);

// The footprint and the arrow draw through walls and furniture: a ghost inside a room has to stay readable from outside.
const basic = (color: string, opacity: number, depthTest = true) => new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest, side: DoubleSide });
const MATERIALS = {
  wall: basic(WHITE, 0.4),
  wallErase: basic(RED, 0.5),
  wallGreen: basic(GREEN, 0.5),
  wallRed: basic(RED, 0.5),
  fillWhite: basic(WHITE, 0.28),
  fillGreen: basic(GREEN, 0.4),
  fillRed: basic(RED, 0.42),
  padGreen: basic(GREEN, 0.5, false),
  padRed: basic(RED, 0.52, false),
  post: basic(WHITE, 0.95),
  arrowGreen: basic(GREEN, 0.95, false),
  arrowRed: basic(RED, 0.95, false),
};
const ghostModel = (ok: boolean, depthTest: boolean) =>
  new MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: depthTest ? 0.85 : 0.28, emissive: ok ? GREEN : RED, emissiveIntensity: 0.35, depthWrite: false, depthTest });
const MODEL_OK = ghostModel(true, true);
const MODEL_BAD = ghostModel(false, true);
const XRAY_OK = ghostModel(true, false);
const XRAY_BAD = ghostModel(false, false);

const T = WALL_HALF * 2 + 0.04;

function WallBox({ a, b, material }: { a: Vec2; b: Vec2; material: MeshBasicMaterial }) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  return (
    <mesh position={[(a.x + b.x) / 2, STORY_H / 2, (a.z + b.z) / 2]} rotation-y={Math.atan2(-(b.z - a.z), b.x - a.x)} material={material} renderOrder={6}>
      <boxGeometry args={[len + T, STORY_H, T]} />
      <Edges color="white" threshold={20} />
    </mesh>
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

function Tiles({ tiles, material }: { tiles: readonly Vec2[]; material: MeshBasicMaterial }) {
  const geo = useMemo(() => {
    const g = new BufferGeometry();
    const pos: number[] = [];
    for (const t of tiles) pos.push(t.x, 0.05, t.z, t.x, 0.05, t.z + 1, t.x + 1, 0.05, t.z, t.x + 1, 0.05, t.z, t.x, 0.05, t.z + 1, t.x + 1, 0.05, t.z + 1);
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    return g;
  }, [tiles]);
  return <mesh geometry={geo} material={material} renderOrder={6} />;
}

const BORDER = 0.06;

function Rect({ x0, z0, x1, z1, color, fill }: { x0: number; z0: number; x1: number; z1: number; color: string; fill: MeshBasicMaterial | null }) {
  const edge = useMemo(() => new MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false }), [color]);
  const w = x1 - x0;
  const d = z1 - z0;
  const bar = (x: number, z: number, bw: number, bd: number) => (
    <mesh position={[x, 0.07, z]} rotation-x={-Math.PI / 2} material={edge} renderOrder={10}>
      <planeGeometry args={[bw, bd]} />
    </mesh>
  );
  return (
    <group>
      {fill && (
        <mesh position={[(x0 + x1) / 2, 0.05, (z0 + z1) / 2]} rotation-x={-Math.PI / 2} material={fill} renderOrder={6}>
          <planeGeometry args={[w, d]} />
        </mesh>
      )}
      {bar((x0 + x1) / 2, z0, w + BORDER, BORDER)}
      {bar((x0 + x1) / 2, z1, w + BORDER, BORDER)}
      {bar(x0, (z0 + z1) / 2, BORDER, d)}
      {bar(x1, (z0 + z1) / 2, BORDER, d)}
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
      <Rect x0={x0} z0={z0} x1={x1} z1={z1} color={color} fill={outline ? null : ok ? MATERIALS.padGreen : MATERIALS.padRed} />
      {!outline && (
        <>
          <mesh geometry={modelOf(item.def)} material={ok ? XRAY_OK : XRAY_BAD} position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]} rotation-y={YAW[item.rot]} renderOrder={8} />
          <mesh geometry={modelOf(item.def)} material={ok ? MODEL_OK : MODEL_BAD} position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]} rotation-y={YAW[item.rot]} renderOrder={9} />
          <mesh position={[front.at.x, 0.07, front.at.z]} rotation={[-Math.PI / 2, 0, front.yaw]} material={ok ? MATERIALS.arrowGreen : MATERIALS.arrowRed} renderOrder={7}>
            <shapeGeometry args={[arrowShape]} />
          </mesh>
        </>
      )}
    </>
  );
}

function Shown({ g }: { g: Ghost }) {
  switch (g.kind) {
    case 'vertex':
      return <Post at={g.at} />;
    case 'run': {
      if (!g.refs.length) return <Post at={g.end} />;
      const mat = g.erase || !g.ok ? MATERIALS.wallErase : MATERIALS.wall;
      return (
        <>
          <WallBox a={g.start} b={g.end} material={mat} />
          <Post at={g.end} />
        </>
      );
    }
    case 'room': {
      const { x, z, w, h } = g.rect;
      const mat = g.ok ? MATERIALS.wall : MATERIALS.wallErase;
      const a = { x, z };
      const b = { x: x + w, z };
      const c = { x: x + w, z: z + h };
      const d = { x, z: z + h };
      return (
        <>
          <Tiles tiles={Array.from({ length: w * h }, (_, i) => ({ x: x + (i % w), z: z + Math.floor(i / w) }))} material={g.ok ? MATERIALS.fillWhite : MATERIALS.fillRed} />
          <WallBox a={a} b={b} material={mat} />
          <WallBox a={b} b={c} material={mat} />
          <WallBox a={c} b={d} material={mat} />
          <WallBox a={d} b={a} material={mat} />
          <Post at={c} />
        </>
      );
    }
    case 'tiles':
      return <Tiles tiles={g.tiles} material={g.ok ? MATERIALS.fillGreen : MATERIALS.fillRed} />;
    case 'walls':
      return (
        <>
          {g.walls.map((w) => (
            <WallBox
              key={`${w.d}${w.x},${w.z}`}
              a={{ x: w.x, z: w.z }}
              b={w.d === 'e' ? { x: w.x + 1, z: w.z } : { x: w.x, z: w.z + 1 }}
              material={g.ok ? MATERIALS.wallGreen : MATERIALS.wallRed}
            />
          ))}
        </>
      );
    case 'item':
      return <ItemGhost item={g.item} ok={g.ok} outline={false} />;
    case 'outline':
      return <ItemGhost item={g.item} ok outline />;
  }
}

export function GhostLayer() {
  const level = useStore((s) => s.build?.level ?? 0);
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
      <Shown g={ghost} />
    </group>
  );
}
