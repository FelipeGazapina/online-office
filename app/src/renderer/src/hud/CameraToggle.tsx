import { toggleCamera, useStore } from '../store.ts';

// Same switch as Tab. The button gives its focus back so Space and Enter keep meaning what they did.
export function CameraToggle() {
  const first = useStore((s) => s.camera === 'first');
  return (
    <button
      className="btn camera-toggle"
     
      title="Switch camera (Tab)"
      style={{ position: 'absolute', top: 12, left: 164, zIndex: 4 }}
      onClick={(e) => {
        toggleCamera();
        if (useStore.getState().camera === 'first') window.dispatchEvent(new Event('office:lock-pointer'));
        e.currentTarget.blur();
      }}
    >
      {first ? 'First person' : 'Isometric'} <span className="muted">Tab</span>
    </button>
  );
}
