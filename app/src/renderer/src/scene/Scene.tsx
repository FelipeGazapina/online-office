import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import { setLabelLayer } from './labelLayer.ts';
import { useStore } from '../store.ts';
import { BuildingLayer } from './building/BuildingLayer.tsx';
import { BuildLayer } from './building/BuildLayer.tsx';
import { BlockView } from './BlockView.tsx';
import { CameraRig, SimDriver } from './CameraRig.tsx';
import { EmployeeView } from './EmployeeView.tsx';
import { Office } from './Office.tsx';
import { CrowdMeshes } from './people/CrowdMeshes.tsx';
import { OwnerView } from './OwnerView.tsx';
import { DeskAim } from './DeskAim.tsx';
import { setPickView } from './pickView.ts';
import { Staged } from './Staged.tsx';
import { loadProps } from './props.ts';
import { warmFirstDraw } from './warmup.ts';
import { WalkMarker } from './WalkMarker.tsx';

function PickView() {
  const { camera, gl } = useThree();
  useEffect(() => {
    setPickView(camera, gl.domElement);
    return () => setPickView(null, null);
  }, [camera, gl]);
  return null;
}

// The render loop waits for this: the first draw would otherwise block the main thread while the GPU links the programs and
// takes the textures. It mounts once the company and the building have arrived, so the scene it compiles is the whole office.
function FirstDraw({ onReady }: { onReady: () => void }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    let live = true;
    void warmFirstDraw(gl, scene, camera).then(() => live && onReady());
    return () => {
      live = false;
    };
  }, [gl, scene, camera, onReady]);
  return null;
}

function World({ onReady }: { onReady: () => void }) {
  use(loadProps());
  const company = useStore((s) => s.company);
  const built = useStore((s) => s.building !== null);
  return (
    <>
      <PickView />
      <SimDriver />
      <CameraRig />
      <Staged>
        <BuildingLayer />
        <BuildLayer />
        <Office company={company} />
        <>
          {company?.blocks.map((b) => (
            <BlockView key={b.id} block={b} employees={company.employees.filter((e) => e.blockId === b.id)} />
          ))}
        </>
        <CrowdMeshes />
        <OwnerView />
        <WalkMarker />
        <DeskAim />
        <>
          {company?.employees.map((e) => (
            <EmployeeView key={e.id} employee={e} />
          ))}
        </>
      </Staged>
      {company && built && <FirstDraw onReady={onReady} />}
    </>
  );
}

// Keep the office responsive on high-DPI displays and when macOS enters a
// battery or system-load constrained state. Quality changes only after a
// sustained average, so one slow frame never causes visible oscillation.
function AdaptiveQuality() {
  const { gl } = useThree();
  type Battery = { charging: boolean; level: number; addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void };
  const quality = useRef({ dpr: Math.min(1.5, gl.getPixelRatio()), slow: 0, fast: 0, samples: 0, total: 0 });

  useEffect(() => {
    const batteryApi = navigator as Navigator & {
      getBattery?: () => Promise<Battery>;
    };
    let battery: Battery | undefined;
    const applyPowerState = () => {
      if (battery && !battery.charging && battery.level < 0.35 && quality.current.dpr > 1) {
        quality.current.dpr = 1;
        gl.setPixelRatio(1);
      }
    };
    let onChange: (() => void) | undefined;
    void batteryApi.getBattery?.().then((value) => {
      battery = value;
      onChange = applyPowerState;
      value.addEventListener?.('chargingchange', onChange);
      value.addEventListener?.('levelchange', onChange);
      applyPowerState();
    });
    return () => {
      if (battery && onChange) {
        battery.removeEventListener?.('chargingchange', onChange);
        battery.removeEventListener?.('levelchange', onChange);
      }
    };
  }, [gl]);

  useFrame((_, dt) => {
    const state = quality.current;
    state.total += Math.min(dt, 0.1);
    if (++state.samples < 30) return;
    const average = state.total / state.samples;
    state.samples = 0;
    state.total = 0;
    if (average > 0.024) {
      state.slow++;
      state.fast = 0;
    } else if (average < 0.016) {
      state.fast++;
      state.slow = 0;
    } else {
      state.slow = 0;
      state.fast = 0;
    }
    if (state.slow >= 2 && state.dpr > 1) {
      state.dpr = Math.max(1, state.dpr - 0.25);
      gl.setPixelRatio(state.dpr);
      state.slow = 0;
    } else if (state.fast >= 4 && state.dpr < 1.5) {
      state.dpr = Math.min(1.5, state.dpr + 0.25);
      gl.setPixelRatio(state.dpr);
      state.fast = 0;
    }
  }, -3);
  return null;
}

// R3F draws after its useFrame callbacks unless a callback with a priority above zero takes the draw over, as this one does, so the
// first draw can wait for the GPU while the simulation, the camera and every other callback keep running as they always did.
function Draw({ ready }: { ready: boolean }) {
  const { gl, scene, camera } = useThree();
  useFrame(() => {
    if (!ready) return;
    if (!performance.getEntriesByName('office-first-frame').length) performance.mark('office-first-frame');
    gl.render(scene, camera);
  }, 1);
  return null;
}

// If the GPU or the main process never answers, the office draws anyway after this long.
const WARMUP_LIMIT_MS = 4000;

export function Scene() {
  const [warm, setWarm] = useState(false);
  const open = useCallback(() => setWarm(true), []);
  useEffect(() => {
    const limit = setTimeout(open, WARMUP_LIMIT_MS);
    return () => clearTimeout(limit);
  }, [open]);
  return (
    <>
      <div className="labels" ref={setLabelLayer} />
      <Canvas
        shadows="percentage"
        // A 2x backing buffer quadruples fragment work. Cap it at 1.5x so high-DPI
        // displays do not turn a modest office scene into a fill-rate bottleneck.
        dpr={[1, 1.5]}
        camera={{ fov: 55, near: 0.1, far: 220, position: [-10, 6, 12] }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <color attach="background" args={['#f1d9bd']} />
        <AdaptiveQuality />
        <Draw ready={warm} />
        <Suspense fallback={null}>
          <World onReady={open} />
        </Suspense>
      </Canvas>
    </>
  );
}
