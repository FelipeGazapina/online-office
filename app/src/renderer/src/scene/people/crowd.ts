import type { Object3D } from 'three';

export type Look = { body: string; skin: string; hair: string; trim?: string };

export type Joints = {
  root: Object3D;
  body: Object3D;
  head: Object3D;
  armL: Object3D;
  armR: Object3D;
  legL: Object3D;
  legR: Object3D;
};

// What the instanced renderer needs to draw one person. Person owns the entry for as long as it is mounted.
export type CrowdEntry = {
  joints: Joints;
  look: Look;
  hidden: boolean;
  // Advances the animation for this frame and moves the joints. The crowd draws right after, from the joints.
  update: (time: number, dt: number) => void;
  onPick?: (at: { x: number; y: number }) => void;
};

export const crowd = new Set<CrowdEntry>();
