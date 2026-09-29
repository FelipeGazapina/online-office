import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { installGestureUnlock } from './audio.ts';
import { installDebug } from './debug.ts';
import { installInput } from './input.ts';
import { startOffice } from './office.ts';
import { installTalk } from './talk.ts';
import { installTestRun } from './testRun.ts';
import './styles.css';

installTestRun();
installGestureUnlock();
installInput();
installDebug();
installTalk();
void startOffice();

createRoot(document.getElementById('root')!).render(<App />);
