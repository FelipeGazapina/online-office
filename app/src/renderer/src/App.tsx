import { Drawer } from './hud/Drawer.tsx';
import { EmployeeMenu } from './hud/EmployeeMenu.tsx';
import { Modals } from './hud/Modals.tsx';
import { CompanyPanel, HelpOverlay, SettingsPanel, Toasts, WaitingMeter } from './hud/Panels.tsx';
import { Bottom } from './hud/Talk.tsx';
import { Scene } from './scene/Scene.tsx';
import { testRun } from './testRun.ts';

export function App() {
  return (
    <>
      {testRun && <div className="test-banner">Automated test. This is not your office.</div>}
      <div className="stage">
        <Scene />
      </div>
      <div className="hud">
        <CompanyPanel />
        <WaitingMeter />
        <SettingsPanel />
        <Bottom />
        <Toasts />
        <Drawer />
      </div>
      <Modals />
      <EmployeeMenu />
      <HelpOverlay />
    </>
  );
}
