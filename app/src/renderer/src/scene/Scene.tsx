import { Canvas } from '@react-three/fiber';
import { setLabelLayer } from './labelLayer.ts';
import { useStore } from '../store.ts';
import { BlockView } from './BlockView.tsx';
import { CameraRig, SimDriver } from './CameraRig.tsx';
import { EmployeeView } from './EmployeeView.tsx';
import { Office } from './Office.tsx';
import { OwnerView } from './OwnerView.tsx';
import { WalkMarker } from './WalkMarker.tsx';

function World() {
  const company = useStore((s) => s.company);
  return (
    <>
      <SimDriver />
      <CameraRig />
      <Office company={company} />
      {company?.blocks.map((b) => (
        <BlockView key={b.id} block={b} employees={company.employees.filter((e) => e.blockId === b.id)} />
      ))}
      <OwnerView />
      <WalkMarker />
      {company?.employees.map((e) => (
        <EmployeeView key={e.id} employee={e} />
      ))}
    </>
  );
}

export function Scene() {
  return (
    <>
      <div className="labels" ref={setLabelLayer} />
      <Canvas
        shadows="percentage"
        dpr={[1, 2]}
        camera={{ fov: 55, near: 0.1, far: 220, position: [-10, 6, 12] }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#2a2530']} />
        <World />
      </Canvas>
    </>
  );
}
