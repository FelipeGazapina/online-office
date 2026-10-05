import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { setLabelLayer } from './labelLayer.ts';
import { useStore } from '../store.ts';
import { ArrangeOverlay } from './Arrange.tsx';
import { BlockView } from './BlockView.tsx';
import { CameraRig, SimDriver } from './CameraRig.tsx';
import { EmployeeView } from './EmployeeView.tsx';
import { Office } from './Office.tsx';
import { OwnerView } from './OwnerView.tsx';
import { WalkMarker } from './WalkMarker.tsx';

function World() {
  const company = useStore((s) => s.company);
  const arranging = useStore((s) => s.arranging);
  return (
    <>
      <SimDriver />
      <CameraRig />
      <Office company={company} />
      {company?.blocks.map((b) => (
        <BlockView key={b.id} block={b} employees={company.employees.filter((e) => e.blockId === b.id)} place={arranging?.blockId === b.id ? arranging.place : undefined} />
      ))}
      {arranging && <ArrangeOverlay arranging={arranging} />}
      <OwnerView />
      <WalkMarker />
      {company?.employees.map((e) => (
        <EmployeeView key={e.id} employee={e} />
      ))}
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

export function Scene() {
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
        <color attach="background" args={['#2a2530']} />
        <AdaptiveQuality />
        <World />
      </Canvas>
    </>
  );
}
