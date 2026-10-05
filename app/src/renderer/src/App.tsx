import { Drawer } from './hud/Drawer.tsx';
import { EmployeeMenu } from './hud/EmployeeMenu.tsx';
import { Modals } from './hud/Modals.tsx';
import { ComputerPrompt, HelpOverlay, Toasts, WaitingMeter } from './hud/Panels.tsx';
import { Bottom } from './hud/Talk.tsx';
import { UpdateChip } from './hud/UpdateControl.tsx';
import { ComputerMenu, MacPortal } from './hud/MacPortal.tsx';
import { CameraToggle } from './hud/CameraToggle.tsx';
import { Clock } from './hud/Clock.tsx';
import { ResizableHud } from './hud/ResizableHud.tsx';
import { Scene } from './scene/Scene.tsx';
import { useStore } from './store.ts';
import { testRun } from './testRun.ts';

// Each kind of dialog remembers its own place and size; `key` gives the wrapper a fresh pose when the kind changes.
function ModalsHud() {
  const kind = useStore((s) => s.modal?.kind ?? 'none');
  return <ResizableHud key={kind} itemKey={`modal-${kind}`}><Modals /></ResizableHud>;
}

export function App() {
  const portalMode = useStore((s) => s.portalMode);
  return (
    <>
      {testRun && <div className="test-banner">Automated test. This is not your office.</div>}
      <div className="stage" style={{ visibility: portalMode ? 'hidden' : 'visible' }}>
        <Scene />
      </div>
      <div className="hud" style={{ display: portalMode ? 'none' : undefined }}>
        <CameraToggle />
        <ResizableHud itemKey="clock"><Clock /></ResizableHud>
        <ResizableHud itemKey="waiting-meter"><WaitingMeter /></ResizableHud>
        <ResizableHud itemKey="update-chip"><UpdateChip /></ResizableHud>
        <ResizableHud itemKey="bottom-talk"><Bottom /></ResizableHud>
      </div>
      {portalMode && <MacPortal />}
      <ResizableHud itemKey="toasts"><Toasts /></ResizableHud>
      <ResizableHud itemKey="computer-prompt"><ComputerPrompt /></ResizableHud>
      <ResizableHud itemKey="drawer"><Drawer /></ResizableHud>
      <ModalsHud />
      <ResizableHud itemKey="employee-menu"><EmployeeMenu /></ResizableHud>
      <ResizableHud itemKey="help-overlay"><HelpOverlay /></ResizableHud>
      <ResizableHud itemKey="computer-menu"><ComputerMenu /></ResizableHud>
    </>
  );
}
