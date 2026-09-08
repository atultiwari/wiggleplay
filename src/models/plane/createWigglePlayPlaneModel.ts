import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// Paint declared colour regions into the vertex-colour attribute.
//
// WHY VERTEX COLOUR AND NOT A TEXTURE. A subject whose identity is a set of flat colour regions
// with hard boundaries -- a blaze, a bib, a sock, a livery stripe -- needs those boundaries placed
// to a measured position. This pipeline emits code and no image assets, so a texture is not
// available to place them with; a single root-to-tip ramp cannot express a shaped region. Per-
// vertex colour driven by a declared shape is the remaining honest representation, and it is the
// one the boundary gate can measure BEFORE a browser is involved.
//
// The maths here is a transcription of forge/_shared/vertex_paint.py, and
// forge/tests/test_vertex_paint.py holds the two to the same numbers on a fixture. Editing one
// side without the other turns a gated boundary into an ungated one, which is exactly the failure
// the shared implementation exists to prevent.
//
// Regions are evaluated in the component's own local space AFTER its real dimensions have been
// applied to the vertex data, so every coordinate below is in the same units as the component's
// measured dimensions rather than in a unit cube.
type VertexPaintRegion = {
  id: string;
  kind: 'axis-band' | 'ellipsoid' | 'tapered-capsule';
  color: string;
  softness: number;
  axis?: 'x' | 'y' | 'z';
  min?: number;
  max?: number;
  center?: [number, number, number];
  radii?: [number, number, number];
  start?: [number, number, number];
  end?: [number, number, number];
  startRadius?: number;
  endRadius?: number;
};

function vertexPaintSmoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge1 ? 0 : 1;
  let t = (value - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

function vertexPaintSignedDistance(
  region: VertexPaintRegion,
  x: number,
  y: number,
  z: number,
): number {
  if (region.kind === 'axis-band') {
    const value = region.axis === 'x' ? x : region.axis === 'z' ? z : y;
    const low = region.min as number;
    const high = region.max as number;
    if (value < low) return low - value;
    if (value > high) return value - high;
    return -Math.min(value - low, high - value);
  }
  if (region.kind === 'ellipsoid') {
    const [cx, cy, cz] = region.center as [number, number, number];
    const [rx, ry, rz] = region.radii as [number, number, number];
    const q = Math.sqrt(
      ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2,
    );
    return (q - 1) * Math.min(rx, ry, rz);
  }
  const [ax, ay, az] = region.start as [number, number, number];
  const [bx, by, bz] = region.end as [number, number, number];
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const denominator = abx * abx + aby * aby + abz * abz;
  let t = denominator > 0
    ? ((x - ax) * abx + (y - ay) * aby + (z - az) * abz) / denominator
    : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const distance = Math.sqrt(
    (x - (ax + abx * t)) ** 2 + (y - (ay + aby * t)) ** 2 + (z - (az + abz * t)) ** 2,
  );
  const startRadius = region.startRadius as number;
  const endRadius = region.endRadius as number;
  return distance - (startRadius + (endRadius - startRadius) * t);
}

function vertexPaintWeight(region: VertexPaintRegion, x: number, y: number, z: number): number {
  const distance = vertexPaintSignedDistance(region, x, y, z);
  if (region.softness <= 0) return distance <= 0 ? 1 : 0;
  return 1 - vertexPaintSmoothstep(-region.softness * 0.5, region.softness * 0.5, distance);
}

function applyVertexPaint(
  geometry: THREE.BufferGeometry,
  baseColor: string,
  regions: VertexPaintRegion[],
): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const values = new Float32Array(position.count * 3);
  const base = new THREE.Color(baseColor);
  const target = new THREE.Color();
  const mixed = new THREE.Color();
  const regionColors = regions.map((region) => new THREE.Color(region.color));

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    mixed.copy(base);
    for (let r = 0; r < regions.length; r += 1) {
      const weight = vertexPaintWeight(regions[r], x, y, z);
      if (weight <= 0) continue;
      target.copy(regionColors[r]);
      mixed.lerp(target, weight);
    }
    values[i * 3] = mixed.r;
    values[i * 3 + 1] = mixed.g;
    values[i * 3 + 2] = mixed.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
}

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
}

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: WigglePlay plane
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createWigglePlayPlaneModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "WigglePlay plane";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["hidden"] = createSculptMaterial(
    "hidden",
    {"id": "hidden", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000"]}, "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "roughness": {"base": 1.0, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": ""}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": [], "notes": "invisible carrier", "opacity": {"base": 0.0}, "qualityTier": "utility", "textureless": {"declared": true, "evidence": ["invisible root carrier; never rendered"]}},
    options
  );
  materialMap["plane-white"] = createSculptMaterial(
    "plane-white",
    {"id": "plane-white", "name": "Airframe white", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#fbfdff", "color": "#fbfdff", "albedo": {"dominant": "#fbfdff", "secondary": ["#2f9ada", "#ff4a48"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#fbfdff", "#2f9ada", "#ff4a48"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.4, "variation": 0.05}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "belly", "region": "lower fuselage and nose cap", "color": "#2f9ada", "note": "blue belly + nose cap (vertexPaint tapered-capsule)"}, {"id": "belly-stripe", "region": "belly line", "color": "#ff4a48", "note": "red stripe above the blue belly (vertexPaint tapered-capsule)"}, {"id": "outline", "region": "silhouette", "color": "#1a1a1a", "note": "2D sticker outline; optional runtime inverted hull, not geometry"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["fin-white"] = createSculptMaterial(
    "fin-white",
    {"id": "fin-white", "name": "Fin white", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#fbfdff", "color": "#fbfdff", "albedo": {"dominant": "#fbfdff", "secondary": ["#ff4a48", "#2a6fd0"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#fbfdff", "#ff4a48", "#2a6fd0"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.4, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "fin-stripes", "region": "trailing edge", "color": "#ff4a48", "note": "red + blue trailing-edge stripes (separate sweep components)"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["stripe-red"] = createSculptMaterial(
    "stripe-red",
    {"id": "stripe-red", "name": "Stripe red", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ff4a48", "color": "#ff4a48", "albedo": {"dominant": "#ff4a48", "secondary": ["#ff4a48"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ff4a48", "#ff4a48"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.45, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#ff4a48", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["fin-blue"] = createSculptMaterial(
    "fin-blue",
    {"id": "fin-blue", "name": "Fin stripe blue", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#2a6fd0", "color": "#2a6fd0", "albedo": {"dominant": "#2a6fd0", "secondary": ["#2a6fd0"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#2a6fd0", "#2a6fd0"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.45, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#2a6fd0", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["porthole-blue"] = createSculptMaterial(
    "porthole-blue",
    {"id": "porthole-blue", "name": "Porthole / intake blue", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#4ab8ee", "color": "#4ab8ee", "albedo": {"dominant": "#4ab8ee", "secondary": ["#bfeeff"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#4ab8ee", "#bfeeff"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.15, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#4ab8ee", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}, "clearcoat": {"base": 0.7}, "clearcoatRoughness": {"base": 0.1}},
    options
  );
  materialMap["engine-white"] = createSculptMaterial(
    "engine-white",
    {"id": "engine-white", "name": "Engine pod white", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#fbfdff", "color": "#fbfdff", "albedo": {"dominant": "#fbfdff", "secondary": ["#bfeeff"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#fbfdff", "#bfeeff"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.35, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#fbfdff", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["dark-matte"] = createSculptMaterial(
    "dark-matte",
    {"id": "dark-matte", "name": "Eyes / lines", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#1a1a1a", "color": "#1a1a1a", "albedo": {"dominant": "#1a1a1a", "secondary": ["#1a1a1a"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#1a1a1a", "#1a1a1a"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.6, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#1a1a1a", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["cheek-pink"] = createSculptMaterial(
    "cheek-pink",
    {"id": "cheek-pink", "name": "Cheek blush", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#f6a6c0", "color": "#f6a6c0", "albedo": {"dominant": "#f6a6c0", "secondary": ["#f6a6c0"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#f6a6c0", "#f6a6c0"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.5, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#f6a6c0", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["catchlight"] = createSculptMaterial(
    "catchlight",
    {"id": "catchlight", "name": "Catchlight white", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ffffff", "color": "#ffffff", "albedo": {"dominant": "#ffffff", "secondary": ["#ffffff"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ffffff", "#ffffff"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.35, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#ffffff", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}, "emissive": "#ffffff", "emissiveIntensity": {"base": 1.0}},
    options
  );
  materialMap["nose-gloss"] = createSculptMaterial(
    "nose-gloss",
    {"id": "nose-gloss", "name": "Nose gloss dot", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#bfeeff", "color": "#bfeeff", "albedo": {"dominant": "#bfeeff", "secondary": ["#ffffff"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#bfeeff", "#ffffff"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.2, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#bfeeff", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}, "emissive": "#bfeeff", "emissiveIntensity": {"base": 0.3}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Root carrier__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Root carrier", "level": "macro", "role": "root", "importance": 0.1, "confidence": 1.0, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Invisible root carrier with no visible geometry of its own.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 0.001, "height": 0.001, "depth": 0.001, "units": "relative", "confidence": 1.0}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.001, 0.001, 0.001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "ground", "localPosition": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.001, 0.001, 0.001], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "ground", "localPosition": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.001, 0.001, 0.001], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(0.001, 0.001, 0.001);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Root carrier";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Root carrier", "level": "macro", "role": "root", "importance": 0.1, "confidence": 1.0, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Invisible root carrier with no visible geometry of its own.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 0.001, "height": 0.001, "depth": 0.001, "units": "relative", "confidence": 1.0}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.001, 0.001, 0.001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "ground", "localPosition": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.001, 0.001, 0.001], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.001, 0.001, 0.001], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);
  const socket_root_ground_0 = new THREE.Object3D();
  socket_root_ground_0.name = "ground";
  socket_root_ground_0.position.set(0.0, 0.0, 0.0);
  socket_root_ground_0.rotation.set(0, 0, 0);
  socket_root_ground_0.userData.socket = {"id": "ground", "localPosition": [0, 0, 0]};
  node_root_0.add(socket_root_ground_0);
  sockets["root:ground"] = socket_root_ground_0;

  const endpoint_fuselage_1 = makeAttachmentEndpoint(null);
  const node_fuselage_1 = new THREE.Group();
  node_fuselage_1.name = "Fuselage__pivot";
  node_fuselage_1.scale.set(1, 1, 1);
  if (endpoint_fuselage_1) {
    node_fuselage_1.position.copy(endpoint_fuselage_1.start);
    node_fuselage_1.rotation.set(0.0, 0.0, -1.4693);
  } else {
    node_fuselage_1.position.set(-0.4944, 0.2864, 0.0);
    node_fuselage_1.rotation.set(0.0, 0.0, -1.4693);
  }
  node_fuselage_1.userData.sculptComponent = {"id": "fuselage", "name": "Fuselage", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "One chubby tapered volume: the top and belly outlines were measured, projected onto the tilted nose-to-tail axis and revolved as a single-peaked lathe profile; the blue belly, nose cap and red stripe are vertex-painted regions.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "latheProfile": {"points": [[0.0001, 0.0], [0.05, 0.0167], [0.0563, 0.0333], [0.0832, 0.05], [0.1029, 0.0667], [0.12, 0.0833], [0.1352, 0.1], [0.1496, 0.1167], [0.1633, 0.1333], [0.1765, 0.15], [0.1886, 0.1667], [0.1995, 0.1833], [0.2096, 0.2], [0.2186, 0.2167], [0.2259, 0.2333], [0.2322, 0.25], [0.2382, 0.2667], [0.2432, 0.2833], [0.2465, 0.3], [0.2486, 0.3167], [0.2504, 0.3333], [0.2518, 0.35], [0.2527, 0.3667], [0.253, 0.3833], [0.2528, 0.4], [0.2521, 0.4167], [0.2507, 0.4333], [0.2487, 0.45], [0.246, 0.4667], [0.2431, 0.4833], [0.2404, 0.5], [0.2375, 0.5167], [0.2341, 0.5333], [0.2297, 0.55], [0.2246, 0.5667], [0.219, 0.5833], [0.2129, 0.6], [0.2064, 0.6167], [0.1995, 0.6333], [0.1925, 0.65], [0.1852, 0.6667], [0.1777, 0.6833], [0.1699, 0.7], [0.1618, 0.7167], [0.1533, 0.7333], [0.1446, 0.75], [0.1357, 0.7667], [0.1265, 0.7833], [0.1172, 0.8], [0.1078, 0.8167], [0.0985, 0.8333], [0.0894, 0.85], [0.0803, 0.8667], [0.0706, 0.8833], [0.0603, 0.9], [0.0498, 0.9167], [0.0396, 0.9333], [0.0295, 0.95], [0.017, 0.9667], [0.03, 0.9833], [0.0001, 1.0]], "segments": 64}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.506, "height": 1.0, "depth": 0.506, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.4944, 0.2864, 0.0], "rotation": [0, 0, -1.4693], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "wing-near", "localPosition": [0, 0.5, 0.15]}, {"id": "wing-far", "localPosition": [0, 0.5, -0.15]}, {"id": "fin", "localPosition": [-0.2, 0.86, 0]}, {"id": "tail-near", "localPosition": [0, 0.97, 0.03]}, {"id": "tail-far", "localPosition": [0, 0.97, -0.03]}, {"id": "skin", "localPosition": [0, 0.4, 0.253]}, {"id": "engine-near", "localPosition": [0.2308, 0.5393, 0.3]}], "collider": {"type": "capsule", "offset": [0, 0.5, 0], "scale": [0.506, 1.0, 0.506], "isTrigger": false, "notes": "capsule along the lathe axis"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fuselage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "belly", "kind": "decal", "note": "blue belly (vertexPaint)"}, {"id": "belly-stripe", "kind": "linework", "note": "red stripe along the belly line, built as the belly-stripe sweep"}], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.03, "bumpAmplitude": 0.0, "normalPattern": "none (flat satin paint)", "displacementPattern": "none", "occlusionPattern": "contact darkening under the wing roots and portholes", "edgeWearPattern": "none", "notes": "smooth lathe"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(47, 154, 218, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour", "colorGradient": {"type": "linear", "axis": "x", "stops": [{"t": 0.0, "color": "rgba(242, 249, 255, 1.0)"}, {"t": 1.0, "color": "rgba(47, 154, 218, 1.0)"}]}}, "vertexPaint": {"baseColor": "#fbfdff", "regions": [{"id": "belly-1", "kind": "tapered-capsule", "start": [0.015, -0.02, 0], "end": [0.0503, 0.04, 0], "startRadius": 0.0298, "endRadius": 0.0908, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-2", "kind": "tapered-capsule", "start": [0.0503, 0.04, 0], "end": [0.1014, 0.1, 0], "startRadius": 0.0908, "endRadius": 0.1521, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-3", "kind": "tapered-capsule", "start": [0.1014, 0.1, 0], "end": [0.1378, 0.16, 0], "startRadius": 0.1521, "endRadius": 0.172, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-4", "kind": "tapered-capsule", "start": [0.1378, 0.16, 0], "end": [0.1651, 0.22, 0], "startRadius": 0.172, "endRadius": 0.2042, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-5", "kind": "tapered-capsule", "start": [0.1651, 0.22, 0], "end": [0.1849, 0.3, 0], "startRadius": 0.2042, "endRadius": 0.2273, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-6", "kind": "tapered-capsule", "start": [0.1849, 0.3, 0], "end": [0.1897, 0.38, 0], "startRadius": 0.2273, "endRadius": 0.2347, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-7", "kind": "tapered-capsule", "start": [0.1897, 0.38, 0], "end": [0.1853, 0.46, 0], "startRadius": 0.2347, "endRadius": 0.2353, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-8", "kind": "tapered-capsule", "start": [0.1853, 0.46, 0], "end": [0.1742, 0.54, 0], "startRadius": 0.2353, "endRadius": 0.2309, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-9", "kind": "tapered-capsule", "start": [0.1742, 0.54, 0], "end": [0.1538, 0.62, 0], "startRadius": 0.2309, "endRadius": 0.2095, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-10", "kind": "tapered-capsule", "start": [0.1538, 0.62, 0], "end": [0.1201, 0.72, 0], "startRadius": 0.2095, "endRadius": 0.1552, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-11", "kind": "tapered-capsule", "start": [0.1201, 0.72, 0], "end": [0.0879, 0.8, 0], "startRadius": 0.1552, "endRadius": 0.1086, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-12", "kind": "tapered-capsule", "start": [0.0879, 0.8, 0], "end": [0.0359, 0.92, 0], "startRadius": 0.1086, "endRadius": 0.0524, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-13", "kind": "tapered-capsule", "start": [0.0359, 0.92, 0], "end": [0.015, 1.02, 0], "startRadius": 0.0524, "endRadius": 0.0259, "softness": 0.02, "color": "#2f9ada"}]}};
  node_fuselage_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "wing-near", "localPosition": [0, 0.5, 0.15]}, {"id": "wing-far", "localPosition": [0, 0.5, -0.15]}, {"id": "fin", "localPosition": [-0.2, 0.86, 0]}, {"id": "tail-near", "localPosition": [0, 0.97, 0.03]}, {"id": "tail-far", "localPosition": [0, 0.97, -0.03]}, {"id": "skin", "localPosition": [0, 0.4, 0.253]}, {"id": "engine-near", "localPosition": [0.2308, 0.5393, 0.3]}], "collider": {"type": "capsule", "offset": [0, 0.5, 0], "scale": [0.506, 1.0, 0.506], "isTrigger": false, "notes": "capsule along the lathe axis"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fuselage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}};
  (nodes["root"] ?? root).add(node_fuselage_1);
  nodes["fuselage"] = node_fuselage_1;
  const mesh_fuselage_1Geometry = endpoint_fuselage_1
    ? new THREE.CylinderGeometry(endpoint_fuselage_1.endRadius, endpoint_fuselage_1.baseRadius, endpoint_fuselage_1.length, 16, 6)
    : buildLatheGeometry({"points": [[0.0001, 0.0], [0.05, 0.0167], [0.0563, 0.0333], [0.0832, 0.05], [0.1029, 0.0667], [0.12, 0.0833], [0.1352, 0.1], [0.1496, 0.1167], [0.1633, 0.1333], [0.1765, 0.15], [0.1886, 0.1667], [0.1995, 0.1833], [0.2096, 0.2], [0.2186, 0.2167], [0.2259, 0.2333], [0.2322, 0.25], [0.2382, 0.2667], [0.2432, 0.2833], [0.2465, 0.3], [0.2486, 0.3167], [0.2504, 0.3333], [0.2518, 0.35], [0.2527, 0.3667], [0.253, 0.3833], [0.2528, 0.4], [0.2521, 0.4167], [0.2507, 0.4333], [0.2487, 0.45], [0.246, 0.4667], [0.2431, 0.4833], [0.2404, 0.5], [0.2375, 0.5167], [0.2341, 0.5333], [0.2297, 0.55], [0.2246, 0.5667], [0.219, 0.5833], [0.2129, 0.6], [0.2064, 0.6167], [0.1995, 0.6333], [0.1925, 0.65], [0.1852, 0.6667], [0.1777, 0.6833], [0.1699, 0.7], [0.1618, 0.7167], [0.1533, 0.7333], [0.1446, 0.75], [0.1357, 0.7667], [0.1265, 0.7833], [0.1172, 0.8], [0.1078, 0.8167], [0.0985, 0.8333], [0.0894, 0.85], [0.0803, 0.8667], [0.0706, 0.8833], [0.0603, 0.9], [0.0498, 0.9167], [0.0396, 0.9333], [0.0295, 0.95], [0.017, 0.9667], [0.03, 0.9833], [0.0001, 1.0]], "segments": 64});
  if (!endpoint_fuselage_1) {
    mesh_fuselage_1Geometry.scale(1.0, 1.0, 1.0);
  }
  applyVertexPaint(mesh_fuselage_1Geometry, "#fbfdff", [{"id": "belly-1", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.015, -0.02, 0.0], "end": [0.0503, 0.04, 0.0], "startRadius": 0.0298, "endRadius": 0.0908}, {"id": "belly-2", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.0503, 0.04, 0.0], "end": [0.1014, 0.1, 0.0], "startRadius": 0.0908, "endRadius": 0.1521}, {"id": "belly-3", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.1014, 0.1, 0.0], "end": [0.1378, 0.16, 0.0], "startRadius": 0.1521, "endRadius": 0.172}, {"id": "belly-4", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.1378, 0.16, 0.0], "end": [0.1651, 0.22, 0.0], "startRadius": 0.172, "endRadius": 0.2042}, {"id": "belly-5", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.1651, 0.22, 0.0], "end": [0.1849, 0.3, 0.0], "startRadius": 0.2042, "endRadius": 0.2273}, {"id": "belly-6", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.1849, 0.3, 0.0], "end": [0.1897, 0.38, 0.0], "startRadius": 0.2273, "endRadius": 0.2347}, {"id": "belly-7", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.1897, 0.38, 0.0], "end": [0.1853, 0.46, 0.0], "startRadius": 0.2347, "endRadius": 0.2353}, {"id": "belly-8", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.1853, 0.46, 0.0], "end": [0.1742, 0.54, 0.0], "startRadius": 0.2353, "endRadius": 0.2309}, {"id": "belly-9", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.1742, 0.54, 0.0], "end": [0.1538, 0.62, 0.0], "startRadius": 0.2309, "endRadius": 0.2095}, {"id": "belly-10", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.1538, 0.62, 0.0], "end": [0.1201, 0.72, 0.0], "startRadius": 0.2095, "endRadius": 0.1552}, {"id": "belly-11", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.1201, 0.72, 0.0], "end": [0.0879, 0.8, 0.0], "startRadius": 0.1552, "endRadius": 0.1086}, {"id": "belly-12", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.0879, 0.8, 0.0], "end": [0.0359, 0.92, 0.0], "startRadius": 0.1086, "endRadius": 0.0524}, {"id": "belly-13", "kind": "tapered-capsule", "color": "#2f9ada", "softness": 0.02, "start": [0.0359, 0.92, 0.0], "end": [0.015, 1.02, 0.0], "startRadius": 0.0524, "endRadius": 0.0259}]);
  const mesh_fuselage_1 = new THREE.Mesh(
    mesh_fuselage_1Geometry,
    materialMap["plane-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fuselage_1.name = "Fuselage";
  mesh_fuselage_1.material = mesh_fuselage_1.material.clone();
  mesh_fuselage_1.material.vertexColors = true;
  (mesh_fuselage_1.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_fuselage_1) {
    mesh_fuselage_1.position.copy(endpoint_fuselage_1.midpoint);
    mesh_fuselage_1.quaternion.copy(endpoint_fuselage_1.quaternion);
  }
  mesh_fuselage_1.castShadow = options.castShadow ?? true;
  mesh_fuselage_1.receiveShadow = options.receiveShadow ?? true;
  mesh_fuselage_1.userData.sculptComponent = {"id": "fuselage", "name": "Fuselage", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "One chubby tapered volume: the top and belly outlines were measured, projected onto the tilted nose-to-tail axis and revolved as a single-peaked lathe profile; the blue belly, nose cap and red stripe are vertex-painted regions.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "latheProfile": {"points": [[0.0001, 0.0], [0.05, 0.0167], [0.0563, 0.0333], [0.0832, 0.05], [0.1029, 0.0667], [0.12, 0.0833], [0.1352, 0.1], [0.1496, 0.1167], [0.1633, 0.1333], [0.1765, 0.15], [0.1886, 0.1667], [0.1995, 0.1833], [0.2096, 0.2], [0.2186, 0.2167], [0.2259, 0.2333], [0.2322, 0.25], [0.2382, 0.2667], [0.2432, 0.2833], [0.2465, 0.3], [0.2486, 0.3167], [0.2504, 0.3333], [0.2518, 0.35], [0.2527, 0.3667], [0.253, 0.3833], [0.2528, 0.4], [0.2521, 0.4167], [0.2507, 0.4333], [0.2487, 0.45], [0.246, 0.4667], [0.2431, 0.4833], [0.2404, 0.5], [0.2375, 0.5167], [0.2341, 0.5333], [0.2297, 0.55], [0.2246, 0.5667], [0.219, 0.5833], [0.2129, 0.6], [0.2064, 0.6167], [0.1995, 0.6333], [0.1925, 0.65], [0.1852, 0.6667], [0.1777, 0.6833], [0.1699, 0.7], [0.1618, 0.7167], [0.1533, 0.7333], [0.1446, 0.75], [0.1357, 0.7667], [0.1265, 0.7833], [0.1172, 0.8], [0.1078, 0.8167], [0.0985, 0.8333], [0.0894, 0.85], [0.0803, 0.8667], [0.0706, 0.8833], [0.0603, 0.9], [0.0498, 0.9167], [0.0396, 0.9333], [0.0295, 0.95], [0.017, 0.9667], [0.03, 0.9833], [0.0001, 1.0]], "segments": 64}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.506, "height": 1.0, "depth": 0.506, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.4944, 0.2864, 0.0], "rotation": [0, 0, -1.4693], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "wing-near", "localPosition": [0, 0.5, 0.15]}, {"id": "wing-far", "localPosition": [0, 0.5, -0.15]}, {"id": "fin", "localPosition": [-0.2, 0.86, 0]}, {"id": "tail-near", "localPosition": [0, 0.97, 0.03]}, {"id": "tail-far", "localPosition": [0, 0.97, -0.03]}, {"id": "skin", "localPosition": [0, 0.4, 0.253]}, {"id": "engine-near", "localPosition": [0.2308, 0.5393, 0.3]}], "collider": {"type": "capsule", "offset": [0, 0.5, 0], "scale": [0.506, 1.0, 0.506], "isTrigger": false, "notes": "capsule along the lathe axis"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fuselage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "belly", "kind": "decal", "note": "blue belly (vertexPaint)"}, {"id": "belly-stripe", "kind": "linework", "note": "red stripe along the belly line, built as the belly-stripe sweep"}], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.03, "bumpAmplitude": 0.0, "normalPattern": "none (flat satin paint)", "displacementPattern": "none", "occlusionPattern": "contact darkening under the wing roots and portholes", "edgeWearPattern": "none", "notes": "smooth lathe"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(47, 154, 218, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour", "colorGradient": {"type": "linear", "axis": "x", "stops": [{"t": 0.0, "color": "rgba(242, 249, 255, 1.0)"}, {"t": 1.0, "color": "rgba(47, 154, 218, 1.0)"}]}}, "vertexPaint": {"baseColor": "#fbfdff", "regions": [{"id": "belly-1", "kind": "tapered-capsule", "start": [0.015, -0.02, 0], "end": [0.0503, 0.04, 0], "startRadius": 0.0298, "endRadius": 0.0908, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-2", "kind": "tapered-capsule", "start": [0.0503, 0.04, 0], "end": [0.1014, 0.1, 0], "startRadius": 0.0908, "endRadius": 0.1521, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-3", "kind": "tapered-capsule", "start": [0.1014, 0.1, 0], "end": [0.1378, 0.16, 0], "startRadius": 0.1521, "endRadius": 0.172, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-4", "kind": "tapered-capsule", "start": [0.1378, 0.16, 0], "end": [0.1651, 0.22, 0], "startRadius": 0.172, "endRadius": 0.2042, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-5", "kind": "tapered-capsule", "start": [0.1651, 0.22, 0], "end": [0.1849, 0.3, 0], "startRadius": 0.2042, "endRadius": 0.2273, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-6", "kind": "tapered-capsule", "start": [0.1849, 0.3, 0], "end": [0.1897, 0.38, 0], "startRadius": 0.2273, "endRadius": 0.2347, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-7", "kind": "tapered-capsule", "start": [0.1897, 0.38, 0], "end": [0.1853, 0.46, 0], "startRadius": 0.2347, "endRadius": 0.2353, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-8", "kind": "tapered-capsule", "start": [0.1853, 0.46, 0], "end": [0.1742, 0.54, 0], "startRadius": 0.2353, "endRadius": 0.2309, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-9", "kind": "tapered-capsule", "start": [0.1742, 0.54, 0], "end": [0.1538, 0.62, 0], "startRadius": 0.2309, "endRadius": 0.2095, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-10", "kind": "tapered-capsule", "start": [0.1538, 0.62, 0], "end": [0.1201, 0.72, 0], "startRadius": 0.2095, "endRadius": 0.1552, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-11", "kind": "tapered-capsule", "start": [0.1201, 0.72, 0], "end": [0.0879, 0.8, 0], "startRadius": 0.1552, "endRadius": 0.1086, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-12", "kind": "tapered-capsule", "start": [0.0879, 0.8, 0], "end": [0.0359, 0.92, 0], "startRadius": 0.1086, "endRadius": 0.0524, "softness": 0.02, "color": "#2f9ada"}, {"id": "belly-13", "kind": "tapered-capsule", "start": [0.0359, 0.92, 0], "end": [0.015, 1.02, 0], "startRadius": 0.0524, "endRadius": 0.0259, "softness": 0.02, "color": "#2f9ada"}]}};
  node_fuselage_1.add(mesh_fuselage_1);
  meshes["fuselage"] = mesh_fuselage_1;
  colliders["fuselage"] = {"type": "capsule", "offset": [0, 0.5, 0], "scale": [0.506, 1.0, 0.506], "isTrigger": false, "notes": "capsule along the lathe axis"};
  destructionGroups["fuselage"] ??= [];
  destructionGroups["fuselage"].push(node_fuselage_1);
  const socket_fuselage_wing_near_0 = new THREE.Object3D();
  socket_fuselage_wing_near_0.name = "wing-near";
  socket_fuselage_wing_near_0.position.set(0.0, 0.5, 0.15);
  socket_fuselage_wing_near_0.rotation.set(0, 0, 0);
  socket_fuselage_wing_near_0.userData.socket = {"id": "wing-near", "localPosition": [0, 0.5, 0.15]};
  node_fuselage_1.add(socket_fuselage_wing_near_0);
  sockets["fuselage:wing-near"] = socket_fuselage_wing_near_0;
  const socket_fuselage_wing_far_1 = new THREE.Object3D();
  socket_fuselage_wing_far_1.name = "wing-far";
  socket_fuselage_wing_far_1.position.set(0.0, 0.5, -0.15);
  socket_fuselage_wing_far_1.rotation.set(0, 0, 0);
  socket_fuselage_wing_far_1.userData.socket = {"id": "wing-far", "localPosition": [0, 0.5, -0.15]};
  node_fuselage_1.add(socket_fuselage_wing_far_1);
  sockets["fuselage:wing-far"] = socket_fuselage_wing_far_1;
  const socket_fuselage_fin_2 = new THREE.Object3D();
  socket_fuselage_fin_2.name = "fin";
  socket_fuselage_fin_2.position.set(-0.2, 0.86, 0.0);
  socket_fuselage_fin_2.rotation.set(0, 0, 0);
  socket_fuselage_fin_2.userData.socket = {"id": "fin", "localPosition": [-0.2, 0.86, 0]};
  node_fuselage_1.add(socket_fuselage_fin_2);
  sockets["fuselage:fin"] = socket_fuselage_fin_2;
  const socket_fuselage_tail_near_3 = new THREE.Object3D();
  socket_fuselage_tail_near_3.name = "tail-near";
  socket_fuselage_tail_near_3.position.set(0.0, 0.97, 0.03);
  socket_fuselage_tail_near_3.rotation.set(0, 0, 0);
  socket_fuselage_tail_near_3.userData.socket = {"id": "tail-near", "localPosition": [0, 0.97, 0.03]};
  node_fuselage_1.add(socket_fuselage_tail_near_3);
  sockets["fuselage:tail-near"] = socket_fuselage_tail_near_3;
  const socket_fuselage_tail_far_4 = new THREE.Object3D();
  socket_fuselage_tail_far_4.name = "tail-far";
  socket_fuselage_tail_far_4.position.set(0.0, 0.97, -0.03);
  socket_fuselage_tail_far_4.rotation.set(0, 0, 0);
  socket_fuselage_tail_far_4.userData.socket = {"id": "tail-far", "localPosition": [0, 0.97, -0.03]};
  node_fuselage_1.add(socket_fuselage_tail_far_4);
  sockets["fuselage:tail-far"] = socket_fuselage_tail_far_4;
  const socket_fuselage_skin_5 = new THREE.Object3D();
  socket_fuselage_skin_5.name = "skin";
  socket_fuselage_skin_5.position.set(0.0, 0.4, 0.253);
  socket_fuselage_skin_5.rotation.set(0, 0, 0);
  socket_fuselage_skin_5.userData.socket = {"id": "skin", "localPosition": [0, 0.4, 0.253]};
  node_fuselage_1.add(socket_fuselage_skin_5);
  sockets["fuselage:skin"] = socket_fuselage_skin_5;
  const socket_fuselage_engine_near_6 = new THREE.Object3D();
  socket_fuselage_engine_near_6.name = "engine-near";
  socket_fuselage_engine_near_6.position.set(0.2308, 0.5393, 0.3);
  socket_fuselage_engine_near_6.rotation.set(0, 0, 0);
  socket_fuselage_engine_near_6.userData.socket = {"id": "engine-near", "localPosition": [0.2308, 0.5393, 0.3]};
  node_fuselage_1.add(socket_fuselage_engine_near_6);
  sockets["fuselage:engine-near"] = socket_fuselage_engine_near_6;

  const endpoint_nose_cap_2 = makeAttachmentEndpoint(null);
  const node_nose_cap_2 = new THREE.Group();
  node_nose_cap_2.name = "Nose cap__pivot";
  node_nose_cap_2.scale.set(1, 1, 1);
  if (endpoint_nose_cap_2) {
    node_nose_cap_2.position.copy(endpoint_nose_cap_2.start);
    node_nose_cap_2.rotation.set(-0.0, 0.0, 1.4693);
  } else {
    node_nose_cap_2.position.set(0.0645, 0.1036, 0.0);
    node_nose_cap_2.rotation.set(-0.0, 0.0, 1.4693);
  }
  node_nose_cap_2.userData.sculptComponent = {"id": "nose-cap", "name": "Nose cap", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "The sticker nose droops below the fuselage axis: a blunt spheroid cap (dense lathe about the vertical axis) fused into the front of the lathe carries the rounded nose and its blue underside.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "latheProfile": {"points": [[0.0001, -0.125], [0.0343, -0.1188], [0.0479, -0.1125], [0.0579, -0.1062], [0.066, -0.1], [0.0728, -0.0938], [0.0786, -0.0875], [0.0836, -0.0812], [0.088, -0.075], [0.0919, -0.0688], [0.0953, -0.0625], [0.0982, -0.0562], [0.1008, -0.05], [0.103, -0.0438], [0.1049, -0.0375], [0.1065, -0.0312], [0.1078, -0.025], [0.1088, -0.0187], [0.1094, -0.0125], [0.1099, -0.0062], [0.11, 0.0], [0.1099, 0.0063], [0.1094, 0.0125], [0.1088, 0.0188], [0.1078, 0.025], [0.1065, 0.0312], [0.1049, 0.0375], [0.103, 0.0438], [0.1008, 0.05], [0.0982, 0.0563], [0.0953, 0.0625], [0.0919, 0.0688], [0.088, 0.075], [0.0836, 0.0813], [0.0786, 0.0875], [0.0728, 0.0938], [0.066, 0.1], [0.0579, 0.1062], [0.0479, 0.1125], [0.0343, 0.1188], [0.0001, 0.125]], "segments": 64}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.1, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.25, "depth": 0.22, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0645, 0.1036, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cap-blue", "kind": "decal", "note": "blue nose underside (vertexPaint axis-band)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(47, 154, 218, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#fbfdff", "regions": [{"id": "cap-blue", "kind": "axis-band", "axis": "y", "min": -1.0, "max": 0.0648, "softness": 0.012, "color": "#2f9ada"}]}};
  node_nose_cap_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}};
  (nodes["fuselage"] ?? root).add(node_nose_cap_2);
  nodes["nose-cap"] = node_nose_cap_2;
  const mesh_nose_cap_2Geometry = endpoint_nose_cap_2
    ? new THREE.CylinderGeometry(endpoint_nose_cap_2.endRadius, endpoint_nose_cap_2.baseRadius, endpoint_nose_cap_2.length, 16, 6)
    : buildLatheGeometry({"points": [[0.0001, -0.125], [0.0343, -0.1188], [0.0479, -0.1125], [0.0579, -0.1062], [0.066, -0.1], [0.0728, -0.0938], [0.0786, -0.0875], [0.0836, -0.0812], [0.088, -0.075], [0.0919, -0.0688], [0.0953, -0.0625], [0.0982, -0.0562], [0.1008, -0.05], [0.103, -0.0438], [0.1049, -0.0375], [0.1065, -0.0312], [0.1078, -0.025], [0.1088, -0.0187], [0.1094, -0.0125], [0.1099, -0.0062], [0.11, 0.0], [0.1099, 0.0063], [0.1094, 0.0125], [0.1088, 0.0188], [0.1078, 0.025], [0.1065, 0.0312], [0.1049, 0.0375], [0.103, 0.0438], [0.1008, 0.05], [0.0982, 0.0563], [0.0953, 0.0625], [0.0919, 0.0688], [0.088, 0.075], [0.0836, 0.0813], [0.0786, 0.0875], [0.0728, 0.0938], [0.066, 0.1], [0.0579, 0.1062], [0.0479, 0.1125], [0.0343, 0.1188], [0.0001, 0.125]], "segments": 64});
  if (!endpoint_nose_cap_2) {
    mesh_nose_cap_2Geometry.scale(1.0, 1.0, 1.0);
  }
  applyVertexPaint(mesh_nose_cap_2Geometry, "#fbfdff", [{"id": "cap-blue", "kind": "axis-band", "color": "#2f9ada", "softness": 0.012, "axis": "y", "min": -1.0, "max": 0.0648}]);
  const mesh_nose_cap_2 = new THREE.Mesh(
    mesh_nose_cap_2Geometry,
    materialMap["plane-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_cap_2.name = "Nose cap";
  mesh_nose_cap_2.material = mesh_nose_cap_2.material.clone();
  mesh_nose_cap_2.material.vertexColors = true;
  (mesh_nose_cap_2.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_nose_cap_2) {
    mesh_nose_cap_2.position.copy(endpoint_nose_cap_2.midpoint);
    mesh_nose_cap_2.quaternion.copy(endpoint_nose_cap_2.quaternion);
  }
  mesh_nose_cap_2.castShadow = options.castShadow ?? true;
  mesh_nose_cap_2.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_cap_2.userData.sculptComponent = {"id": "nose-cap", "name": "Nose cap", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "The sticker nose droops below the fuselage axis: a blunt spheroid cap (dense lathe about the vertical axis) fused into the front of the lathe carries the rounded nose and its blue underside.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "latheProfile": {"points": [[0.0001, -0.125], [0.0343, -0.1188], [0.0479, -0.1125], [0.0579, -0.1062], [0.066, -0.1], [0.0728, -0.0938], [0.0786, -0.0875], [0.0836, -0.0812], [0.088, -0.075], [0.0919, -0.0688], [0.0953, -0.0625], [0.0982, -0.0562], [0.1008, -0.05], [0.103, -0.0438], [0.1049, -0.0375], [0.1065, -0.0312], [0.1078, -0.025], [0.1088, -0.0187], [0.1094, -0.0125], [0.1099, -0.0062], [0.11, 0.0], [0.1099, 0.0063], [0.1094, 0.0125], [0.1088, 0.0188], [0.1078, 0.025], [0.1065, 0.0312], [0.1049, 0.0375], [0.103, 0.0438], [0.1008, 0.05], [0.0982, 0.0563], [0.0953, 0.0625], [0.0919, 0.0688], [0.088, 0.075], [0.0836, 0.0813], [0.0786, 0.0875], [0.0728, 0.0938], [0.066, 0.1], [0.0579, 0.1062], [0.0479, 0.1125], [0.0343, 0.1188], [0.0001, 0.125]], "segments": 64}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.1, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.25, "depth": 0.22, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0645, 0.1036, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cap-blue", "kind": "decal", "note": "blue nose underside (vertexPaint axis-band)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(47, 154, 218, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#fbfdff", "regions": [{"id": "cap-blue", "kind": "axis-band", "axis": "y", "min": -1.0, "max": 0.0648, "softness": 0.012, "color": "#2f9ada"}]}};
  node_nose_cap_2.add(mesh_nose_cap_2);
  meshes["nose-cap"] = mesh_nose_cap_2;
  colliders["nose-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["nose-cap"] ??= [];
  destructionGroups["nose-cap"].push(node_nose_cap_2);

  const endpoint_airfoil_near_3 = makeAttachmentEndpoint(null);
  const node_airfoil_near_3 = new THREE.Group();
  node_airfoil_near_3.name = "Near airfoil__pivot";
  node_airfoil_near_3.scale.set(1, 1, 1);
  if (endpoint_airfoil_near_3) {
    node_airfoil_near_3.position.copy(endpoint_airfoil_near_3.start);
    node_airfoil_near_3.rotation.set(0.3284, 0.4702, 1.1583);
  } else {
    node_airfoil_near_3.position.set(0.2062, 0.6737, 0.245);
    node_airfoil_near_3.rotation.set(0.3284, 0.4702, 1.1583);
  }
  node_airfoil_near_3.userData.sculptComponent = {"id": "airfoil-near", "name": "Near airfoil", "level": "macro", "role": "fin", "importance": 0.95, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Flat lens-shaped wing surface (near airfoil): an ellipsoid whose long axis runs from the fuselage root to the measured tip (swept back and drooping toward the viewer like the sticker).", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "wing-near", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.4049, "height": 0.22, "depth": 0.06, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2062, 0.6737, 0.245], "rotation": [0.3284, 0.4702, 1.1583], "scale": [0.4049, 0.22, 0.06]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.4049, 0.22, 0.06], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "airfoil-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_airfoil_near_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.4049, 0.22, 0.06], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "airfoil-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}};
  (nodes["fuselage"] ?? root).add(node_airfoil_near_3);
  nodes["airfoil-near"] = node_airfoil_near_3;
  const mesh_airfoil_near_3Geometry = endpoint_airfoil_near_3
    ? new THREE.CylinderGeometry(endpoint_airfoil_near_3.endRadius, endpoint_airfoil_near_3.baseRadius, endpoint_airfoil_near_3.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_airfoil_near_3) {
    mesh_airfoil_near_3Geometry.scale(0.4049, 0.22, 0.06);
  }
  const mesh_airfoil_near_3 = new THREE.Mesh(
    mesh_airfoil_near_3Geometry,
    materialMap["plane-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_airfoil_near_3.name = "Near airfoil";
  if (endpoint_airfoil_near_3) {
    mesh_airfoil_near_3.position.copy(endpoint_airfoil_near_3.midpoint);
    mesh_airfoil_near_3.quaternion.copy(endpoint_airfoil_near_3.quaternion);
  }
  mesh_airfoil_near_3.castShadow = options.castShadow ?? true;
  mesh_airfoil_near_3.receiveShadow = options.receiveShadow ?? true;
  mesh_airfoil_near_3.userData.sculptComponent = {"id": "airfoil-near", "name": "Near airfoil", "level": "macro", "role": "fin", "importance": 0.95, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Flat lens-shaped wing surface (near airfoil): an ellipsoid whose long axis runs from the fuselage root to the measured tip (swept back and drooping toward the viewer like the sticker).", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "wing-near", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.4049, "height": 0.22, "depth": 0.06, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2062, 0.6737, 0.245], "rotation": [0.3284, 0.4702, 1.1583], "scale": [0.4049, 0.22, 0.06]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.4049, 0.22, 0.06], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "airfoil-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_airfoil_near_3.add(mesh_airfoil_near_3);
  meshes["airfoil-near"] = mesh_airfoil_near_3;
  colliders["airfoil-near"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.4049, 0.22, 0.06], "isTrigger": false, "notes": "ellipsoid proxy"};
  destructionGroups["airfoil-near"] ??= [];
  destructionGroups["airfoil-near"].push(node_airfoil_near_3);

  const endpoint_airfoil_far_4 = makeAttachmentEndpoint(null);
  const node_airfoil_far_4 = new THREE.Group();
  node_airfoil_far_4.name = "Far airfoil__pivot";
  node_airfoil_far_4.scale.set(1, 1, 1);
  if (endpoint_airfoil_far_4) {
    node_airfoil_far_4.position.copy(endpoint_airfoil_far_4.start);
    node_airfoil_far_4.rotation.set(0.4979, 0.2623, -2.6966);
  } else {
    node_airfoil_far_4.position.set(-0.1213, 0.1201, -0.1);
    node_airfoil_far_4.rotation.set(0.4979, 0.2623, -2.6966);
  }
  node_airfoil_far_4.userData.sculptComponent = {"id": "airfoil-far", "name": "Far airfoil", "level": "macro", "role": "fin", "importance": 0.6, "confidence": 0.6, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Flat lens-shaped wing surface (far airfoil): an ellipsoid whose long axis runs from the fuselage root to the measured tip (the sticker cheats the far wing forward and up beside the nose; the prop keeps that look because the games always show this side).", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "wing-far", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3927, "height": 0.22, "depth": 0.048, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.1213, 0.1201, -0.1], "rotation": [0.4979, 0.2623, -2.6966], "scale": [0.3927, 0.22, 0.048]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3927, 0.22, 0.048], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "airfoil-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_airfoil_far_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3927, 0.22, 0.048], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "airfoil-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}};
  (nodes["fuselage"] ?? root).add(node_airfoil_far_4);
  nodes["airfoil-far"] = node_airfoil_far_4;
  const mesh_airfoil_far_4Geometry = endpoint_airfoil_far_4
    ? new THREE.CylinderGeometry(endpoint_airfoil_far_4.endRadius, endpoint_airfoil_far_4.baseRadius, endpoint_airfoil_far_4.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_airfoil_far_4) {
    mesh_airfoil_far_4Geometry.scale(0.3927, 0.22, 0.048);
  }
  const mesh_airfoil_far_4 = new THREE.Mesh(
    mesh_airfoil_far_4Geometry,
    materialMap["plane-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_airfoil_far_4.name = "Far airfoil";
  if (endpoint_airfoil_far_4) {
    mesh_airfoil_far_4.position.copy(endpoint_airfoil_far_4.midpoint);
    mesh_airfoil_far_4.quaternion.copy(endpoint_airfoil_far_4.quaternion);
  }
  mesh_airfoil_far_4.castShadow = options.castShadow ?? true;
  mesh_airfoil_far_4.receiveShadow = options.receiveShadow ?? true;
  mesh_airfoil_far_4.userData.sculptComponent = {"id": "airfoil-far", "name": "Far airfoil", "level": "macro", "role": "fin", "importance": 0.6, "confidence": 0.6, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Flat lens-shaped wing surface (far airfoil): an ellipsoid whose long axis runs from the fuselage root to the measured tip (the sticker cheats the far wing forward and up beside the nose; the prop keeps that look because the games always show this side).", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "wing-far", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3927, "height": 0.22, "depth": 0.048, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.1213, 0.1201, -0.1], "rotation": [0.4979, 0.2623, -2.6966], "scale": [0.3927, 0.22, 0.048]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3927, 0.22, 0.048], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "airfoil-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_airfoil_far_4.add(mesh_airfoil_far_4);
  meshes["airfoil-far"] = mesh_airfoil_far_4;
  colliders["airfoil-far"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.3927, 0.22, 0.048], "isTrigger": false, "notes": "ellipsoid proxy"};
  destructionGroups["airfoil-far"] ??= [];
  destructionGroups["airfoil-far"].push(node_airfoil_far_4);

  const endpoint_stabiliser_near_5 = makeAttachmentEndpoint(null);
  const node_stabiliser_near_5 = new THREE.Group();
  node_stabiliser_near_5.name = "Near stabiliser__pivot";
  node_stabiliser_near_5.scale.set(1, 1, 1);
  if (endpoint_stabiliser_near_5) {
    node_stabiliser_near_5.position.copy(endpoint_stabiliser_near_5.start);
    node_stabiliser_near_5.rotation.set(0.5092, 0.4809, 1.5232);
  } else {
    node_stabiliser_near_5.position.set(0.0073, 0.9801, 0.085);
    node_stabiliser_near_5.rotation.set(0.5092, 0.4809, 1.5232);
  }
  node_stabiliser_near_5.userData.sculptComponent = {"id": "stabiliser-near", "name": "Near stabiliser", "level": "meso", "role": "fin", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Flat lens-shaped wing surface (near stabiliser): an ellipsoid whose long axis runs from the fuselage root to the measured tip.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "tail-near", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1497, "height": 0.11, "depth": 0.028, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0073, 0.9801, 0.085], "rotation": [0.5092, 0.4809, 1.5232], "scale": [0.1497, 0.11, 0.028]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1497, 0.11, 0.028], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stabiliser-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_stabiliser_near_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1497, 0.11, 0.028], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stabiliser-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}};
  (nodes["fuselage"] ?? root).add(node_stabiliser_near_5);
  nodes["stabiliser-near"] = node_stabiliser_near_5;
  const mesh_stabiliser_near_5Geometry = endpoint_stabiliser_near_5
    ? new THREE.CylinderGeometry(endpoint_stabiliser_near_5.endRadius, endpoint_stabiliser_near_5.baseRadius, endpoint_stabiliser_near_5.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_stabiliser_near_5) {
    mesh_stabiliser_near_5Geometry.scale(0.1497, 0.11, 0.028);
  }
  const mesh_stabiliser_near_5 = new THREE.Mesh(
    mesh_stabiliser_near_5Geometry,
    materialMap["plane-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stabiliser_near_5.name = "Near stabiliser";
  if (endpoint_stabiliser_near_5) {
    mesh_stabiliser_near_5.position.copy(endpoint_stabiliser_near_5.midpoint);
    mesh_stabiliser_near_5.quaternion.copy(endpoint_stabiliser_near_5.quaternion);
  }
  mesh_stabiliser_near_5.castShadow = options.castShadow ?? true;
  mesh_stabiliser_near_5.receiveShadow = options.receiveShadow ?? true;
  mesh_stabiliser_near_5.userData.sculptComponent = {"id": "stabiliser-near", "name": "Near stabiliser", "level": "meso", "role": "fin", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Flat lens-shaped wing surface (near stabiliser): an ellipsoid whose long axis runs from the fuselage root to the measured tip.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "tail-near", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1497, "height": 0.11, "depth": 0.028, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0073, 0.9801, 0.085], "rotation": [0.5092, 0.4809, 1.5232], "scale": [0.1497, 0.11, 0.028]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1497, 0.11, 0.028], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stabiliser-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_stabiliser_near_5.add(mesh_stabiliser_near_5);
  meshes["stabiliser-near"] = mesh_stabiliser_near_5;
  colliders["stabiliser-near"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.1497, 0.11, 0.028], "isTrigger": false, "notes": "ellipsoid proxy"};
  destructionGroups["stabiliser-near"] ??= [];
  destructionGroups["stabiliser-near"].push(node_stabiliser_near_5);

  const endpoint_stabiliser_far_6 = makeAttachmentEndpoint(null);
  const node_stabiliser_far_6 = new THREE.Group();
  node_stabiliser_far_6.name = "Far stabiliser__pivot";
  node_stabiliser_far_6.scale.set(1, 1, 1);
  if (endpoint_stabiliser_far_6) {
    node_stabiliser_far_6.position.copy(endpoint_stabiliser_far_6.start);
    node_stabiliser_far_6.rotation.set(0.3802, 0.4183, -2.3481);
  } else {
    node_stabiliser_far_6.position.set(-0.1462, 0.8332, -0.06);
    node_stabiliser_far_6.rotation.set(0.3802, 0.4183, -2.3481);
  }
  node_stabiliser_far_6.userData.sculptComponent = {"id": "stabiliser-far", "name": "Far stabiliser", "level": "meso", "role": "fin", "importance": 0.45, "confidence": 0.6, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Flat lens-shaped wing surface (far stabiliser): an ellipsoid whose long axis runs from the fuselage root to the measured tip (cheated above the tail like the sticker).", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "tail-far", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1824, "height": 0.08, "depth": 0.024, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.1462, 0.8332, -0.06], "rotation": [0.3802, 0.4183, -2.3481], "scale": [0.1824, 0.08, 0.024]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1824, 0.08, 0.024], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stabiliser-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_stabiliser_far_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1824, 0.08, 0.024], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stabiliser-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}};
  (nodes["fuselage"] ?? root).add(node_stabiliser_far_6);
  nodes["stabiliser-far"] = node_stabiliser_far_6;
  const mesh_stabiliser_far_6Geometry = endpoint_stabiliser_far_6
    ? new THREE.CylinderGeometry(endpoint_stabiliser_far_6.endRadius, endpoint_stabiliser_far_6.baseRadius, endpoint_stabiliser_far_6.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_stabiliser_far_6) {
    mesh_stabiliser_far_6Geometry.scale(0.1824, 0.08, 0.024);
  }
  const mesh_stabiliser_far_6 = new THREE.Mesh(
    mesh_stabiliser_far_6Geometry,
    materialMap["plane-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stabiliser_far_6.name = "Far stabiliser";
  if (endpoint_stabiliser_far_6) {
    mesh_stabiliser_far_6.position.copy(endpoint_stabiliser_far_6.midpoint);
    mesh_stabiliser_far_6.quaternion.copy(endpoint_stabiliser_far_6.quaternion);
  }
  mesh_stabiliser_far_6.castShadow = options.castShadow ?? true;
  mesh_stabiliser_far_6.receiveShadow = options.receiveShadow ?? true;
  mesh_stabiliser_far_6.userData.sculptComponent = {"id": "stabiliser-far", "name": "Far stabiliser", "level": "meso", "role": "fin", "importance": 0.45, "confidence": 0.6, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Flat lens-shaped wing surface (far stabiliser): an ellipsoid whose long axis runs from the fuselage root to the measured tip (cheated above the tail like the sticker).", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "tail-far", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1824, "height": 0.08, "depth": 0.024, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.1462, 0.8332, -0.06], "rotation": [0.3802, 0.4183, -2.3481], "scale": [0.1824, 0.08, 0.024]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1824, 0.08, 0.024], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stabiliser-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "plane-white"}}, "material": "plane-white", "materialLayers": ["plane-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_stabiliser_far_6.add(mesh_stabiliser_far_6);
  meshes["stabiliser-far"] = mesh_stabiliser_far_6;
  colliders["stabiliser-far"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.1824, 0.08, 0.024], "isTrigger": false, "notes": "ellipsoid proxy"};
  destructionGroups["stabiliser-far"] ??= [];
  destructionGroups["stabiliser-far"].push(node_stabiliser_far_6);

  const endpoint_fin_7 = makeAttachmentEndpoint(null);
  const node_fin_7 = new THREE.Group();
  node_fin_7.name = "Fin__pivot";
  node_fin_7.scale.set(1, 1, 1);
  if (endpoint_fin_7) {
    node_fin_7.position.copy(endpoint_fin_7.start);
    node_fin_7.rotation.set(-0.0, 0.0, 1.4693);
  } else {
    node_fin_7.position.set(-0.2048, 0.9428, -0.0175);
    node_fin_7.rotation.set(-0.0, 0.0, 1.4693);
  }
  node_fin_7.userData.sculptComponent = {"id": "fin", "name": "Fin", "level": "macro", "role": "fin", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Swept vertical stabiliser: the side outline was measured and extruded through a thin thickness, centred on the fuselage plane.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.1588, -0.089], [-0.1141, -0.0353], [-0.0693, 0.0184], [-0.0246, 0.0766], [0.0157, 0.1236], [0.0492, 0.1392], [0.0783, 0.1303], [0.0828, 0.099], [0.0738, -0.0084], [0.0649, -0.0979], [0.0537, -0.1784], [-0.0514, -0.1784]], "depth": 0.035}}, "parent": "fuselage", "attachment": {"parentSocket": "fin", "contactType": "embed", "embedDepth": 0.05, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2416, "height": 0.3176, "depth": 0.035, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2048, 0.9428, -0.0175], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0.0175], "scale": [0.2416, 0.3176, 0.035], "isTrigger": false, "notes": "fin proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fin", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "fin-white"}}, "material": "fin-white", "materialLayers": ["fin-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "fin-stripes", "kind": "linework", "note": "red + blue trailing-edge stripes built as the fin-stripe sweeps"}], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.03, "bumpAmplitude": 0.0, "normalPattern": "none", "displacementPattern": "none", "occlusionPattern": "fin root", "edgeWearPattern": "none", "notes": "thin extrude"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(255, 74, 72, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_fin_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0.0175], "scale": [0.2416, 0.3176, 0.035], "isTrigger": false, "notes": "fin proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fin", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "fin-white"}};
  (nodes["fuselage"] ?? root).add(node_fin_7);
  nodes["fin"] = node_fin_7;
  const mesh_fin_7Geometry = endpoint_fin_7
    ? new THREE.CylinderGeometry(endpoint_fin_7.endRadius, endpoint_fin_7.baseRadius, endpoint_fin_7.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.1588, -0.089], [-0.1141, -0.0353], [-0.0693, 0.0184], [-0.0246, 0.0766], [0.0157, 0.1236], [0.0492, 0.1392], [0.0783, 0.1303], [0.0828, 0.099], [0.0738, -0.0084], [0.0649, -0.0979], [0.0537, -0.1784], [-0.0514, -0.1784]], "depth": 0.035});
  if (!endpoint_fin_7) {
    mesh_fin_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_7 = new THREE.Mesh(
    mesh_fin_7Geometry,
    materialMap["fin-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_7.name = "Fin";
  if (endpoint_fin_7) {
    mesh_fin_7.position.copy(endpoint_fin_7.midpoint);
    mesh_fin_7.quaternion.copy(endpoint_fin_7.quaternion);
  }
  mesh_fin_7.castShadow = options.castShadow ?? true;
  mesh_fin_7.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_7.userData.sculptComponent = {"id": "fin", "name": "Fin", "level": "macro", "role": "fin", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Swept vertical stabiliser: the side outline was measured and extruded through a thin thickness, centred on the fuselage plane.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.1588, -0.089], [-0.1141, -0.0353], [-0.0693, 0.0184], [-0.0246, 0.0766], [0.0157, 0.1236], [0.0492, 0.1392], [0.0783, 0.1303], [0.0828, 0.099], [0.0738, -0.0084], [0.0649, -0.0979], [0.0537, -0.1784], [-0.0514, -0.1784]], "depth": 0.035}}, "parent": "fuselage", "attachment": {"parentSocket": "fin", "contactType": "embed", "embedDepth": 0.05, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2416, "height": 0.3176, "depth": 0.035, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2048, 0.9428, -0.0175], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0.0175], "scale": [0.2416, 0.3176, 0.035], "isTrigger": false, "notes": "fin proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fin", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "fin-white"}}, "material": "fin-white", "materialLayers": ["fin-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "fin-stripes", "kind": "linework", "note": "red + blue trailing-edge stripes built as the fin-stripe sweeps"}], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.03, "bumpAmplitude": 0.0, "normalPattern": "none", "displacementPattern": "none", "occlusionPattern": "fin root", "edgeWearPattern": "none", "notes": "thin extrude"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(255, 74, 72, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_fin_7.add(mesh_fin_7);
  meshes["fin"] = mesh_fin_7;
  colliders["fin"] = {"type": "box", "offset": [0, 0, 0.0175], "scale": [0.2416, 0.3176, 0.035], "isTrigger": false, "notes": "fin proxy"};
  destructionGroups["fin"] ??= [];
  destructionGroups["fin"].push(node_fin_7);

  const endpoint_engine_near_8 = makeAttachmentEndpoint(null);
  const node_engine_near_8 = new THREE.Group();
  node_engine_near_8.name = "Engine pod (near)__pivot";
  node_engine_near_8.scale.set(1, 1, 1);
  if (endpoint_engine_near_8) {
    node_engine_near_8.position.copy(endpoint_engine_near_8.start);
    node_engine_near_8.rotation.set(-0.0, 0.0, 1.4998);
  } else {
    node_engine_near_8.position.set(0.2386, 0.6159, 0.3);
    node_engine_near_8.rotation.set(-0.0, 0.0, 1.4998);
  }
  node_engine_near_8.userData.sculptComponent = {"id": "engine-near", "name": "Engine pod (near)", "level": "meso", "role": "engine", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Rigid white pod hung under the wing: a rounded ellipsoid along the flight axis.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "engine-near", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1546, "height": 0.084, "depth": 0.084, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2386, 0.6159, 0.3], "rotation": [-0.0, 0.0, 1.4998], "scale": [0.1546, 0.084, 0.084]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "intake", "localPosition": [-0.0773, 0, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1546, 0.084, 0.084], "isTrigger": false, "notes": "pod proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "engine-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "engine-white"}}, "material": "engine-white", "materialLayers": ["engine-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_engine_near_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "intake", "localPosition": [-0.0773, 0, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1546, 0.084, 0.084], "isTrigger": false, "notes": "pod proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "engine-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "engine-white"}};
  (nodes["fuselage"] ?? root).add(node_engine_near_8);
  nodes["engine-near"] = node_engine_near_8;
  const mesh_engine_near_8Geometry = endpoint_engine_near_8
    ? new THREE.CylinderGeometry(endpoint_engine_near_8.endRadius, endpoint_engine_near_8.baseRadius, endpoint_engine_near_8.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_engine_near_8) {
    mesh_engine_near_8Geometry.scale(0.1546, 0.084, 0.084);
  }
  const mesh_engine_near_8 = new THREE.Mesh(
    mesh_engine_near_8Geometry,
    materialMap["engine-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_engine_near_8.name = "Engine pod (near)";
  if (endpoint_engine_near_8) {
    mesh_engine_near_8.position.copy(endpoint_engine_near_8.midpoint);
    mesh_engine_near_8.quaternion.copy(endpoint_engine_near_8.quaternion);
  }
  mesh_engine_near_8.castShadow = options.castShadow ?? true;
  mesh_engine_near_8.receiveShadow = options.receiveShadow ?? true;
  mesh_engine_near_8.userData.sculptComponent = {"id": "engine-near", "name": "Engine pod (near)", "level": "meso", "role": "engine", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Rigid white pod hung under the wing: a rounded ellipsoid along the flight axis.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "engine-near", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1546, "height": 0.084, "depth": 0.084, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2386, 0.6159, 0.3], "rotation": [-0.0, 0.0, 1.4998], "scale": [0.1546, 0.084, 0.084]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "intake", "localPosition": [-0.0773, 0, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1546, 0.084, 0.084], "isTrigger": false, "notes": "pod proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "engine-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "engine-white"}}, "material": "engine-white", "materialLayers": ["engine-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(251, 253, 255, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_engine_near_8.add(mesh_engine_near_8);
  meshes["engine-near"] = mesh_engine_near_8;
  colliders["engine-near"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1546, 0.084, 0.084], "isTrigger": false, "notes": "pod proxy"};
  destructionGroups["engine-near"] ??= [];
  destructionGroups["engine-near"].push(node_engine_near_8);
  const socket_engine_near_intake_0 = new THREE.Object3D();
  socket_engine_near_intake_0.name = "intake";
  socket_engine_near_intake_0.position.set(-0.0773, 0.0, 0.0);
  socket_engine_near_intake_0.rotation.set(0, 0, 0);
  socket_engine_near_intake_0.userData.socket = {"id": "intake", "localPosition": [-0.0773, 0, 0]};
  node_engine_near_8.add(socket_engine_near_intake_0);
  sockets["engine-near:intake"] = socket_engine_near_intake_0;

  const endpoint_intake_near_9 = makeAttachmentEndpoint(null);
  const node_intake_near_9 = new THREE.Group();
  node_intake_near_9.name = "Intake (near)__pivot";
  node_intake_near_9.scale.set(1, 1, 1);
  if (endpoint_intake_near_9) {
    node_intake_near_9.position.copy(endpoint_intake_near_9.start);
    node_intake_near_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_intake_near_9.position.set(-0.0733, 0.0, 0.0);
    node_intake_near_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_intake_near_9.userData.sculptComponent = {"id": "intake-near", "name": "Intake (near)", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Blue intake disc on the front of the engine pod.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "engine-near", "attachment": {"parentSocket": "intake", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.016, "height": 0.07, "depth": 0.07, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0733, 0, 0], "rotation": [0, 0, 0], "scale": [0.016, 0.07, 0.07]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.07, 0.07], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "intake-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}}, "material": "porthole-blue", "materialLayers": ["porthole-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 184, 238, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_intake_near_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.07, 0.07], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "intake-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}};
  (nodes["engine-near"] ?? root).add(node_intake_near_9);
  nodes["intake-near"] = node_intake_near_9;
  const mesh_intake_near_9Geometry = endpoint_intake_near_9
    ? new THREE.CylinderGeometry(endpoint_intake_near_9.endRadius, endpoint_intake_near_9.baseRadius, endpoint_intake_near_9.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_intake_near_9) {
    mesh_intake_near_9Geometry.scale(0.016, 0.07, 0.07);
  }
  const mesh_intake_near_9 = new THREE.Mesh(
    mesh_intake_near_9Geometry,
    materialMap["porthole-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_intake_near_9.name = "Intake (near)";
  if (endpoint_intake_near_9) {
    mesh_intake_near_9.position.copy(endpoint_intake_near_9.midpoint);
    mesh_intake_near_9.quaternion.copy(endpoint_intake_near_9.quaternion);
  }
  mesh_intake_near_9.castShadow = options.castShadow ?? true;
  mesh_intake_near_9.receiveShadow = options.receiveShadow ?? true;
  mesh_intake_near_9.userData.sculptComponent = {"id": "intake-near", "name": "Intake (near)", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Blue intake disc on the front of the engine pod.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "engine-near", "attachment": {"parentSocket": "intake", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.016, "height": 0.07, "depth": 0.07, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0733, 0, 0], "rotation": [0, 0, 0], "scale": [0.016, 0.07, 0.07]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.07, 0.07], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "intake-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}}, "material": "porthole-blue", "materialLayers": ["porthole-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 184, 238, 1.0)", "secondaryAlbedo": "rgba(191, 238, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_intake_near_9.add(mesh_intake_near_9);
  meshes["intake-near"] = mesh_intake_near_9;
  colliders["intake-near"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.07, 0.07], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["intake-near"] ??= [];
  destructionGroups["intake-near"].push(node_intake_near_9);

  const endpoint_porthole_1_10 = makeAttachmentEndpoint(null);
  const node_porthole_1_10 = new THREE.Group();
  node_porthole_1_10.name = "Porthole 1__pivot";
  node_porthole_1_10.scale.set(1, 1, 1);
  if (endpoint_porthole_1_10) {
    node_porthole_1_10.position.copy(endpoint_porthole_1_10.start);
    node_porthole_1_10.rotation.set(-0.0024, -0.0234, 1.4693);
  } else {
    node_porthole_1_10.position.set(-0.0057, 0.5051, 0.2414);
    node_porthole_1_10.rotation.set(-0.0024, -0.0234, 1.4693);
  }
  node_porthole_1_10.userData.sculptComponent = {"id": "porthole-1", "name": "Porthole 1", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Porthole 1: flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.06, "height": 0.072, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0057, 0.5051, 0.2414], "rotation": [-0.0024, -0.0234, 1.4693], "scale": [0.06, 0.072, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}}, "material": "porthole-blue", "materialLayers": ["porthole-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.15, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "none (glass)", "displacementPattern": "none", "occlusionPattern": "disc rim", "edgeWearPattern": "none", "notes": "glossy disc"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_porthole_1_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}};
  (nodes["fuselage"] ?? root).add(node_porthole_1_10);
  nodes["porthole-1"] = node_porthole_1_10;
  const mesh_porthole_1_10Geometry = endpoint_porthole_1_10
    ? new THREE.CylinderGeometry(endpoint_porthole_1_10.endRadius, endpoint_porthole_1_10.baseRadius, endpoint_porthole_1_10.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_porthole_1_10) {
    mesh_porthole_1_10Geometry.scale(0.06, 0.072, 0.014);
  }
  const mesh_porthole_1_10 = new THREE.Mesh(
    mesh_porthole_1_10Geometry,
    materialMap["porthole-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_1_10.name = "Porthole 1";
  if (endpoint_porthole_1_10) {
    mesh_porthole_1_10.position.copy(endpoint_porthole_1_10.midpoint);
    mesh_porthole_1_10.quaternion.copy(endpoint_porthole_1_10.quaternion);
  }
  mesh_porthole_1_10.castShadow = options.castShadow ?? true;
  mesh_porthole_1_10.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_1_10.userData.sculptComponent = {"id": "porthole-1", "name": "Porthole 1", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Porthole 1: flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.06, "height": 0.072, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0057, 0.5051, 0.2414], "rotation": [-0.0024, -0.0234, 1.4693], "scale": [0.06, 0.072, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}}, "material": "porthole-blue", "materialLayers": ["porthole-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.15, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "none (glass)", "displacementPattern": "none", "occlusionPattern": "disc rim", "edgeWearPattern": "none", "notes": "glossy disc"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_porthole_1_10.add(mesh_porthole_1_10);
  meshes["porthole-1"] = mesh_porthole_1_10;
  colliders["porthole-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["porthole-1"] ??= [];
  destructionGroups["porthole-1"].push(node_porthole_1_10);

  const endpoint_porthole_2_11 = makeAttachmentEndpoint(null);
  const node_porthole_2_11 = new THREE.Group();
  node_porthole_2_11.name = "Porthole 2__pivot";
  node_porthole_2_11.scale.set(1, 1, 1);
  if (endpoint_porthole_2_11) {
    node_porthole_2_11.position.copy(endpoint_porthole_2_11.start);
    node_porthole_2_11.rotation.set(-0.006, -0.0585, 1.4692);
  } else {
    node_porthole_2_11.position.set(-0.013, 0.5844, 0.2203);
    node_porthole_2_11.rotation.set(-0.006, -0.0585, 1.4692);
  }
  node_porthole_2_11.userData.sculptComponent = {"id": "porthole-2", "name": "Porthole 2", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Porthole 2: flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.06, "height": 0.072, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.013, 0.5844, 0.2203], "rotation": [-0.006, -0.0585, 1.4692], "scale": [0.06, 0.072, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}}, "material": "porthole-blue", "materialLayers": ["porthole-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_porthole_2_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}};
  (nodes["fuselage"] ?? root).add(node_porthole_2_11);
  nodes["porthole-2"] = node_porthole_2_11;
  const mesh_porthole_2_11Geometry = endpoint_porthole_2_11
    ? new THREE.CylinderGeometry(endpoint_porthole_2_11.endRadius, endpoint_porthole_2_11.baseRadius, endpoint_porthole_2_11.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_porthole_2_11) {
    mesh_porthole_2_11Geometry.scale(0.06, 0.072, 0.014);
  }
  const mesh_porthole_2_11 = new THREE.Mesh(
    mesh_porthole_2_11Geometry,
    materialMap["porthole-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_2_11.name = "Porthole 2";
  if (endpoint_porthole_2_11) {
    mesh_porthole_2_11.position.copy(endpoint_porthole_2_11.midpoint);
    mesh_porthole_2_11.quaternion.copy(endpoint_porthole_2_11.quaternion);
  }
  mesh_porthole_2_11.castShadow = options.castShadow ?? true;
  mesh_porthole_2_11.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_2_11.userData.sculptComponent = {"id": "porthole-2", "name": "Porthole 2", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Porthole 2: flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.06, "height": 0.072, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.013, 0.5844, 0.2203], "rotation": [-0.006, -0.0585, 1.4692], "scale": [0.06, 0.072, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}}, "material": "porthole-blue", "materialLayers": ["porthole-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_porthole_2_11.add(mesh_porthole_2_11);
  meshes["porthole-2"] = mesh_porthole_2_11;
  colliders["porthole-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["porthole-2"] ??= [];
  destructionGroups["porthole-2"].push(node_porthole_2_11);

  const endpoint_porthole_3_12 = makeAttachmentEndpoint(null);
  const node_porthole_3_12 = new THREE.Group();
  node_porthole_3_12.name = "Porthole 3__pivot";
  node_porthole_3_12.scale.set(1, 1, 1);
  if (endpoint_porthole_3_12) {
    node_porthole_3_12.position.copy(endpoint_porthole_3_12.start);
    node_porthole_3_12.rotation.set(-0.0114, -0.1116, 1.4687);
  } else {
    node_porthole_3_12.position.set(-0.0212, 0.6615, 0.1883);
    node_porthole_3_12.rotation.set(-0.0114, -0.1116, 1.4687);
  }
  node_porthole_3_12.userData.sculptComponent = {"id": "porthole-3", "name": "Porthole 3", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Porthole 3: flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.06, "height": 0.072, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0212, 0.6615, 0.1883], "rotation": [-0.0114, -0.1116, 1.4687], "scale": [0.06, 0.072, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}}, "material": "porthole-blue", "materialLayers": ["porthole-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_porthole_3_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}};
  (nodes["fuselage"] ?? root).add(node_porthole_3_12);
  nodes["porthole-3"] = node_porthole_3_12;
  const mesh_porthole_3_12Geometry = endpoint_porthole_3_12
    ? new THREE.CylinderGeometry(endpoint_porthole_3_12.endRadius, endpoint_porthole_3_12.baseRadius, endpoint_porthole_3_12.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_porthole_3_12) {
    mesh_porthole_3_12Geometry.scale(0.06, 0.072, 0.014);
  }
  const mesh_porthole_3_12 = new THREE.Mesh(
    mesh_porthole_3_12Geometry,
    materialMap["porthole-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_3_12.name = "Porthole 3";
  if (endpoint_porthole_3_12) {
    mesh_porthole_3_12.position.copy(endpoint_porthole_3_12.midpoint);
    mesh_porthole_3_12.quaternion.copy(endpoint_porthole_3_12.quaternion);
  }
  mesh_porthole_3_12.castShadow = options.castShadow ?? true;
  mesh_porthole_3_12.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_3_12.userData.sculptComponent = {"id": "porthole-3", "name": "Porthole 3", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Porthole 3: flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.06, "height": 0.072, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0212, 0.6615, 0.1883], "rotation": [-0.0114, -0.1116, 1.4687], "scale": [0.06, 0.072, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}}, "material": "porthole-blue", "materialLayers": ["porthole-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_porthole_3_12.add(mesh_porthole_3_12);
  meshes["porthole-3"] = mesh_porthole_3_12;
  colliders["porthole-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["porthole-3"] ??= [];
  destructionGroups["porthole-3"].push(node_porthole_3_12);

  const endpoint_porthole_4_13 = makeAttachmentEndpoint(null);
  const node_porthole_4_13 = new THREE.Group();
  node_porthole_4_13.name = "Porthole 4__pivot";
  node_porthole_4_13.scale.set(1, 1, 1);
  if (endpoint_porthole_4_13) {
    node_porthole_4_13.position.copy(endpoint_porthole_4_13.start);
    node_porthole_4_13.rotation.set(-0.0206, -0.1999, 1.4673);
  } else {
    node_porthole_4_13.position.set(-0.0302, 0.7411, 0.1482);
    node_porthole_4_13.rotation.set(-0.0206, -0.1999, 1.4673);
  }
  node_porthole_4_13.userData.sculptComponent = {"id": "porthole-4", "name": "Porthole 4", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Porthole 4: flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.06, "height": 0.072, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0302, 0.7411, 0.1482], "rotation": [-0.0206, -0.1999, 1.4673], "scale": [0.06, 0.072, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}}, "material": "porthole-blue", "materialLayers": ["porthole-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_porthole_4_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}};
  (nodes["fuselage"] ?? root).add(node_porthole_4_13);
  nodes["porthole-4"] = node_porthole_4_13;
  const mesh_porthole_4_13Geometry = endpoint_porthole_4_13
    ? new THREE.CylinderGeometry(endpoint_porthole_4_13.endRadius, endpoint_porthole_4_13.baseRadius, endpoint_porthole_4_13.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_porthole_4_13) {
    mesh_porthole_4_13Geometry.scale(0.06, 0.072, 0.014);
  }
  const mesh_porthole_4_13 = new THREE.Mesh(
    mesh_porthole_4_13Geometry,
    materialMap["porthole-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_4_13.name = "Porthole 4";
  if (endpoint_porthole_4_13) {
    mesh_porthole_4_13.position.copy(endpoint_porthole_4_13.midpoint);
    mesh_porthole_4_13.quaternion.copy(endpoint_porthole_4_13.quaternion);
  }
  mesh_porthole_4_13.castShadow = options.castShadow ?? true;
  mesh_porthole_4_13.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_4_13.userData.sculptComponent = {"id": "porthole-4", "name": "Porthole 4", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Porthole 4: flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.06, "height": 0.072, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0302, 0.7411, 0.1482], "rotation": [-0.0206, -0.1999, 1.4673], "scale": [0.06, 0.072, 0.014]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "porthole-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "porthole-blue"}}, "material": "porthole-blue", "materialLayers": ["porthole-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_porthole_4_13.add(mesh_porthole_4_13);
  meshes["porthole-4"] = mesh_porthole_4_13;
  colliders["porthole-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 0.072, 0.014], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["porthole-4"] ??= [];
  destructionGroups["porthole-4"].push(node_porthole_4_13);

  const endpoint_eye_a_14 = makeAttachmentEndpoint(null);
  const node_eye_a_14 = new THREE.Group();
  node_eye_a_14.name = "Eye (rear, large)__pivot";
  node_eye_a_14.scale.set(1, 1, 1);
  if (endpoint_eye_a_14) {
    node_eye_a_14.position.copy(endpoint_eye_a_14.start);
    node_eye_a_14.rotation.set(-0.0077, -0.0759, 1.469);
  } else {
    node_eye_a_14.position.set(-0.0195, 0.3693, 0.255);
    node_eye_a_14.rotation.set(-0.0077, -0.0759, 1.469);
  }
  node_eye_a_14.userData.sculptComponent = {"id": "eye-a", "name": "Eye (rear, large)", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Eye (rear, large): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.095, "height": 0.1, "depth": 0.016, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0195, 0.3693, 0.255], "rotation": [-0.0077, -0.0759, 1.469], "scale": [0.095, 0.1, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.095, 0.1, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_a_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.095, 0.1, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["fuselage"] ?? root).add(node_eye_a_14);
  nodes["eye-a"] = node_eye_a_14;
  const mesh_eye_a_14Geometry = endpoint_eye_a_14
    ? new THREE.CylinderGeometry(endpoint_eye_a_14.endRadius, endpoint_eye_a_14.baseRadius, endpoint_eye_a_14.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_a_14) {
    mesh_eye_a_14Geometry.scale(0.095, 0.1, 0.016);
  }
  const mesh_eye_a_14 = new THREE.Mesh(
    mesh_eye_a_14Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_a_14.name = "Eye (rear, large)";
  if (endpoint_eye_a_14) {
    mesh_eye_a_14.position.copy(endpoint_eye_a_14.midpoint);
    mesh_eye_a_14.quaternion.copy(endpoint_eye_a_14.quaternion);
  }
  mesh_eye_a_14.castShadow = options.castShadow ?? true;
  mesh_eye_a_14.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_a_14.userData.sculptComponent = {"id": "eye-a", "name": "Eye (rear, large)", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Eye (rear, large): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.095, "height": 0.1, "depth": 0.016, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0195, 0.3693, 0.255], "rotation": [-0.0077, -0.0759, 1.469], "scale": [0.095, 0.1, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.095, 0.1, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_a_14.add(mesh_eye_a_14);
  meshes["eye-a"] = mesh_eye_a_14;
  colliders["eye-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.095, 0.1, 0.016], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["eye-a"] ??= [];
  destructionGroups["eye-a"].push(node_eye_a_14);

  const endpoint_eye_b_15 = makeAttachmentEndpoint(null);
  const node_eye_b_15 = new THREE.Group();
  node_eye_b_15.name = "Eye (front, small)__pivot";
  node_eye_b_15.scale.set(1, 1, 1);
  if (endpoint_eye_b_15) {
    node_eye_b_15.position.copy(endpoint_eye_b_15.start);
    node_eye_b_15.rotation.set(-0.0388, -0.3637, 1.4622);
  } else {
    node_eye_b_15.position.set(-0.0782, 0.2139, 0.2049);
    node_eye_b_15.rotation.set(-0.0388, -0.3637, 1.4622);
  }
  node_eye_b_15.userData.sculptComponent = {"id": "eye-b", "name": "Eye (front, small)", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Eye (front, small): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.076, "height": 0.082, "depth": 0.016, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0782, 0.2139, 0.2049], "rotation": [-0.0388, -0.3637, 1.4622], "scale": [0.076, 0.082, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.076, 0.082, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_b_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.076, 0.082, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["fuselage"] ?? root).add(node_eye_b_15);
  nodes["eye-b"] = node_eye_b_15;
  const mesh_eye_b_15Geometry = endpoint_eye_b_15
    ? new THREE.CylinderGeometry(endpoint_eye_b_15.endRadius, endpoint_eye_b_15.baseRadius, endpoint_eye_b_15.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_b_15) {
    mesh_eye_b_15Geometry.scale(0.076, 0.082, 0.016);
  }
  const mesh_eye_b_15 = new THREE.Mesh(
    mesh_eye_b_15Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_b_15.name = "Eye (front, small)";
  if (endpoint_eye_b_15) {
    mesh_eye_b_15.position.copy(endpoint_eye_b_15.midpoint);
    mesh_eye_b_15.quaternion.copy(endpoint_eye_b_15.quaternion);
  }
  mesh_eye_b_15.castShadow = options.castShadow ?? true;
  mesh_eye_b_15.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_b_15.userData.sculptComponent = {"id": "eye-b", "name": "Eye (front, small)", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Eye (front, small): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.076, "height": 0.082, "depth": 0.016, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0782, 0.2139, 0.2049], "rotation": [-0.0388, -0.3637, 1.4622], "scale": [0.076, 0.082, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.076, 0.082, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_b_15.add(mesh_eye_b_15);
  meshes["eye-b"] = mesh_eye_b_15;
  colliders["eye-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.076, 0.082, 0.016], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["eye-b"] ??= [];
  destructionGroups["eye-b"].push(node_eye_b_15);

  const endpoint_catchlight_a_16 = makeAttachmentEndpoint(null);
  const node_catchlight_a_16 = new THREE.Group();
  node_catchlight_a_16.name = "Catchlight (rear big)__pivot";
  node_catchlight_a_16.scale.set(1, 1, 1);
  if (endpoint_catchlight_a_16) {
    node_catchlight_a_16.position.copy(endpoint_catchlight_a_16.start);
    node_catchlight_a_16.rotation.set(-0.012, -0.117, 1.4686);
  } else {
    node_catchlight_a_16.position.set(-0.0311, 0.3846, 0.2631);
    node_catchlight_a_16.rotation.set(-0.012, -0.117, 1.4686);
  }
  node_catchlight_a_16.userData.sculptComponent = {"id": "catchlight-a", "name": "Catchlight (rear big)", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (rear big): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0311, 0.3846, 0.2631], "rotation": [-0.012, -0.117, 1.4686], "scale": [0.03, 0.03, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.03, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_a_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.03, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["fuselage"] ?? root).add(node_catchlight_a_16);
  nodes["catchlight-a"] = node_catchlight_a_16;
  const mesh_catchlight_a_16Geometry = endpoint_catchlight_a_16
    ? new THREE.CylinderGeometry(endpoint_catchlight_a_16.endRadius, endpoint_catchlight_a_16.baseRadius, endpoint_catchlight_a_16.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_a_16) {
    mesh_catchlight_a_16Geometry.scale(0.03, 0.03, 0.012);
  }
  const mesh_catchlight_a_16 = new THREE.Mesh(
    mesh_catchlight_a_16Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_a_16.name = "Catchlight (rear big)";
  if (endpoint_catchlight_a_16) {
    mesh_catchlight_a_16.position.copy(endpoint_catchlight_a_16.midpoint);
    mesh_catchlight_a_16.quaternion.copy(endpoint_catchlight_a_16.quaternion);
  }
  mesh_catchlight_a_16.castShadow = options.castShadow ?? true;
  mesh_catchlight_a_16.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_a_16.userData.sculptComponent = {"id": "catchlight-a", "name": "Catchlight (rear big)", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (rear big): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0311, 0.3846, 0.2631], "rotation": [-0.012, -0.117, 1.4686], "scale": [0.03, 0.03, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.03, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_a_16.add(mesh_catchlight_a_16);
  meshes["catchlight-a"] = mesh_catchlight_a_16;
  colliders["catchlight-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.03, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-a"] ??= [];
  destructionGroups["catchlight-a"].push(node_catchlight_a_16);

  const endpoint_catchlight_a2_17 = makeAttachmentEndpoint(null);
  const node_catchlight_a2_17 = new THREE.Group();
  node_catchlight_a2_17.name = "Catchlight (rear small)__pivot";
  node_catchlight_a2_17.scale.set(1, 1, 1);
  if (endpoint_catchlight_a2_17) {
    node_catchlight_a2_17.position.copy(endpoint_catchlight_a2_17.start);
    node_catchlight_a2_17.rotation.set(-0.0003, -0.003, 1.4693);
  } else {
    node_catchlight_a2_17.position.set(-0.0008, 0.3517, 0.2638);
    node_catchlight_a2_17.rotation.set(-0.0003, -0.003, 1.4693);
  }
  node_catchlight_a2_17.userData.sculptComponent = {"id": "catchlight-a2", "name": "Catchlight (rear small)", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (rear small): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.016, "height": 0.016, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0008, 0.3517, 0.2638], "rotation": [-0.0003, -0.003, 1.4693], "scale": [0.016, 0.016, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_a2_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["fuselage"] ?? root).add(node_catchlight_a2_17);
  nodes["catchlight-a2"] = node_catchlight_a2_17;
  const mesh_catchlight_a2_17Geometry = endpoint_catchlight_a2_17
    ? new THREE.CylinderGeometry(endpoint_catchlight_a2_17.endRadius, endpoint_catchlight_a2_17.baseRadius, endpoint_catchlight_a2_17.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_a2_17) {
    mesh_catchlight_a2_17Geometry.scale(0.016, 0.016, 0.012);
  }
  const mesh_catchlight_a2_17 = new THREE.Mesh(
    mesh_catchlight_a2_17Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_a2_17.name = "Catchlight (rear small)";
  if (endpoint_catchlight_a2_17) {
    mesh_catchlight_a2_17.position.copy(endpoint_catchlight_a2_17.midpoint);
    mesh_catchlight_a2_17.quaternion.copy(endpoint_catchlight_a2_17.quaternion);
  }
  mesh_catchlight_a2_17.castShadow = options.castShadow ?? true;
  mesh_catchlight_a2_17.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_a2_17.userData.sculptComponent = {"id": "catchlight-a2", "name": "Catchlight (rear small)", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (rear small): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.016, "height": 0.016, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0008, 0.3517, 0.2638], "rotation": [-0.0003, -0.003, 1.4693], "scale": [0.016, 0.016, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_a2_17.add(mesh_catchlight_a2_17);
  meshes["catchlight-a2"] = mesh_catchlight_a2_17;
  colliders["catchlight-a2"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-a2"] ??= [];
  destructionGroups["catchlight-a2"].push(node_catchlight_a2_17);

  const endpoint_catchlight_b_18 = makeAttachmentEndpoint(null);
  const node_catchlight_b_18 = new THREE.Group();
  node_catchlight_b_18.name = "Catchlight (front)__pivot";
  node_catchlight_b_18.scale.set(1, 1, 1);
  if (endpoint_catchlight_b_18) {
    node_catchlight_b_18.position.copy(endpoint_catchlight_b_18.start);
    node_catchlight_b_18.rotation.set(-0.0418, -0.3895, 1.4611);
  } else {
    node_catchlight_b_18.position.set(-0.0898, 0.23, 0.2181);
    node_catchlight_b_18.rotation.set(-0.0418, -0.3895, 1.4611);
  }
  node_catchlight_b_18.userData.sculptComponent = {"id": "catchlight-b", "name": "Catchlight (front)", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (front): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.026, "height": 0.026, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0898, 0.23, 0.2181], "rotation": [-0.0418, -0.3895, 1.4611], "scale": [0.026, 0.026, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.026, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_b_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.026, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["fuselage"] ?? root).add(node_catchlight_b_18);
  nodes["catchlight-b"] = node_catchlight_b_18;
  const mesh_catchlight_b_18Geometry = endpoint_catchlight_b_18
    ? new THREE.CylinderGeometry(endpoint_catchlight_b_18.endRadius, endpoint_catchlight_b_18.baseRadius, endpoint_catchlight_b_18.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_b_18) {
    mesh_catchlight_b_18Geometry.scale(0.026, 0.026, 0.012);
  }
  const mesh_catchlight_b_18 = new THREE.Mesh(
    mesh_catchlight_b_18Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_b_18.name = "Catchlight (front)";
  if (endpoint_catchlight_b_18) {
    mesh_catchlight_b_18.position.copy(endpoint_catchlight_b_18.midpoint);
    mesh_catchlight_b_18.quaternion.copy(endpoint_catchlight_b_18.quaternion);
  }
  mesh_catchlight_b_18.castShadow = options.castShadow ?? true;
  mesh_catchlight_b_18.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_b_18.userData.sculptComponent = {"id": "catchlight-b", "name": "Catchlight (front)", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (front): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.026, "height": 0.026, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0898, 0.23, 0.2181], "rotation": [-0.0418, -0.3895, 1.4611], "scale": [0.026, 0.026, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.026, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_b_18.add(mesh_catchlight_b_18);
  meshes["catchlight-b"] = mesh_catchlight_b_18;
  colliders["catchlight-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.026, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-b"] ??= [];
  destructionGroups["catchlight-b"].push(node_catchlight_b_18);

  const endpoint_cheek_a_19 = makeAttachmentEndpoint(null);
  const node_cheek_a_19 = new THREE.Group();
  node_cheek_a_19.name = "Cheek (rear)__pivot";
  node_cheek_a_19.scale.set(1, 1, 1);
  if (endpoint_cheek_a_19) {
    node_cheek_a_19.position.copy(endpoint_cheek_a_19.start);
    node_cheek_a_19.rotation.set(0.0171, 0.1665, 1.4679);
  } else {
    node_cheek_a_19.position.set(0.0424, 0.3643, 0.251);
    node_cheek_a_19.rotation.set(0.0171, 0.1665, 1.4679);
  }
  node_cheek_a_19.userData.sculptComponent = {"id": "cheek-a", "name": "Cheek (rear)", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Cheek (rear): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.07, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0424, 0.3643, 0.251], "rotation": [0.0171, 0.1665, 1.4679], "scale": [0.07, 0.034, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.07, 0.034, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_a_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.07, 0.034, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}};
  (nodes["fuselage"] ?? root).add(node_cheek_a_19);
  nodes["cheek-a"] = node_cheek_a_19;
  const mesh_cheek_a_19Geometry = endpoint_cheek_a_19
    ? new THREE.CylinderGeometry(endpoint_cheek_a_19.endRadius, endpoint_cheek_a_19.baseRadius, endpoint_cheek_a_19.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_cheek_a_19) {
    mesh_cheek_a_19Geometry.scale(0.07, 0.034, 0.012);
  }
  const mesh_cheek_a_19 = new THREE.Mesh(
    mesh_cheek_a_19Geometry,
    materialMap["cheek-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cheek_a_19.name = "Cheek (rear)";
  if (endpoint_cheek_a_19) {
    mesh_cheek_a_19.position.copy(endpoint_cheek_a_19.midpoint);
    mesh_cheek_a_19.quaternion.copy(endpoint_cheek_a_19.quaternion);
  }
  mesh_cheek_a_19.castShadow = options.castShadow ?? true;
  mesh_cheek_a_19.receiveShadow = options.receiveShadow ?? true;
  mesh_cheek_a_19.userData.sculptComponent = {"id": "cheek-a", "name": "Cheek (rear)", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Cheek (rear): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.07, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0424, 0.3643, 0.251], "rotation": [0.0171, 0.1665, 1.4679], "scale": [0.07, 0.034, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.07, 0.034, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_a_19.add(mesh_cheek_a_19);
  meshes["cheek-a"] = mesh_cheek_a_19;
  colliders["cheek-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.07, 0.034, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["cheek-a"] ??= [];
  destructionGroups["cheek-a"].push(node_cheek_a_19);

  const endpoint_cheek_b_20 = makeAttachmentEndpoint(null);
  const node_cheek_b_20 = new THREE.Group();
  node_cheek_b_20.name = "Cheek (front)__pivot";
  node_cheek_b_20.scale.set(1, 1, 1);
  if (endpoint_cheek_b_20) {
    node_cheek_b_20.position.copy(endpoint_cheek_b_20.start);
    node_cheek_b_20.rotation.set(-0.0185, -0.1796, 1.4677);
  } else {
    node_cheek_b_20.position.set(-0.034, 0.167, 0.1865);
    node_cheek_b_20.rotation.set(-0.0185, -0.1796, 1.4677);
  }
  node_cheek_b_20.userData.sculptComponent = {"id": "cheek-b", "name": "Cheek (front)", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Cheek (front): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.036, "height": 0.024, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.034, 0.167, 0.1865], "rotation": [-0.0185, -0.1796, 1.4677], "scale": [0.036, 0.024, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.036, 0.024, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_b_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.036, 0.024, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}};
  (nodes["fuselage"] ?? root).add(node_cheek_b_20);
  nodes["cheek-b"] = node_cheek_b_20;
  const mesh_cheek_b_20Geometry = endpoint_cheek_b_20
    ? new THREE.CylinderGeometry(endpoint_cheek_b_20.endRadius, endpoint_cheek_b_20.baseRadius, endpoint_cheek_b_20.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_cheek_b_20) {
    mesh_cheek_b_20Geometry.scale(0.036, 0.024, 0.012);
  }
  const mesh_cheek_b_20 = new THREE.Mesh(
    mesh_cheek_b_20Geometry,
    materialMap["cheek-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cheek_b_20.name = "Cheek (front)";
  if (endpoint_cheek_b_20) {
    mesh_cheek_b_20.position.copy(endpoint_cheek_b_20.midpoint);
    mesh_cheek_b_20.quaternion.copy(endpoint_cheek_b_20.quaternion);
  }
  mesh_cheek_b_20.castShadow = options.castShadow ?? true;
  mesh_cheek_b_20.receiveShadow = options.receiveShadow ?? true;
  mesh_cheek_b_20.userData.sculptComponent = {"id": "cheek-b", "name": "Cheek (front)", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Cheek (front): flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.036, "height": 0.024, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.034, 0.167, 0.1865], "rotation": [-0.0185, -0.1796, 1.4677], "scale": [0.036, 0.024, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.036, 0.024, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_b_20.add(mesh_cheek_b_20);
  meshes["cheek-b"] = mesh_cheek_b_20;
  colliders["cheek-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.036, 0.024, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["cheek-b"] ??= [];
  destructionGroups["cheek-b"].push(node_cheek_b_20);

  const endpoint_nose_gloss_21 = makeAttachmentEndpoint(null);
  const node_nose_gloss_21 = new THREE.Group();
  node_nose_gloss_21.name = "Nose gloss dot__pivot";
  node_nose_gloss_21.scale.set(1, 1, 1);
  if (endpoint_nose_gloss_21) {
    node_nose_gloss_21.position.copy(endpoint_nose_gloss_21.start);
    node_nose_gloss_21.rotation.set(0.0091, 0.0894, 1.4689);
  } else {
    node_nose_gloss_21.position.set(0.0095, 0.0714, 0.1064);
    node_nose_gloss_21.rotation.set(0.0091, 0.0894, 1.4689);
  }
  node_nose_gloss_21.userData.sculptComponent = {"id": "nose-gloss", "name": "Nose gloss dot", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Nose gloss dot: flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.026, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0095, 0.0714, 0.1064], "rotation": [0.0091, 0.0894, 1.4689], "scale": [0.026, 0.034, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.026, 0.034, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose-gloss", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "nose-gloss"}}, "material": "nose-gloss", "materialLayers": ["nose-gloss"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_nose_gloss_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.026, 0.034, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose-gloss", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "nose-gloss"}};
  (nodes["fuselage"] ?? root).add(node_nose_gloss_21);
  nodes["nose-gloss"] = node_nose_gloss_21;
  const mesh_nose_gloss_21Geometry = endpoint_nose_gloss_21
    ? new THREE.CylinderGeometry(endpoint_nose_gloss_21.endRadius, endpoint_nose_gloss_21.baseRadius, endpoint_nose_gloss_21.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_nose_gloss_21) {
    mesh_nose_gloss_21Geometry.scale(0.026, 0.034, 0.012);
  }
  const mesh_nose_gloss_21 = new THREE.Mesh(
    mesh_nose_gloss_21Geometry,
    materialMap["nose-gloss"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_gloss_21.name = "Nose gloss dot";
  if (endpoint_nose_gloss_21) {
    mesh_nose_gloss_21.position.copy(endpoint_nose_gloss_21.midpoint);
    mesh_nose_gloss_21.quaternion.copy(endpoint_nose_gloss_21.quaternion);
  }
  mesh_nose_gloss_21.castShadow = options.castShadow ?? true;
  mesh_nose_gloss_21.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_gloss_21.userData.sculptComponent = {"id": "nose-gloss", "name": "Nose gloss dot", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Nose gloss dot: flat marking seated on the fuselage skin.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.026, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0095, 0.0714, 0.1064], "rotation": [0.0091, 0.0894, 1.4689], "scale": [0.026, 0.034, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.026, 0.034, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose-gloss", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "nose-gloss"}}, "material": "nose-gloss", "materialLayers": ["nose-gloss"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_nose_gloss_21.add(mesh_nose_gloss_21);
  meshes["nose-gloss"] = mesh_nose_gloss_21;
  colliders["nose-gloss"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.026, 0.034, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["nose-gloss"] ??= [];
  destructionGroups["nose-gloss"].push(node_nose_gloss_21);

  const endpoint_belly_stripe_22 = makeAttachmentEndpoint(null);
  const node_belly_stripe_22 = new THREE.Group();
  node_belly_stripe_22.name = "Belly stripe__pivot";
  node_belly_stripe_22.scale.set(1, 1, 1);
  if (endpoint_belly_stripe_22) {
    node_belly_stripe_22.position.copy(endpoint_belly_stripe_22.start);
    node_belly_stripe_22.rotation.set(-0.0, 0.0, 1.4693);
  } else {
    node_belly_stripe_22.position.set(0.335, 0.4628, 0.0);
    node_belly_stripe_22.rotation.set(-0.0, 0.0, 1.4693);
  }
  node_belly_stripe_22.userData.sculptComponent = {"id": "belly-stripe", "name": "Belly stripe", "level": "meso", "role": "detail", "importance": 0.75, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Belly stripe: red band along the blue belly line, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.3006, 0.2376, 0.1764], "rx": 0.0119, "rz": 0.0119, "twist": 0.0}, {"position": [-0.2355, 0.2261, 0.2029], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.175, 0.2213, 0.2149], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.1167, 0.2215, 0.2177], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.0589, 0.2312, 0.2177], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.0011, 0.2462, 0.2123], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [0.057, 0.2671, 0.2053], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [0.1062, 0.286, 0.1924], "rx": 0.0119, "rz": 0.0119, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "belly-stripe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-red"}}, "material": "stripe-red", "materialLayers": ["stripe-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_belly_stripe_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "belly-stripe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-red"}};
  (nodes["fuselage"] ?? root).add(node_belly_stripe_22);
  nodes["belly-stripe"] = node_belly_stripe_22;
  const mesh_belly_stripe_22Geometry = endpoint_belly_stripe_22
    ? new THREE.CylinderGeometry(endpoint_belly_stripe_22.endRadius, endpoint_belly_stripe_22.baseRadius, endpoint_belly_stripe_22.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.3006, 0.2376, 0.1764], "rx": 0.0119, "rz": 0.0119, "twist": 0.0}, {"position": [-0.2355, 0.2261, 0.2029], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.175, 0.2213, 0.2149], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.1167, 0.2215, 0.2177], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.0589, 0.2312, 0.2177], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.0011, 0.2462, 0.2123], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [0.057, 0.2671, 0.2053], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [0.1062, 0.286, 0.1924], "rx": 0.0119, "rz": 0.0119, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_belly_stripe_22) {
    mesh_belly_stripe_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_belly_stripe_22 = new THREE.Mesh(
    mesh_belly_stripe_22Geometry,
    materialMap["stripe-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_belly_stripe_22.name = "Belly stripe";
  if (endpoint_belly_stripe_22) {
    mesh_belly_stripe_22.position.copy(endpoint_belly_stripe_22.midpoint);
    mesh_belly_stripe_22.quaternion.copy(endpoint_belly_stripe_22.quaternion);
  }
  mesh_belly_stripe_22.castShadow = options.castShadow ?? true;
  mesh_belly_stripe_22.receiveShadow = options.receiveShadow ?? true;
  mesh_belly_stripe_22.userData.sculptComponent = {"id": "belly-stripe", "name": "Belly stripe", "level": "meso", "role": "detail", "importance": 0.75, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Belly stripe: red band along the blue belly line, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.3006, 0.2376, 0.1764], "rx": 0.0119, "rz": 0.0119, "twist": 0.0}, {"position": [-0.2355, 0.2261, 0.2029], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.175, 0.2213, 0.2149], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.1167, 0.2215, 0.2177], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.0589, 0.2312, 0.2177], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [-0.0011, 0.2462, 0.2123], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [0.057, 0.2671, 0.2053], "rx": 0.034, "rz": 0.034, "twist": 0.0}, {"position": [0.1062, 0.286, 0.1924], "rx": 0.0119, "rz": 0.0119, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "belly-stripe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-red"}}, "material": "stripe-red", "materialLayers": ["stripe-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_belly_stripe_22.add(mesh_belly_stripe_22);
  meshes["belly-stripe"] = mesh_belly_stripe_22;
  colliders["belly-stripe"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["belly-stripe"] ??= [];
  destructionGroups["belly-stripe"].push(node_belly_stripe_22);

  const endpoint_fin_stripe_red_23 = makeAttachmentEndpoint(null);
  const node_fin_stripe_red_23 = new THREE.Group();
  node_fin_stripe_red_23.name = "Fin stripe (red)__pivot";
  node_fin_stripe_red_23.scale.set(1, 1, 1);
  if (endpoint_fin_stripe_red_23) {
    node_fin_stripe_red_23.position.copy(endpoint_fin_stripe_red_23.start);
    node_fin_stripe_red_23.rotation.set(-0.0, 0.0, 1.4693);
  } else {
    node_fin_stripe_red_23.position.set(0.335, 0.4628, 0.0);
    node_fin_stripe_red_23.rotation.set(-0.0, 0.0, 1.4693);
  }
  node_fin_stripe_red_23.userData.sculptComponent = {"id": "fin-stripe-red", "name": "Fin stripe (red)", "level": "meso", "role": "detail", "importance": 0.7, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Fin stripe (red): red stripe along the fin trailing edge running down the rear fuselage to the wing, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.4765, 0.7047, 0.0135], "rx": 0.0052, "rz": 0.0052, "twist": 0.0}, {"position": [0.4653, 0.5996, 0.0135], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.4541, 0.4877, 0.0135], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.4452, 0.4072, 0.0135], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.3691, 0.349, 0.0641], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.2764, 0.3073, 0.108], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.174, 0.2804, 0.1578], "rx": 0.0052, "rz": 0.0052, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fin-stripe-red", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-red"}}, "material": "stripe-red", "materialLayers": ["stripe-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_fin_stripe_red_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fin-stripe-red", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-red"}};
  (nodes["fuselage"] ?? root).add(node_fin_stripe_red_23);
  nodes["fin-stripe-red"] = node_fin_stripe_red_23;
  const mesh_fin_stripe_red_23Geometry = endpoint_fin_stripe_red_23
    ? new THREE.CylinderGeometry(endpoint_fin_stripe_red_23.endRadius, endpoint_fin_stripe_red_23.baseRadius, endpoint_fin_stripe_red_23.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.4765, 0.7047, 0.0135], "rx": 0.0052, "rz": 0.0052, "twist": 0.0}, {"position": [0.4653, 0.5996, 0.0135], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.4541, 0.4877, 0.0135], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.4452, 0.4072, 0.0135], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.3691, 0.349, 0.0641], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.2764, 0.3073, 0.108], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.174, 0.2804, 0.1578], "rx": 0.0052, "rz": 0.0052, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_fin_stripe_red_23) {
    mesh_fin_stripe_red_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_stripe_red_23 = new THREE.Mesh(
    mesh_fin_stripe_red_23Geometry,
    materialMap["stripe-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_stripe_red_23.name = "Fin stripe (red)";
  if (endpoint_fin_stripe_red_23) {
    mesh_fin_stripe_red_23.position.copy(endpoint_fin_stripe_red_23.midpoint);
    mesh_fin_stripe_red_23.quaternion.copy(endpoint_fin_stripe_red_23.quaternion);
  }
  mesh_fin_stripe_red_23.castShadow = options.castShadow ?? true;
  mesh_fin_stripe_red_23.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_stripe_red_23.userData.sculptComponent = {"id": "fin-stripe-red", "name": "Fin stripe (red)", "level": "meso", "role": "detail", "importance": 0.7, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Fin stripe (red): red stripe along the fin trailing edge running down the rear fuselage to the wing, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.4765, 0.7047, 0.0135], "rx": 0.0052, "rz": 0.0052, "twist": 0.0}, {"position": [0.4653, 0.5996, 0.0135], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.4541, 0.4877, 0.0135], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.4452, 0.4072, 0.0135], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.3691, 0.349, 0.0641], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.2764, 0.3073, 0.108], "rx": 0.013, "rz": 0.013, "twist": 0.0}, {"position": [0.174, 0.2804, 0.1578], "rx": 0.0052, "rz": 0.0052, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fin-stripe-red", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-red"}}, "material": "stripe-red", "materialLayers": ["stripe-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_fin_stripe_red_23.add(mesh_fin_stripe_red_23);
  meshes["fin-stripe-red"] = mesh_fin_stripe_red_23;
  colliders["fin-stripe-red"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["fin-stripe-red"] ??= [];
  destructionGroups["fin-stripe-red"].push(node_fin_stripe_red_23);

  const endpoint_fin_stripe_blue_24 = makeAttachmentEndpoint(null);
  const node_fin_stripe_blue_24 = new THREE.Group();
  node_fin_stripe_blue_24.name = "Fin stripe (blue)__pivot";
  node_fin_stripe_blue_24.scale.set(1, 1, 1);
  if (endpoint_fin_stripe_blue_24) {
    node_fin_stripe_blue_24.position.copy(endpoint_fin_stripe_blue_24.start);
    node_fin_stripe_blue_24.rotation.set(-0.0, 0.0, 1.4693);
  } else {
    node_fin_stripe_blue_24.position.set(0.335, 0.4628, 0.0);
    node_fin_stripe_blue_24.rotation.set(-0.0, 0.0, 1.4693);
  }
  node_fin_stripe_blue_24.userData.sculptComponent = {"id": "fin-stripe-blue", "name": "Fin stripe (blue)", "level": "meso", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Fin stripe (blue): blue stripe behind the red one, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.4989, 0.7114, 0.0135], "rx": 0.0044, "rz": 0.0044, "twist": 0.0}, {"position": [0.4899, 0.5996, 0.0135], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.481, 0.4877, 0.0135], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.4743, 0.3982, 0.0135], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.4161, 0.3199, 0.0], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.3378, 0.2729, 0.0], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.252, 0.256, 0.0881], "rx": 0.0044, "rz": 0.0044, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fin-stripe-blue", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "fin-blue"}}, "material": "fin-blue", "materialLayers": ["fin-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_fin_stripe_blue_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fin-stripe-blue", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "fin-blue"}};
  (nodes["fuselage"] ?? root).add(node_fin_stripe_blue_24);
  nodes["fin-stripe-blue"] = node_fin_stripe_blue_24;
  const mesh_fin_stripe_blue_24Geometry = endpoint_fin_stripe_blue_24
    ? new THREE.CylinderGeometry(endpoint_fin_stripe_blue_24.endRadius, endpoint_fin_stripe_blue_24.baseRadius, endpoint_fin_stripe_blue_24.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.4989, 0.7114, 0.0135], "rx": 0.0044, "rz": 0.0044, "twist": 0.0}, {"position": [0.4899, 0.5996, 0.0135], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.481, 0.4877, 0.0135], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.4743, 0.3982, 0.0135], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.4161, 0.3199, 0.0], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.3378, 0.2729, 0.0], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.252, 0.256, 0.0881], "rx": 0.0044, "rz": 0.0044, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_fin_stripe_blue_24) {
    mesh_fin_stripe_blue_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fin_stripe_blue_24 = new THREE.Mesh(
    mesh_fin_stripe_blue_24Geometry,
    materialMap["fin-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fin_stripe_blue_24.name = "Fin stripe (blue)";
  if (endpoint_fin_stripe_blue_24) {
    mesh_fin_stripe_blue_24.position.copy(endpoint_fin_stripe_blue_24.midpoint);
    mesh_fin_stripe_blue_24.quaternion.copy(endpoint_fin_stripe_blue_24.quaternion);
  }
  mesh_fin_stripe_blue_24.castShadow = options.castShadow ?? true;
  mesh_fin_stripe_blue_24.receiveShadow = options.receiveShadow ?? true;
  mesh_fin_stripe_blue_24.userData.sculptComponent = {"id": "fin-stripe-blue", "name": "Fin stripe (blue)", "level": "meso", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Fin stripe (blue): blue stripe behind the red one, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.4989, 0.7114, 0.0135], "rx": 0.0044, "rz": 0.0044, "twist": 0.0}, {"position": [0.4899, 0.5996, 0.0135], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.481, 0.4877, 0.0135], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.4743, 0.3982, 0.0135], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.4161, 0.3199, 0.0], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.3378, 0.2729, 0.0], "rx": 0.011, "rz": 0.011, "twist": 0.0}, {"position": [0.252, 0.256, 0.0881], "rx": 0.0044, "rz": 0.0044, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fin-stripe-blue", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "fin-blue"}}, "material": "fin-blue", "materialLayers": ["fin-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_fin_stripe_blue_24.add(mesh_fin_stripe_blue_24);
  meshes["fin-stripe-blue"] = mesh_fin_stripe_blue_24;
  colliders["fin-stripe-blue"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["fin-stripe-blue"] ??= [];
  destructionGroups["fin-stripe-blue"].push(node_fin_stripe_blue_24);

  const endpoint_smile_25 = makeAttachmentEndpoint(null);
  const node_smile_25 = new THREE.Group();
  node_smile_25.name = "Smile__pivot";
  node_smile_25.scale.set(1, 1, 1);
  if (endpoint_smile_25) {
    node_smile_25.position.copy(endpoint_smile_25.start);
    node_smile_25.rotation.set(-0.0, 0.0, 1.4693);
  } else {
    node_smile_25.position.set(0.335, 0.4628, 0.0);
    node_smile_25.rotation.set(-0.0, 0.0, 1.4693);
  }
  node_smile_25.userData.sculptComponent = {"id": "smile", "name": "Smile", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Smile: thin painted stroke on the nose, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.2615, 0.3355, 0.2336], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.2469, 0.3128, 0.2396], "rx": 0.008, "rz": 0.008, "twist": 0.0}, {"position": [-0.2266, 0.2997, 0.2461], "rx": 0.008, "rz": 0.008, "twist": 0.0}, {"position": [-0.2065, 0.3093, 0.2522], "rx": 0.008, "rz": 0.008, "twist": 0.0}, {"position": [-0.191, 0.3338, 0.2548], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smile", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_smile_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smile", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["fuselage"] ?? root).add(node_smile_25);
  nodes["smile"] = node_smile_25;
  const mesh_smile_25Geometry = endpoint_smile_25
    ? new THREE.CylinderGeometry(endpoint_smile_25.endRadius, endpoint_smile_25.baseRadius, endpoint_smile_25.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.2615, 0.3355, 0.2336], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.2469, 0.3128, 0.2396], "rx": 0.008, "rz": 0.008, "twist": 0.0}, {"position": [-0.2266, 0.2997, 0.2461], "rx": 0.008, "rz": 0.008, "twist": 0.0}, {"position": [-0.2065, 0.3093, 0.2522], "rx": 0.008, "rz": 0.008, "twist": 0.0}, {"position": [-0.191, 0.3338, 0.2548], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_smile_25) {
    mesh_smile_25Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_smile_25 = new THREE.Mesh(
    mesh_smile_25Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_smile_25.name = "Smile";
  if (endpoint_smile_25) {
    mesh_smile_25.position.copy(endpoint_smile_25.midpoint);
    mesh_smile_25.quaternion.copy(endpoint_smile_25.quaternion);
  }
  mesh_smile_25.castShadow = options.castShadow ?? true;
  mesh_smile_25.receiveShadow = options.receiveShadow ?? true;
  mesh_smile_25.userData.sculptComponent = {"id": "smile", "name": "Smile", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Smile: thin painted stroke on the nose, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.2615, 0.3355, 0.2336], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.2469, 0.3128, 0.2396], "rx": 0.008, "rz": 0.008, "twist": 0.0}, {"position": [-0.2266, 0.2997, 0.2461], "rx": 0.008, "rz": 0.008, "twist": 0.0}, {"position": [-0.2065, 0.3093, 0.2522], "rx": 0.008, "rz": 0.008, "twist": 0.0}, {"position": [-0.191, 0.3338, 0.2548], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smile", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_smile_25.add(mesh_smile_25);
  meshes["smile"] = mesh_smile_25;
  colliders["smile"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["smile"] ??= [];
  destructionGroups["smile"].push(node_smile_25);

  const endpoint_brow_a_26 = makeAttachmentEndpoint(null);
  const node_brow_a_26 = new THREE.Group();
  node_brow_a_26.name = "Eyebrow (rear)__pivot";
  node_brow_a_26.scale.set(1, 1, 1);
  if (endpoint_brow_a_26) {
    node_brow_a_26.position.copy(endpoint_brow_a_26.start);
    node_brow_a_26.rotation.set(-0.0, 0.0, 1.4693);
  } else {
    node_brow_a_26.position.set(0.335, 0.4628, 0.0);
    node_brow_a_26.rotation.set(-0.0, 0.0, 1.4693);
  }
  node_brow_a_26.userData.sculptComponent = {"id": "brow-a", "name": "Eyebrow (rear)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Eyebrow (rear): thin painted stroke on the nose, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.124, 0.3978, 0.2504], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.1094, 0.4111, 0.2466], "rx": 0.006, "rz": 0.006, "twist": 0.0}, {"position": [-0.0924, 0.4092, 0.2472], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_brow_a_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["fuselage"] ?? root).add(node_brow_a_26);
  nodes["brow-a"] = node_brow_a_26;
  const mesh_brow_a_26Geometry = endpoint_brow_a_26
    ? new THREE.CylinderGeometry(endpoint_brow_a_26.endRadius, endpoint_brow_a_26.baseRadius, endpoint_brow_a_26.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.124, 0.3978, 0.2504], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.1094, 0.4111, 0.2466], "rx": 0.006, "rz": 0.006, "twist": 0.0}, {"position": [-0.0924, 0.4092, 0.2472], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_brow_a_26) {
    mesh_brow_a_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_brow_a_26 = new THREE.Mesh(
    mesh_brow_a_26Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_a_26.name = "Eyebrow (rear)";
  if (endpoint_brow_a_26) {
    mesh_brow_a_26.position.copy(endpoint_brow_a_26.midpoint);
    mesh_brow_a_26.quaternion.copy(endpoint_brow_a_26.quaternion);
  }
  mesh_brow_a_26.castShadow = options.castShadow ?? true;
  mesh_brow_a_26.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_a_26.userData.sculptComponent = {"id": "brow-a", "name": "Eyebrow (rear)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Eyebrow (rear): thin painted stroke on the nose, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.124, 0.3978, 0.2504], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.1094, 0.4111, 0.2466], "rx": 0.006, "rz": 0.006, "twist": 0.0}, {"position": [-0.0924, 0.4092, 0.2472], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_brow_a_26.add(mesh_brow_a_26);
  meshes["brow-a"] = mesh_brow_a_26;
  colliders["brow-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["brow-a"] ??= [];
  destructionGroups["brow-a"].push(node_brow_a_26);

  const endpoint_brow_b_27 = makeAttachmentEndpoint(null);
  const node_brow_b_27 = new THREE.Group();
  node_brow_b_27.name = "Eyebrow (front)__pivot";
  node_brow_b_27.scale.set(1, 1, 1);
  if (endpoint_brow_b_27) {
    node_brow_b_27.position.copy(endpoint_brow_b_27.start);
    node_brow_b_27.rotation.set(-0.0, 0.0, 1.4693);
  } else {
    node_brow_b_27.position.set(0.335, 0.4628, 0.0);
    node_brow_b_27.rotation.set(-0.0, 0.0, 1.4693);
  }
  node_brow_b_27.userData.sculptComponent = {"id": "brow-b", "name": "Eyebrow (front)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Eyebrow (front): thin painted stroke on the nose, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.2973, 0.4465, 0.1734], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.2826, 0.4562, 0.1767], "rx": 0.005, "rz": 0.005, "twist": 0.0}, {"position": [-0.2632, 0.451, 0.1923], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_brow_b_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["fuselage"] ?? root).add(node_brow_b_27);
  nodes["brow-b"] = node_brow_b_27;
  const mesh_brow_b_27Geometry = endpoint_brow_b_27
    ? new THREE.CylinderGeometry(endpoint_brow_b_27.endRadius, endpoint_brow_b_27.baseRadius, endpoint_brow_b_27.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.2973, 0.4465, 0.1734], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.2826, 0.4562, 0.1767], "rx": 0.005, "rz": 0.005, "twist": 0.0}, {"position": [-0.2632, 0.451, 0.1923], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_brow_b_27) {
    mesh_brow_b_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_brow_b_27 = new THREE.Mesh(
    mesh_brow_b_27Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_b_27.name = "Eyebrow (front)";
  if (endpoint_brow_b_27) {
    mesh_brow_b_27.position.copy(endpoint_brow_b_27.midpoint);
    mesh_brow_b_27.quaternion.copy(endpoint_brow_b_27.quaternion);
  }
  mesh_brow_b_27.castShadow = options.castShadow ?? true;
  mesh_brow_b_27.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_b_27.userData.sculptComponent = {"id": "brow-b", "name": "Eyebrow (front)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Eyebrow (front): thin painted stroke on the nose, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.2973, 0.4465, 0.1734], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.2826, 0.4562, 0.1767], "rx": 0.005, "rz": 0.005, "twist": 0.0}, {"position": [-0.2632, 0.451, 0.1923], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "fuselage", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.335, 0.4628, 0.0], "rotation": [-0.0, 0.0, 1.4693], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_brow_b_27.add(mesh_brow_b_27);
  meshes["brow-b"] = mesh_brow_b_27;
  colliders["brow-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["brow-b"] ??= [];
  destructionGroups["brow-b"].push(node_brow_b_27);

  // repetition system: portholes (InstancedMesh, radial, count=4, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
    const mat = materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 4);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 4; i++) {
      const ang = ((0.0) + (i * 360) / 4) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "portholes";
    parent.add(cluster);
  }

  // repetition system: lifting-surfaces (InstancedMesh, radial, count=2, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
    const mat = materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 2);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 2; i++) {
      const ang = ((0.0) + (i * 360) / 2) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "lifting-surfaces";
    parent.add(cluster);
  }

  // repetition system: fin-stripes (InstancedMesh, radial, count=2, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
    const mat = materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 2);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 2; i++) {
      const ang = ((0.0) + (i * 360) / 2) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "fin-stripes";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createWigglePlayPlaneLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "WigglePlay plane look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "directional", "direction": [-0.35, 0.6, 1.0], "intensity": 1.5, "color": "#ffffff", "castShadow": true, "evidence": "the sticker is lit flat from the viewer side; a frontal upper-left key lights the near side fully"}, {"id": "fill", "type": "hemisphere", "skyColor": "#ffffff", "groundColor": "#eef2fa", "intensity": 1.0, "evidence": "near-white cool ground so the white airframe and blue belly are not dimmed from below (the sticker is flat-lit)"}, {"id": "rim", "type": "directional", "direction": [0.5, 0.4, -1.0], "intensity": 0.5, "color": "#e6d6ff", "evidence": "lighter edge along the top silhouette"}, {"id": "exposure", "type": "renderer", "toneMapping": "Neutral", "exposure": 1.55, "outputColorSpace": "srgb", "evidence": "Neutral keeps the saturated blue and red; exposure 1.55 brings the white side to the sampled value"}, {"id": "ground", "type": "contact-shadow", "contactShadow": "soft blurred disc under the object, opacity 0.35; ambient occlusion via material AO channel disabled (textureless)", "evidence": "sticker has no cast shadow; a soft contact shadow grounds the 3D prop"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createWigglePlayPlaneEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameWigglePlayPlaneCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createWigglePlayPlanePresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureWigglePlayPlaneRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createWigglePlayPlaneInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}

export const GENERATED_STAMP = "gen-1788894336-28456";
