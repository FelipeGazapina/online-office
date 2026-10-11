// The laptop's desktop, once the camera is in its screen. It lies exactly on the screen the camera frames (the same framing the camera
// rig uses, from scene/laptopPose.ts) and shows the owner's Mac desktop. A sheet under it keeps clicks and the wheel off the office
// while the laptop is in the owner's hands.
import { useEffect, useState } from 'react';
import { useLaptop } from '../computer.ts';
import { zoomFrame } from '../scene/monitorPose.ts';
import { LAPTOP_FILL, SCREEN } from '../scene/laptopPose.ts';
import { MyMacDesktop } from './MacPortal.tsx';
import './laptop.css';

export function LaptopPanel() {
  const open = useLaptop((s) => s.open);
  const ready = useLaptop((s) => s.ready);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // The rest of the HUD steps back while the owner looks at the laptop.
  useEffect(() => {
    if (!open) return;
    document.body.dataset.laptop = 'open';
    return () => void delete document.body.dataset.laptop;
  }, [open]);
  if (!open) return null;
  const frame = zoomFrame(SCREEN, size.w / size.h, LAPTOP_FILL);
  const w = frame.width * size.w;
  const h = frame.height * size.h;
  return (
    <div className="laptop-sheet">
      <div className={ready ? 'laptop-frame ready' : 'laptop-frame'} style={{ width: w, height: h, left: (size.w - w) / 2, top: (size.h - h) / 2 }} aria-hidden={!ready}>
        {ready && <MyMacDesktop device="laptop" />}
      </div>
    </div>
  );
}
