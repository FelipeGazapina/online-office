// The main process opens the page with ?test when the test driver launched the app. That window is not the owner's
// office, so it says so. Clicks are left alone: tests send real mouse events through DevTools.
export const testRun = new URLSearchParams(location.search).has('test');

export function installTestRun() {
  if (!testRun) return;
  document.title = 'Online Office (automated test)';
  document.documentElement.classList.add('test-run');
}
