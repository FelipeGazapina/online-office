import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { installGestureUnlock } from './audio.ts';
import { startBridge } from './bridge.ts';
import { startDemo } from './demo.ts';
import { installDebug } from './debug.ts';
import { installInput } from './input.ts';
import { installTalk } from './talk.ts';
import './styles.css';

installGestureUnlock();
installInput();
installDebug();
installTalk();
if (new URLSearchParams(location.search).has('demo')) startDemo();
else startBridge();

createRoot(document.getElementById('root')!).render(<App />);
