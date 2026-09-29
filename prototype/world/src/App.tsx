import { Drawer } from './hud/Drawer.tsx';
import { Modals } from './hud/Modals.tsx';
import { CompanyPanel, HelpOverlay, OfflineCard, OfflineScrim, SettingsPanel, Toasts, WaitingMeter } from './hud/Panels.tsx';
import { Bottom } from './hud/Talk.tsx';
import { Scene } from './scene/Scene.tsx';

export function App() {
  return (
    <>
      <div className="stage">
        <Scene />
      </div>
      <OfflineScrim />
      <div className="hud">
        <CompanyPanel />
        <WaitingMeter />
        <SettingsPanel />
        <Bottom />
        <Toasts />
        <Drawer />
      </div>
      <OfflineCard />
      <Modals />
      <HelpOverlay />
    </>
  );
}
