import { Drawer } from './hud/Drawer.tsx';
import { EmployeeMenu } from './hud/EmployeeMenu.tsx';
import { Modals } from './hud/Modals.tsx';
import { ComputerPrompt, HelpOverlay, Toasts, WaitingMeter } from './hud/Panels.tsx';
import { Bottom } from './hud/Talk.tsx';
import { UpdateChip } from './hud/UpdateControl.tsx';
import { ComputerMenu, MacPortal } from './hud/MacPortal.tsx';
import { Scene } from './scene/Scene.tsx';
import { useStore } from './store.ts';
import { testRun } from './testRun.ts';

export function App() {
  const portalMode = useStore((s) => s.portalMode);
  return (
    <>
      {testRun && <div className="test-banner">Automated test. This is not your office.</div>}
      <div className="stage" style={{ visibility: portalMode ? 'hidden' : 'visible' }}>
        <Scene />
      </div>
      <div className="hud" style={{ display: portalMode ? 'none' : undefined }}>
        <WaitingMeter />
        <UpdateChip />
        <Bottom />
      </div>
      {portalMode && <MacPortal />}
      <Toasts />
      <ComputerPrompt />
      <Drawer />
      <Modals />
      <EmployeeMenu />
      <HelpOverlay />
      <ComputerMenu />
    </>
  );
}
