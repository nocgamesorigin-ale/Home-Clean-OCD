// Shapes of the data exported from the Unity level prefabs (tools/export_levels.py).

/** Reference to a GameObject (and optionally one of its components) inside the level. */
export interface Ref {
  go: number;
  comp?: number;
}

export type Field = unknown;

export interface CompData {
  t: string;
  [key: string]: Field;
}

export interface NodeData {
  name: string;
  parent: number;
  active: boolean;
  pos: [number, number, number];
  scale: [number, number];
  q: [number, number, number, number];
  comps: (CompData | null)[];
}

export interface LevelData {
  name: string;
  nodes: NodeData[];
}

export interface SpriteMeta {
  w: number;
  h: number;
  ppu: number;
  pivot: [number, number];
  iw: number;
  ih: number;
  border: [number, number, number, number];
}

export function isRef(v: unknown): v is Ref {
  return typeof v === 'object' && v !== null && typeof (v as Ref).go === 'number';
}

export function refs(v: unknown): Ref[] {
  if (isRef(v)) return [v];
  if (Array.isArray(v)) return v.filter(isRef);
  return [];
}

export function num(v: unknown, d = 0): number {
  return typeof v === 'number' ? v : d;
}
