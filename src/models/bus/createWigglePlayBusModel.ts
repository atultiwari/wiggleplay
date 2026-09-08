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

// Generated from ObjectSculptSpec target: WigglePlay Bus
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createWigglePlayBusModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "WigglePlay Bus";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["hidden"] = createSculptMaterial(
    "hidden",
    {"id": "hidden", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000"]}, "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "roughness": {"base": 1.0, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": ""}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": [], "notes": "invisible carrier", "opacity": {"base": 0.0}, "qualityTier": "utility", "textureless": {"declared": true, "evidence": ["invisible root carrier; never rendered"]}},
    options
  );
  materialMap["bus-yellow"] = createSculptMaterial(
    "bus-yellow",
    {"id": "bus-yellow", "name": "Bus body yellow", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ffc61e", "color": "#ffc61e", "albedo": {"dominant": "#ffc61e", "secondary": ["#ffd75c", "#ff8c2e"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ffc61e", "#ffd75c", "#ff8c2e"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.45, "variation": 0.05}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "roof-band", "region": "upper body", "color": "#ffd75c", "note": "lighter roof band (vertexPaint axis-band)"}, {"id": "outline", "region": "silhouette", "color": "#221b17", "note": "2D sticker outline; optional runtime inverted hull, not geometry"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["orange-trim"] = createSculptMaterial(
    "orange-trim",
    {"id": "orange-trim", "name": "Orange trim", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ff8c2e", "color": "#ff8c2e", "albedo": {"dominant": "#ff8c2e", "secondary": ["#ff8c2e"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ff8c2e", "#ff8c2e"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.55, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#ff8c2e", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["glass-blue"] = createSculptMaterial(
    "glass-blue",
    {"id": "glass-blue", "name": "Window glass", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#9ddcff", "color": "#9ddcff", "albedo": {"dominant": "#9ddcff", "secondary": ["#d6f1ff", "#5fb8f0"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#9ddcff", "#d6f1ff", "#5fb8f0"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.1, "variation": 0.03}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "highlight-streaks", "region": "diagonal upper-left of each pane", "color": "#d6f1ff", "note": "two lighter diagonal streaks per pane (vertexPaint tapered-capsule)"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}, "clearcoat": {"base": 0.8}, "clearcoatRoughness": {"base": 0.08}},
    options
  );
  materialMap["dark-matte"] = createSculptMaterial(
    "dark-matte",
    {"id": "dark-matte", "name": "Dark interior / lines", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#221b17", "color": "#221b17", "albedo": {"dominant": "#221b17", "secondary": ["#221b17"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#221b17", "#221b17"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.85, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#221b17", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["tyre-rubber"] = createSculptMaterial(
    "tyre-rubber",
    {"id": "tyre-rubber", "name": "Tyre rubber", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#3b2b1f", "color": "#3b2b1f", "albedo": {"dominant": "#3b2b1f", "secondary": ["#2a1d14"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#3b2b1f", "#2a1d14"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.9, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "tread-rim", "region": "tyre shoulder", "color": "#2a1d14", "note": "darker rim ring (vertexPaint axis-band on the cylinder)"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["hub-yellow"] = createSculptMaterial(
    "hub-yellow",
    {"id": "hub-yellow", "name": "Hub cap", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ffd24a", "color": "#ffd24a", "albedo": {"dominant": "#ffd24a", "secondary": ["#ffc61e"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ffd24a", "#ffc61e"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.4, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#ffd24a", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}, "clearcoat": {"base": 0.3}, "clearcoatRoughness": {"base": 0.2}},
    options
  );
  materialMap["cheek-pink"] = createSculptMaterial(
    "cheek-pink",
    {"id": "cheek-pink", "name": "Cheek blush", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#f7a0bd", "color": "#f7a0bd", "albedo": {"dominant": "#f7a0bd", "secondary": ["#f7a0bd"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#f7a0bd", "#f7a0bd"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.5, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#f7a0bd", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["catchlight"] = createSculptMaterial(
    "catchlight",
    {"id": "catchlight", "name": "Catchlight white", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ffffff", "color": "#ffffff", "albedo": {"dominant": "#ffffff", "secondary": ["#ffffff"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ffffff", "#ffffff"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.35, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#ffffff", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}, "emissive": "#ffffff", "emissiveIntensity": {"base": 1.0}},
    options
  );
  materialMap["headlight-glow"] = createSculptMaterial(
    "headlight-glow",
    {"id": "headlight-glow", "name": "Headlight", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#bfe8ff", "color": "#bfe8ff", "albedo": {"dominant": "#bfe8ff", "secondary": ["#ffffff"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#bfe8ff", "#ffffff"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.15, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#bfe8ff", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}, "emissive": "#8fd4ff", "emissiveIntensity": {"base": 0.4}, "clearcoat": {"base": 0.8}, "clearcoatRoughness": {"base": 0.1}},
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

  const endpoint_body_1 = makeAttachmentEndpoint(null);
  const node_body_1 = new THREE.Group();
  node_body_1.name = "Body__pivot";
  node_body_1.scale.set(1, 1, 1);
  if (endpoint_body_1) {
    node_body_1.position.copy(endpoint_body_1.start);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_body_1.position.set(0.0, 0.0, -0.21);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "The yellow body is one continuous rigid volume whose side outline (rounded roof, sloping hood, flat floor) was measured column-by-column from the reference and extruded through the bus width; the hood is part of this profile, not a separate box.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.4936, 0.1202], [-0.4807, 0.2124], [-0.4678, 0.4206], [-0.4549, 0.4614], [-0.4421, 0.485], [-0.4292, 0.4957], [-0.4163, 0.5043], [-0.4034, 0.5107], [-0.3906, 0.515], [-0.3777, 0.5172], [-0.3648, 0.5215], [-0.3519, 0.5236], [-0.3391, 0.5258], [-0.3262, 0.5279], [-0.3133, 0.5279], [-0.3004, 0.53], [-0.2876, 0.5322], [-0.2747, 0.5322], [-0.2618, 0.5343], [-0.2489, 0.5343], [-0.2361, 0.5343], [-0.2232, 0.5365], [-0.2103, 0.5365], [-0.1974, 0.5365], [-0.1845, 0.5365], [-0.1717, 0.5365], [-0.1588, 0.5365], [-0.1459, 0.5386], [-0.133, 0.5386], [-0.1202, 0.5386], [-0.1073, 0.5386], [-0.0944, 0.5365], [-0.0815, 0.5365], [-0.0687, 0.5365], [-0.0558, 0.5365], [-0.0429, 0.5365], [-0.03, 0.5365], [-0.0172, 0.5365], [-0.0043, 0.5365], [0.0086, 0.5365], [0.0215, 0.5365], [0.0343, 0.5343], [0.0472, 0.5343], [0.0601, 0.5343], [0.073, 0.5343], [0.0858, 0.5343], [0.0987, 0.5322], [0.1116, 0.5322], [0.1245, 0.5322], [0.1373, 0.53], [0.1502, 0.53], [0.1631, 0.53], [0.176, 0.5279], [0.1888, 0.5279], [0.2017, 0.5258], [0.2146, 0.5236], [0.2275, 0.5215], [0.2403, 0.5193], [0.2532, 0.515], [0.2661, 0.5107], [0.279, 0.5043], [0.2918, 0.4914], [0.3047, 0.4635], [0.3176, 0.4206], [0.3305, 0.3562], [0.3433, 0.3047], [0.3562, 0.294], [0.3691, 0.2897], [0.382, 0.2876], [0.3948, 0.2811], [0.4077, 0.2768], [0.4206, 0.2725], [0.4335, 0.2661], [0.4464, 0.2575], [0.4592, 0.2361], [0.4721, 0.2146], [0.485, 0.1996], [0.4957, 0.1223], [0.4979, 0.0408], [-0.4957, 0.0408]], "depth": 0.42}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 0.498, "depth": 0.42, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, -0.21], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "axle-rear", "localPosition": [-0.3069, 0.0858, 0.21]}, {"id": "axle-front", "localPosition": [0.1803, 0.0858, 0.21]}, {"id": "side", "localPosition": [0, 0.2811, 0.42]}, {"id": "front", "localPosition": [0.4979, 0.1738, 0.21]}, {"id": "rear", "localPosition": [-0.4957, 0.0987, 0.21]}], "collider": {"type": "box", "offset": [0.0011, 0.2897, 0.21], "scale": [0.9936, 0.4978, 0.42], "isTrigger": false, "notes": "box proxy around the extruded body"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "bus-yellow"}}, "material": "bus-yellow", "materialLayers": ["bus-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roof-band", "kind": "decal", "note": "lighter roof band (vertexPaint)"}, {"id": "stripe", "kind": "linework", "note": "double orange side stripe built as components stripe-1/2"}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.03, "bumpAmplitude": 0.0, "normalPattern": "none (flat satin paint)", "displacementPattern": "none", "occlusionPattern": "contact darkening under the stripe, panes and wheel arches", "edgeWearPattern": "none", "notes": "chamfer-free extrude; edges read via shading only"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 198, 30, 1.0)", "secondaryAlbedo": "rgba(255, 215, 92, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour", "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(255, 198, 30, 1.0)"}, {"t": 1.0, "color": "rgba(255, 215, 92, 1.0)"}]}}, "vertexPaint": {"baseColor": "#ffc61e", "regions": [{"id": "roof-band", "kind": "axis-band", "axis": "y", "min": 0.4742, "max": 1.0, "softness": 0.05, "color": "#ffd75c"}]}};
  node_body_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "axle-rear", "localPosition": [-0.3069, 0.0858, 0.21]}, {"id": "axle-front", "localPosition": [0.1803, 0.0858, 0.21]}, {"id": "side", "localPosition": [0, 0.2811, 0.42]}, {"id": "front", "localPosition": [0.4979, 0.1738, 0.21]}, {"id": "rear", "localPosition": [-0.4957, 0.0987, 0.21]}], "collider": {"type": "box", "offset": [0.0011, 0.2897, 0.21], "scale": [0.9936, 0.4978, 0.42], "isTrigger": false, "notes": "box proxy around the extruded body"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "bus-yellow"}};
  (nodes["root"] ?? root).add(node_body_1);
  nodes["body"] = node_body_1;
  const mesh_body_1Geometry = endpoint_body_1
    ? new THREE.CylinderGeometry(endpoint_body_1.endRadius, endpoint_body_1.baseRadius, endpoint_body_1.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.4936, 0.1202], [-0.4807, 0.2124], [-0.4678, 0.4206], [-0.4549, 0.4614], [-0.4421, 0.485], [-0.4292, 0.4957], [-0.4163, 0.5043], [-0.4034, 0.5107], [-0.3906, 0.515], [-0.3777, 0.5172], [-0.3648, 0.5215], [-0.3519, 0.5236], [-0.3391, 0.5258], [-0.3262, 0.5279], [-0.3133, 0.5279], [-0.3004, 0.53], [-0.2876, 0.5322], [-0.2747, 0.5322], [-0.2618, 0.5343], [-0.2489, 0.5343], [-0.2361, 0.5343], [-0.2232, 0.5365], [-0.2103, 0.5365], [-0.1974, 0.5365], [-0.1845, 0.5365], [-0.1717, 0.5365], [-0.1588, 0.5365], [-0.1459, 0.5386], [-0.133, 0.5386], [-0.1202, 0.5386], [-0.1073, 0.5386], [-0.0944, 0.5365], [-0.0815, 0.5365], [-0.0687, 0.5365], [-0.0558, 0.5365], [-0.0429, 0.5365], [-0.03, 0.5365], [-0.0172, 0.5365], [-0.0043, 0.5365], [0.0086, 0.5365], [0.0215, 0.5365], [0.0343, 0.5343], [0.0472, 0.5343], [0.0601, 0.5343], [0.073, 0.5343], [0.0858, 0.5343], [0.0987, 0.5322], [0.1116, 0.5322], [0.1245, 0.5322], [0.1373, 0.53], [0.1502, 0.53], [0.1631, 0.53], [0.176, 0.5279], [0.1888, 0.5279], [0.2017, 0.5258], [0.2146, 0.5236], [0.2275, 0.5215], [0.2403, 0.5193], [0.2532, 0.515], [0.2661, 0.5107], [0.279, 0.5043], [0.2918, 0.4914], [0.3047, 0.4635], [0.3176, 0.4206], [0.3305, 0.3562], [0.3433, 0.3047], [0.3562, 0.294], [0.3691, 0.2897], [0.382, 0.2876], [0.3948, 0.2811], [0.4077, 0.2768], [0.4206, 0.2725], [0.4335, 0.2661], [0.4464, 0.2575], [0.4592, 0.2361], [0.4721, 0.2146], [0.485, 0.1996], [0.4957, 0.1223], [0.4979, 0.0408], [-0.4957, 0.0408]], "depth": 0.42});
  if (!endpoint_body_1) {
    mesh_body_1Geometry.scale(1.0, 1.0, 1.0);
  }
  applyVertexPaint(mesh_body_1Geometry, "#ffc61e", [{"id": "roof-band", "kind": "axis-band", "color": "#ffd75c", "softness": 0.05, "axis": "y", "min": 0.4742, "max": 1.0}]);
  const mesh_body_1 = new THREE.Mesh(
    mesh_body_1Geometry,
    materialMap["bus-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_1.name = "Body";
  mesh_body_1.material = mesh_body_1.material.clone();
  mesh_body_1.material.vertexColors = true;
  (mesh_body_1.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_body_1) {
    mesh_body_1.position.copy(endpoint_body_1.midpoint);
    mesh_body_1.quaternion.copy(endpoint_body_1.quaternion);
  }
  mesh_body_1.castShadow = options.castShadow ?? true;
  mesh_body_1.receiveShadow = options.receiveShadow ?? true;
  mesh_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "The yellow body is one continuous rigid volume whose side outline (rounded roof, sloping hood, flat floor) was measured column-by-column from the reference and extruded through the bus width; the hood is part of this profile, not a separate box.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.4936, 0.1202], [-0.4807, 0.2124], [-0.4678, 0.4206], [-0.4549, 0.4614], [-0.4421, 0.485], [-0.4292, 0.4957], [-0.4163, 0.5043], [-0.4034, 0.5107], [-0.3906, 0.515], [-0.3777, 0.5172], [-0.3648, 0.5215], [-0.3519, 0.5236], [-0.3391, 0.5258], [-0.3262, 0.5279], [-0.3133, 0.5279], [-0.3004, 0.53], [-0.2876, 0.5322], [-0.2747, 0.5322], [-0.2618, 0.5343], [-0.2489, 0.5343], [-0.2361, 0.5343], [-0.2232, 0.5365], [-0.2103, 0.5365], [-0.1974, 0.5365], [-0.1845, 0.5365], [-0.1717, 0.5365], [-0.1588, 0.5365], [-0.1459, 0.5386], [-0.133, 0.5386], [-0.1202, 0.5386], [-0.1073, 0.5386], [-0.0944, 0.5365], [-0.0815, 0.5365], [-0.0687, 0.5365], [-0.0558, 0.5365], [-0.0429, 0.5365], [-0.03, 0.5365], [-0.0172, 0.5365], [-0.0043, 0.5365], [0.0086, 0.5365], [0.0215, 0.5365], [0.0343, 0.5343], [0.0472, 0.5343], [0.0601, 0.5343], [0.073, 0.5343], [0.0858, 0.5343], [0.0987, 0.5322], [0.1116, 0.5322], [0.1245, 0.5322], [0.1373, 0.53], [0.1502, 0.53], [0.1631, 0.53], [0.176, 0.5279], [0.1888, 0.5279], [0.2017, 0.5258], [0.2146, 0.5236], [0.2275, 0.5215], [0.2403, 0.5193], [0.2532, 0.515], [0.2661, 0.5107], [0.279, 0.5043], [0.2918, 0.4914], [0.3047, 0.4635], [0.3176, 0.4206], [0.3305, 0.3562], [0.3433, 0.3047], [0.3562, 0.294], [0.3691, 0.2897], [0.382, 0.2876], [0.3948, 0.2811], [0.4077, 0.2768], [0.4206, 0.2725], [0.4335, 0.2661], [0.4464, 0.2575], [0.4592, 0.2361], [0.4721, 0.2146], [0.485, 0.1996], [0.4957, 0.1223], [0.4979, 0.0408], [-0.4957, 0.0408]], "depth": 0.42}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 0.498, "depth": 0.42, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, -0.21], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "axle-rear", "localPosition": [-0.3069, 0.0858, 0.21]}, {"id": "axle-front", "localPosition": [0.1803, 0.0858, 0.21]}, {"id": "side", "localPosition": [0, 0.2811, 0.42]}, {"id": "front", "localPosition": [0.4979, 0.1738, 0.21]}, {"id": "rear", "localPosition": [-0.4957, 0.0987, 0.21]}], "collider": {"type": "box", "offset": [0.0011, 0.2897, 0.21], "scale": [0.9936, 0.4978, 0.42], "isTrigger": false, "notes": "box proxy around the extruded body"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "bus-yellow"}}, "material": "bus-yellow", "materialLayers": ["bus-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roof-band", "kind": "decal", "note": "lighter roof band (vertexPaint)"}, {"id": "stripe", "kind": "linework", "note": "double orange side stripe built as components stripe-1/2"}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.03, "bumpAmplitude": 0.0, "normalPattern": "none (flat satin paint)", "displacementPattern": "none", "occlusionPattern": "contact darkening under the stripe, panes and wheel arches", "edgeWearPattern": "none", "notes": "chamfer-free extrude; edges read via shading only"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 198, 30, 1.0)", "secondaryAlbedo": "rgba(255, 215, 92, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour", "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(255, 198, 30, 1.0)"}, {"t": 1.0, "color": "rgba(255, 215, 92, 1.0)"}]}}, "vertexPaint": {"baseColor": "#ffc61e", "regions": [{"id": "roof-band", "kind": "axis-band", "axis": "y", "min": 0.4742, "max": 1.0, "softness": 0.05, "color": "#ffd75c"}]}};
  node_body_1.add(mesh_body_1);
  meshes["body"] = mesh_body_1;
  colliders["body"] = {"type": "box", "offset": [0.0011, 0.2897, 0.21], "scale": [0.9936, 0.4978, 0.42], "isTrigger": false, "notes": "box proxy around the extruded body"};
  destructionGroups["body"] ??= [];
  destructionGroups["body"].push(node_body_1);
  const socket_body_axle_rear_0 = new THREE.Object3D();
  socket_body_axle_rear_0.name = "axle-rear";
  socket_body_axle_rear_0.position.set(-0.3069, 0.0858, 0.21);
  socket_body_axle_rear_0.rotation.set(0, 0, 0);
  socket_body_axle_rear_0.userData.socket = {"id": "axle-rear", "localPosition": [-0.3069, 0.0858, 0.21]};
  node_body_1.add(socket_body_axle_rear_0);
  sockets["body:axle-rear"] = socket_body_axle_rear_0;
  const socket_body_axle_front_1 = new THREE.Object3D();
  socket_body_axle_front_1.name = "axle-front";
  socket_body_axle_front_1.position.set(0.1803, 0.0858, 0.21);
  socket_body_axle_front_1.rotation.set(0, 0, 0);
  socket_body_axle_front_1.userData.socket = {"id": "axle-front", "localPosition": [0.1803, 0.0858, 0.21]};
  node_body_1.add(socket_body_axle_front_1);
  sockets["body:axle-front"] = socket_body_axle_front_1;
  const socket_body_side_2 = new THREE.Object3D();
  socket_body_side_2.name = "side";
  socket_body_side_2.position.set(0.0, 0.2811, 0.42);
  socket_body_side_2.rotation.set(0, 0, 0);
  socket_body_side_2.userData.socket = {"id": "side", "localPosition": [0, 0.2811, 0.42]};
  node_body_1.add(socket_body_side_2);
  sockets["body:side"] = socket_body_side_2;
  const socket_body_front_3 = new THREE.Object3D();
  socket_body_front_3.name = "front";
  socket_body_front_3.position.set(0.4979, 0.1738, 0.21);
  socket_body_front_3.rotation.set(0, 0, 0);
  socket_body_front_3.userData.socket = {"id": "front", "localPosition": [0.4979, 0.1738, 0.21]};
  node_body_1.add(socket_body_front_3);
  sockets["body:front"] = socket_body_front_3;
  const socket_body_rear_4 = new THREE.Object3D();
  socket_body_rear_4.name = "rear";
  socket_body_rear_4.position.set(-0.4957, 0.0987, 0.21);
  socket_body_rear_4.rotation.set(0, 0, 0);
  socket_body_rear_4.userData.socket = {"id": "rear", "localPosition": [-0.4957, 0.0987, 0.21]};
  node_body_1.add(socket_body_rear_4);
  sockets["body:rear"] = socket_body_rear_4;

  const endpoint_window_rear_2 = makeAttachmentEndpoint(null);
  const node_window_rear_2 = new THREE.Group();
  node_window_rear_2.name = "Rear window__pivot";
  node_window_rear_2.scale.set(1, 1, 1);
  if (endpoint_window_rear_2) {
    node_window_rear_2.position.copy(endpoint_window_rear_2.start);
    node_window_rear_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_rear_2.position.set(-0.2786, 0.4009, 0.422);
    node_window_rear_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_rear_2.userData.sculptComponent = {"id": "window-rear", "name": "Rear window", "level": "meso", "role": "window", "importance": 0.8, "confidence": 0.85, "primitive": "extrude", "topologyClass": "material-only", "topologyRationale": "A flat glass pane whose outline was measured from the reference and extruded a hair proud of the side face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0712, 0.0841], [-0.0132, 0.0841], [0.1971, 0.0841], [0.2121, 0.054], [0.2121, -0.094], [0.2056, -0.1005], [-0.1334, -0.1005], [-0.1613, -0.0661], [-0.1613, -0.0232], [-0.1506, 0.024], [-0.1356, 0.054]], "depth": 0.012}}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3734, "height": 0.1846, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2786, 0.4009, 0.422], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0.006], "scale": [0.3734, 0.1846, 0.012], "isTrigger": false, "notes": "pane proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "streaks", "kind": "gloss", "note": "lighter diagonal streaks (vertexPaint)"}], "surfaceDetail": {"macroRoughness": 0.1, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "none (glass)", "displacementPattern": "none", "occlusionPattern": "pane inset", "edgeWearPattern": "none", "notes": "diagonal highlight streaks are vertex paint"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "vertexPaint": {"baseColor": "#9ddcff", "regions": [{"id": "streak-1", "kind": "tapered-capsule", "start": [-0.0132, 0.0776, 0.006], "end": [-0.0669, -0.094, 0.006], "startRadius": 0.015021459227467811, "endRadius": 0.015021459227467811, "softness": 0.003, "color": "#d6f1ff"}, {"id": "streak-2", "kind": "tapered-capsule", "start": [0.0511, 0.0776, 0.006], "end": [-0.0025, -0.094, 0.006], "startRadius": 0.008583690987124463, "endRadius": 0.008583690987124463, "softness": 0.003, "color": "#d6f1ff"}, {"id": "streak-3", "kind": "tapered-capsule", "start": [0.1692, 0.0776, 0.006], "end": [0.1155, -0.094, 0.006], "startRadius": 0.008583690987124463, "endRadius": 0.008583690987124463, "softness": 0.003, "color": "#d6f1ff"}]}};
  node_window_rear_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0.006], "scale": [0.3734, 0.1846, 0.012], "isTrigger": false, "notes": "pane proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}};
  (nodes["body"] ?? root).add(node_window_rear_2);
  nodes["window-rear"] = node_window_rear_2;
  const mesh_window_rear_2Geometry = endpoint_window_rear_2
    ? new THREE.CylinderGeometry(endpoint_window_rear_2.endRadius, endpoint_window_rear_2.baseRadius, endpoint_window_rear_2.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.0712, 0.0841], [-0.0132, 0.0841], [0.1971, 0.0841], [0.2121, 0.054], [0.2121, -0.094], [0.2056, -0.1005], [-0.1334, -0.1005], [-0.1613, -0.0661], [-0.1613, -0.0232], [-0.1506, 0.024], [-0.1356, 0.054]], "depth": 0.012});
  if (!endpoint_window_rear_2) {
    mesh_window_rear_2Geometry.scale(1.0, 1.0, 1.0);
  }
  applyVertexPaint(mesh_window_rear_2Geometry, "#9ddcff", [{"id": "streak-1", "kind": "tapered-capsule", "color": "#d6f1ff", "softness": 0.003, "start": [-0.0132, 0.0776, 0.006], "end": [-0.0669, -0.094, 0.006], "startRadius": 0.015021459227467811, "endRadius": 0.015021459227467811}, {"id": "streak-2", "kind": "tapered-capsule", "color": "#d6f1ff", "softness": 0.003, "start": [0.0511, 0.0776, 0.006], "end": [-0.0025, -0.094, 0.006], "startRadius": 0.008583690987124463, "endRadius": 0.008583690987124463}, {"id": "streak-3", "kind": "tapered-capsule", "color": "#d6f1ff", "softness": 0.003, "start": [0.1692, 0.0776, 0.006], "end": [0.1155, -0.094, 0.006], "startRadius": 0.008583690987124463, "endRadius": 0.008583690987124463}]);
  const mesh_window_rear_2 = new THREE.Mesh(
    mesh_window_rear_2Geometry,
    materialMap["glass-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_rear_2.name = "Rear window";
  mesh_window_rear_2.material = mesh_window_rear_2.material.clone();
  mesh_window_rear_2.material.vertexColors = true;
  (mesh_window_rear_2.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_window_rear_2) {
    mesh_window_rear_2.position.copy(endpoint_window_rear_2.midpoint);
    mesh_window_rear_2.quaternion.copy(endpoint_window_rear_2.quaternion);
  }
  mesh_window_rear_2.castShadow = options.castShadow ?? true;
  mesh_window_rear_2.receiveShadow = options.receiveShadow ?? true;
  mesh_window_rear_2.userData.sculptComponent = {"id": "window-rear", "name": "Rear window", "level": "meso", "role": "window", "importance": 0.8, "confidence": 0.85, "primitive": "extrude", "topologyClass": "material-only", "topologyRationale": "A flat glass pane whose outline was measured from the reference and extruded a hair proud of the side face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0712, 0.0841], [-0.0132, 0.0841], [0.1971, 0.0841], [0.2121, 0.054], [0.2121, -0.094], [0.2056, -0.1005], [-0.1334, -0.1005], [-0.1613, -0.0661], [-0.1613, -0.0232], [-0.1506, 0.024], [-0.1356, 0.054]], "depth": 0.012}}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3734, "height": 0.1846, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2786, 0.4009, 0.422], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0.006], "scale": [0.3734, 0.1846, 0.012], "isTrigger": false, "notes": "pane proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "streaks", "kind": "gloss", "note": "lighter diagonal streaks (vertexPaint)"}], "surfaceDetail": {"macroRoughness": 0.1, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "none (glass)", "displacementPattern": "none", "occlusionPattern": "pane inset", "edgeWearPattern": "none", "notes": "diagonal highlight streaks are vertex paint"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "vertexPaint": {"baseColor": "#9ddcff", "regions": [{"id": "streak-1", "kind": "tapered-capsule", "start": [-0.0132, 0.0776, 0.006], "end": [-0.0669, -0.094, 0.006], "startRadius": 0.015021459227467811, "endRadius": 0.015021459227467811, "softness": 0.003, "color": "#d6f1ff"}, {"id": "streak-2", "kind": "tapered-capsule", "start": [0.0511, 0.0776, 0.006], "end": [-0.0025, -0.094, 0.006], "startRadius": 0.008583690987124463, "endRadius": 0.008583690987124463, "softness": 0.003, "color": "#d6f1ff"}, {"id": "streak-3", "kind": "tapered-capsule", "start": [0.1692, 0.0776, 0.006], "end": [0.1155, -0.094, 0.006], "startRadius": 0.008583690987124463, "endRadius": 0.008583690987124463, "softness": 0.003, "color": "#d6f1ff"}]}};
  node_window_rear_2.add(mesh_window_rear_2);
  meshes["window-rear"] = mesh_window_rear_2;
  colliders["window-rear"] = {"type": "box", "offset": [0, 0, 0.006], "scale": [0.3734, 0.1846, 0.012], "isTrigger": false, "notes": "pane proxy"};
  destructionGroups["window-rear"] ??= [];
  destructionGroups["window-rear"].push(node_window_rear_2);

  const endpoint_window_divider_1_3 = makeAttachmentEndpoint(null);
  const node_window_divider_1_3 = new THREE.Group();
  node_window_divider_1_3.name = "Window divider 1__pivot";
  node_window_divider_1_3.scale.set(1, 1, 1);
  if (endpoint_window_divider_1_3) {
    node_window_divider_1_3.position.copy(endpoint_window_divider_1_3.start);
    node_window_divider_1_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_divider_1_3.position.set(-0.3197, 0.3927, 0.434);
    node_window_divider_1_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_divider_1_3.userData.sculptComponent = {"id": "window-divider-1", "name": "Window divider 1", "level": "micro", "role": "trim", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Thin dark divider bar between rear window panes.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0064, "height": 0.1845, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.3197, 0.3927, 0.434], "rotation": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-divider-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_window_divider_1_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-divider-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["body"] ?? root).add(node_window_divider_1_3);
  nodes["window-divider-1"] = node_window_divider_1_3;
  const mesh_window_divider_1_3Geometry = endpoint_window_divider_1_3
    ? new THREE.CylinderGeometry(endpoint_window_divider_1_3.endRadius, endpoint_window_divider_1_3.baseRadius, endpoint_window_divider_1_3.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_divider_1_3) {
    mesh_window_divider_1_3Geometry.scale(0.0064, 0.1845, 0.006);
  }
  const mesh_window_divider_1_3 = new THREE.Mesh(
    mesh_window_divider_1_3Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_divider_1_3.name = "Window divider 1";
  if (endpoint_window_divider_1_3) {
    mesh_window_divider_1_3.position.copy(endpoint_window_divider_1_3.midpoint);
    mesh_window_divider_1_3.quaternion.copy(endpoint_window_divider_1_3.quaternion);
  }
  mesh_window_divider_1_3.castShadow = options.castShadow ?? true;
  mesh_window_divider_1_3.receiveShadow = options.receiveShadow ?? true;
  mesh_window_divider_1_3.userData.sculptComponent = {"id": "window-divider-1", "name": "Window divider 1", "level": "micro", "role": "trim", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Thin dark divider bar between rear window panes.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0064, "height": 0.1845, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.3197, 0.3927, 0.434], "rotation": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-divider-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_window_divider_1_3.add(mesh_window_divider_1_3);
  meshes["window-divider-1"] = mesh_window_divider_1_3;
  colliders["window-divider-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["window-divider-1"] ??= [];
  destructionGroups["window-divider-1"].push(node_window_divider_1_3);

  const endpoint_window_divider_2_4 = makeAttachmentEndpoint(null);
  const node_window_divider_2_4 = new THREE.Group();
  node_window_divider_2_4.name = "Window divider 2__pivot";
  node_window_divider_2_4.scale.set(1, 1, 1);
  if (endpoint_window_divider_2_4) {
    node_window_divider_2_4.position.copy(endpoint_window_divider_2_4.start);
    node_window_divider_2_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_divider_2_4.position.set(-0.1888, 0.3927, 0.434);
    node_window_divider_2_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_divider_2_4.userData.sculptComponent = {"id": "window-divider-2", "name": "Window divider 2", "level": "micro", "role": "trim", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Thin dark divider bar between rear window panes.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0064, "height": 0.1845, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.1888, 0.3927, 0.434], "rotation": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-divider-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_window_divider_2_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-divider-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["body"] ?? root).add(node_window_divider_2_4);
  nodes["window-divider-2"] = node_window_divider_2_4;
  const mesh_window_divider_2_4Geometry = endpoint_window_divider_2_4
    ? new THREE.CylinderGeometry(endpoint_window_divider_2_4.endRadius, endpoint_window_divider_2_4.baseRadius, endpoint_window_divider_2_4.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_divider_2_4) {
    mesh_window_divider_2_4Geometry.scale(0.0064, 0.1845, 0.006);
  }
  const mesh_window_divider_2_4 = new THREE.Mesh(
    mesh_window_divider_2_4Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_divider_2_4.name = "Window divider 2";
  if (endpoint_window_divider_2_4) {
    mesh_window_divider_2_4.position.copy(endpoint_window_divider_2_4.midpoint);
    mesh_window_divider_2_4.quaternion.copy(endpoint_window_divider_2_4.quaternion);
  }
  mesh_window_divider_2_4.castShadow = options.castShadow ?? true;
  mesh_window_divider_2_4.receiveShadow = options.receiveShadow ?? true;
  mesh_window_divider_2_4.userData.sculptComponent = {"id": "window-divider-2", "name": "Window divider 2", "level": "micro", "role": "trim", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Thin dark divider bar between rear window panes.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0064, "height": 0.1845, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.1888, 0.3927, 0.434], "rotation": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-divider-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_window_divider_2_4.add(mesh_window_divider_2_4);
  meshes["window-divider-2"] = mesh_window_divider_2_4;
  colliders["window-divider-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0064, 0.1845, 0.006], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["window-divider-2"] ??= [];
  destructionGroups["window-divider-2"].push(node_window_divider_2_4);

  const endpoint_window_cab_5 = makeAttachmentEndpoint(null);
  const node_window_cab_5 = new THREE.Group();
  node_window_cab_5.name = "Cab window (face)__pivot";
  node_window_cab_5.scale.set(1, 1, 1);
  if (endpoint_window_cab_5) {
    node_window_cab_5.position.copy(endpoint_window_cab_5.start);
    node_window_cab_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_cab_5.position.set(0.2255, 0.4002, 0.422);
    node_window_cab_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_cab_5.userData.sculptComponent = {"id": "window-cab", "name": "Cab window (face)", "level": "meso", "role": "window", "importance": 0.8, "confidence": 0.85, "primitive": "extrude", "topologyClass": "material-only", "topologyRationale": "A flat glass pane whose outline was measured from the reference and extruded a hair proud of the side face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0324, 0.0891], [0.0277, 0.0891], [0.0814, 0.059], [0.09, 0.029], [0.1028, -0.0311], [0.1071, -0.0611], [0.105, -0.0998], [-0.0731, -0.0998], [-0.0967, -0.0611], [-0.1032, -0.0011], [-0.1053, 0.029], [-0.1032, 0.059]], "depth": 0.012}}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2124, "height": 0.1889, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.2255, 0.4002, 0.422], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0.006], "scale": [0.2124, 0.1889, 0.012], "isTrigger": false, "notes": "pane proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-cab", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "streaks", "kind": "gloss", "note": "lighter diagonal streaks (vertexPaint)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "vertexPaint": {"baseColor": "#9ddcff", "regions": [{"id": "streak-1", "kind": "tapered-capsule", "start": [0.0728, 0.074, 0.006], "end": [-0.0023, -0.0933, 0.006], "startRadius": 0.01072961373390558, "endRadius": 0.01072961373390558, "softness": 0.003, "color": "#d6f1ff"}]}};
  node_window_cab_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0.006], "scale": [0.2124, 0.1889, 0.012], "isTrigger": false, "notes": "pane proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-cab", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}};
  (nodes["body"] ?? root).add(node_window_cab_5);
  nodes["window-cab"] = node_window_cab_5;
  const mesh_window_cab_5Geometry = endpoint_window_cab_5
    ? new THREE.CylinderGeometry(endpoint_window_cab_5.endRadius, endpoint_window_cab_5.baseRadius, endpoint_window_cab_5.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.0324, 0.0891], [0.0277, 0.0891], [0.0814, 0.059], [0.09, 0.029], [0.1028, -0.0311], [0.1071, -0.0611], [0.105, -0.0998], [-0.0731, -0.0998], [-0.0967, -0.0611], [-0.1032, -0.0011], [-0.1053, 0.029], [-0.1032, 0.059]], "depth": 0.012});
  if (!endpoint_window_cab_5) {
    mesh_window_cab_5Geometry.scale(1.0, 1.0, 1.0);
  }
  applyVertexPaint(mesh_window_cab_5Geometry, "#9ddcff", [{"id": "streak-1", "kind": "tapered-capsule", "color": "#d6f1ff", "softness": 0.003, "start": [0.0728, 0.074, 0.006], "end": [-0.0023, -0.0933, 0.006], "startRadius": 0.01072961373390558, "endRadius": 0.01072961373390558}]);
  const mesh_window_cab_5 = new THREE.Mesh(
    mesh_window_cab_5Geometry,
    materialMap["glass-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_cab_5.name = "Cab window (face)";
  mesh_window_cab_5.material = mesh_window_cab_5.material.clone();
  mesh_window_cab_5.material.vertexColors = true;
  (mesh_window_cab_5.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_window_cab_5) {
    mesh_window_cab_5.position.copy(endpoint_window_cab_5.midpoint);
    mesh_window_cab_5.quaternion.copy(endpoint_window_cab_5.quaternion);
  }
  mesh_window_cab_5.castShadow = options.castShadow ?? true;
  mesh_window_cab_5.receiveShadow = options.receiveShadow ?? true;
  mesh_window_cab_5.userData.sculptComponent = {"id": "window-cab", "name": "Cab window (face)", "level": "meso", "role": "window", "importance": 0.8, "confidence": 0.85, "primitive": "extrude", "topologyClass": "material-only", "topologyRationale": "A flat glass pane whose outline was measured from the reference and extruded a hair proud of the side face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0324, 0.0891], [0.0277, 0.0891], [0.0814, 0.059], [0.09, 0.029], [0.1028, -0.0311], [0.1071, -0.0611], [0.105, -0.0998], [-0.0731, -0.0998], [-0.0967, -0.0611], [-0.1032, -0.0011], [-0.1053, 0.029], [-0.1032, 0.059]], "depth": 0.012}}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2124, "height": 0.1889, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.2255, 0.4002, 0.422], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0.006], "scale": [0.2124, 0.1889, 0.012], "isTrigger": false, "notes": "pane proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-cab", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "streaks", "kind": "gloss", "note": "lighter diagonal streaks (vertexPaint)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "vertexPaint": {"baseColor": "#9ddcff", "regions": [{"id": "streak-1", "kind": "tapered-capsule", "start": [0.0728, 0.074, 0.006], "end": [-0.0023, -0.0933, 0.006], "startRadius": 0.01072961373390558, "endRadius": 0.01072961373390558, "softness": 0.003, "color": "#d6f1ff"}]}};
  node_window_cab_5.add(mesh_window_cab_5);
  meshes["window-cab"] = mesh_window_cab_5;
  colliders["window-cab"] = {"type": "box", "offset": [0, 0, 0.006], "scale": [0.2124, 0.1889, 0.012], "isTrigger": false, "notes": "pane proxy"};
  destructionGroups["window-cab"] ??= [];
  destructionGroups["window-cab"].push(node_window_cab_5);

  const endpoint_door_opening_6 = makeAttachmentEndpoint(null);
  const node_door_opening_6 = new THREE.Group();
  node_door_opening_6.name = "Door opening__pivot";
  node_door_opening_6.scale.set(1, 1, 1);
  if (endpoint_door_opening_6) {
    node_door_opening_6.position.copy(endpoint_door_opening_6.start);
    node_door_opening_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_opening_6.position.set(0.0258, 0.2833, 0.423);
    node_door_opening_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_opening_6.userData.sculptComponent = {"id": "door-opening", "name": "Door opening", "level": "meso", "role": "door", "importance": 0.8, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Dark recessed opening of the open door, a flat dark panel on the side face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1545, "height": 0.4077, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0258, 0.2833, 0.423], "rotation": [0, 0, 0], "scale": [0.1545, 0.4077, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1545, 0.4077, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-opening", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_door_opening_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1545, 0.4077, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-opening", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["body"] ?? root).add(node_door_opening_6);
  nodes["door-opening"] = node_door_opening_6;
  const mesh_door_opening_6Geometry = endpoint_door_opening_6
    ? new THREE.CylinderGeometry(endpoint_door_opening_6.endRadius, endpoint_door_opening_6.baseRadius, endpoint_door_opening_6.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_opening_6) {
    mesh_door_opening_6Geometry.scale(0.1545, 0.4077, 0.008);
  }
  const mesh_door_opening_6 = new THREE.Mesh(
    mesh_door_opening_6Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_opening_6.name = "Door opening";
  if (endpoint_door_opening_6) {
    mesh_door_opening_6.position.copy(endpoint_door_opening_6.midpoint);
    mesh_door_opening_6.quaternion.copy(endpoint_door_opening_6.quaternion);
  }
  mesh_door_opening_6.castShadow = options.castShadow ?? true;
  mesh_door_opening_6.receiveShadow = options.receiveShadow ?? true;
  mesh_door_opening_6.userData.sculptComponent = {"id": "door-opening", "name": "Door opening", "level": "meso", "role": "door", "importance": 0.8, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Dark recessed opening of the open door, a flat dark panel on the side face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1545, "height": 0.4077, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0258, 0.2833, 0.423], "rotation": [0, 0, 0], "scale": [0.1545, 0.4077, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1545, 0.4077, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-opening", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_door_opening_6.add(mesh_door_opening_6);
  meshes["door-opening"] = mesh_door_opening_6;
  colliders["door-opening"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.1545, 0.4077, 0.008], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["door-opening"] ??= [];
  destructionGroups["door-opening"].push(node_door_opening_6);

  const endpoint_door_7 = makeAttachmentEndpoint(null);
  const node_door_7 = new THREE.Group();
  node_door_7.name = "Door leaf__pivot";
  node_door_7.scale.set(1, 1, 1);
  if (endpoint_door_7) {
    node_door_7.position.copy(endpoint_door_7.start);
    node_door_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_7.position.set(-0.0386, 0.2833, 0.432);
    node_door_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_7.userData.sculptComponent = {"id": "door", "name": "Door leaf", "level": "meso", "role": "door", "importance": 0.7, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The open door leaf: a thin rigid yellow panel hinged at the rear edge of the opening.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.005, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.024, "height": 0.4077, "depth": 0.02, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0386, 0.2833, 0.432], "rotation": [0, 0, 0], "scale": [0.024, 0.4077, 0.02]}, "actionProfile": {"animationRole": "door", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "leaf", "localPosition": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.024, 0.4077, 0.02], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "bus-yellow"}}, "material": "bus-yellow", "materialLayers": ["bus-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 198, 30, 1.0)", "secondaryAlbedo": "rgba(255, 215, 92, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_door_7.userData.actionProfile = {"animationRole": "door", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "leaf", "localPosition": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.024, 0.4077, 0.02], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "bus-yellow"}};
  (nodes["body"] ?? root).add(node_door_7);
  nodes["door"] = node_door_7;
  const mesh_door_7Geometry = endpoint_door_7
    ? new THREE.CylinderGeometry(endpoint_door_7.endRadius, endpoint_door_7.baseRadius, endpoint_door_7.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_7) {
    mesh_door_7Geometry.scale(0.024, 0.4077, 0.02);
  }
  const mesh_door_7 = new THREE.Mesh(
    mesh_door_7Geometry,
    materialMap["bus-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_7.name = "Door leaf";
  if (endpoint_door_7) {
    mesh_door_7.position.copy(endpoint_door_7.midpoint);
    mesh_door_7.quaternion.copy(endpoint_door_7.quaternion);
  }
  mesh_door_7.castShadow = options.castShadow ?? true;
  mesh_door_7.receiveShadow = options.receiveShadow ?? true;
  mesh_door_7.userData.sculptComponent = {"id": "door", "name": "Door leaf", "level": "meso", "role": "door", "importance": 0.7, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The open door leaf: a thin rigid yellow panel hinged at the rear edge of the opening.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.005, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.024, "height": 0.4077, "depth": 0.02, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0386, 0.2833, 0.432], "rotation": [0, 0, 0], "scale": [0.024, 0.4077, 0.02]}, "actionProfile": {"animationRole": "door", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "leaf", "localPosition": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.024, 0.4077, 0.02], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "bus-yellow"}}, "material": "bus-yellow", "materialLayers": ["bus-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 198, 30, 1.0)", "secondaryAlbedo": "rgba(255, 215, 92, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_door_7.add(mesh_door_7);
  meshes["door"] = mesh_door_7;
  colliders["door"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.024, 0.4077, 0.02], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["door"] ??= [];
  destructionGroups["door"].push(node_door_7);
  const socket_door_leaf_0 = new THREE.Object3D();
  socket_door_leaf_0.name = "leaf";
  socket_door_leaf_0.position.set(0.0, 0.0, 0.0);
  socket_door_leaf_0.rotation.set(0, 0, 0);
  socket_door_leaf_0.userData.socket = {"id": "leaf", "localPosition": [0, 0, 0]};
  node_door_7.add(socket_door_leaf_0);
  sockets["door:leaf"] = socket_door_leaf_0;

  const endpoint_door_pane_1_8 = makeAttachmentEndpoint(null);
  const node_door_pane_1_8 = new THREE.Group();
  node_door_pane_1_8.name = "Door pane 1__pivot";
  node_door_pane_1_8.scale.set(1, 1, 1);
  if (endpoint_door_pane_1_8) {
    node_door_pane_1_8.position.copy(endpoint_door_pane_1_8.start);
    node_door_pane_1_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_pane_1_8.position.set(0.0311, 0.0965, -0.002);
    node_door_pane_1_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_pane_1_8.userData.sculptComponent = {"id": "door-pane-1", "name": "Door pane 1", "level": "micro", "role": "window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Small glass pane riding on the hinged door leaf.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "door", "attachment": {"parentSocket": "leaf", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0322, "height": 0.1588, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0311, 0.0965, -0.002], "rotation": [0, 0, 0], "scale": [0.0322, 0.1588, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0322, 0.1588, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_door_pane_1_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0322, 0.1588, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}};
  (nodes["door"] ?? root).add(node_door_pane_1_8);
  nodes["door-pane-1"] = node_door_pane_1_8;
  const mesh_door_pane_1_8Geometry = endpoint_door_pane_1_8
    ? new THREE.CylinderGeometry(endpoint_door_pane_1_8.endRadius, endpoint_door_pane_1_8.baseRadius, endpoint_door_pane_1_8.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_pane_1_8) {
    mesh_door_pane_1_8Geometry.scale(0.0322, 0.1588, 0.008);
  }
  const mesh_door_pane_1_8 = new THREE.Mesh(
    mesh_door_pane_1_8Geometry,
    materialMap["glass-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_pane_1_8.name = "Door pane 1";
  if (endpoint_door_pane_1_8) {
    mesh_door_pane_1_8.position.copy(endpoint_door_pane_1_8.midpoint);
    mesh_door_pane_1_8.quaternion.copy(endpoint_door_pane_1_8.quaternion);
  }
  mesh_door_pane_1_8.castShadow = options.castShadow ?? true;
  mesh_door_pane_1_8.receiveShadow = options.receiveShadow ?? true;
  mesh_door_pane_1_8.userData.sculptComponent = {"id": "door-pane-1", "name": "Door pane 1", "level": "micro", "role": "window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Small glass pane riding on the hinged door leaf.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "door", "attachment": {"parentSocket": "leaf", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0322, "height": 0.1588, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0311, 0.0965, -0.002], "rotation": [0, 0, 0], "scale": [0.0322, 0.1588, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0322, 0.1588, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_door_pane_1_8.add(mesh_door_pane_1_8);
  meshes["door-pane-1"] = mesh_door_pane_1_8;
  colliders["door-pane-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0322, 0.1588, 0.008], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["door-pane-1"] ??= [];
  destructionGroups["door-pane-1"].push(node_door_pane_1_8);

  const endpoint_door_pane_2_9 = makeAttachmentEndpoint(null);
  const node_door_pane_2_9 = new THREE.Group();
  node_door_pane_2_9.name = "Door pane 2__pivot";
  node_door_pane_2_9.scale.set(1, 1, 1);
  if (endpoint_door_pane_2_9) {
    node_door_pane_2_9.position.copy(endpoint_door_pane_2_9.start);
    node_door_pane_2_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_pane_2_9.position.set(0.1105, 0.0965, -0.002);
    node_door_pane_2_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_pane_2_9.userData.sculptComponent = {"id": "door-pane-2", "name": "Door pane 2", "level": "micro", "role": "window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Small glass pane riding on the hinged door leaf.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "door", "attachment": {"parentSocket": "leaf", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0279, "height": 0.1588, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1105, 0.0965, -0.002], "rotation": [0, 0, 0], "scale": [0.0279, 0.1588, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0279, 0.1588, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_door_pane_2_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0279, 0.1588, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}};
  (nodes["door"] ?? root).add(node_door_pane_2_9);
  nodes["door-pane-2"] = node_door_pane_2_9;
  const mesh_door_pane_2_9Geometry = endpoint_door_pane_2_9
    ? new THREE.CylinderGeometry(endpoint_door_pane_2_9.endRadius, endpoint_door_pane_2_9.baseRadius, endpoint_door_pane_2_9.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_pane_2_9) {
    mesh_door_pane_2_9Geometry.scale(0.0279, 0.1588, 0.008);
  }
  const mesh_door_pane_2_9 = new THREE.Mesh(
    mesh_door_pane_2_9Geometry,
    materialMap["glass-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_pane_2_9.name = "Door pane 2";
  if (endpoint_door_pane_2_9) {
    mesh_door_pane_2_9.position.copy(endpoint_door_pane_2_9.midpoint);
    mesh_door_pane_2_9.quaternion.copy(endpoint_door_pane_2_9.quaternion);
  }
  mesh_door_pane_2_9.castShadow = options.castShadow ?? true;
  mesh_door_pane_2_9.receiveShadow = options.receiveShadow ?? true;
  mesh_door_pane_2_9.userData.sculptComponent = {"id": "door-pane-2", "name": "Door pane 2", "level": "micro", "role": "window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Small glass pane riding on the hinged door leaf.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "door", "attachment": {"parentSocket": "leaf", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0279, "height": 0.1588, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1105, 0.0965, -0.002], "rotation": [0, 0, 0], "scale": [0.0279, 0.1588, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0279, 0.1588, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_door_pane_2_9.add(mesh_door_pane_2_9);
  meshes["door-pane-2"] = mesh_door_pane_2_9;
  colliders["door-pane-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0279, 0.1588, 0.008], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["door-pane-2"] ??= [];
  destructionGroups["door-pane-2"].push(node_door_pane_2_9);

  const endpoint_door_pane_3_10 = makeAttachmentEndpoint(null);
  const node_door_pane_3_10 = new THREE.Group();
  node_door_pane_3_10.name = "Door pane 3__pivot";
  node_door_pane_3_10.scale.set(1, 1, 1);
  if (endpoint_door_pane_3_10) {
    node_door_pane_3_10.position.copy(endpoint_door_pane_3_10.start);
    node_door_pane_3_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_pane_3_10.position.set(0.03, -0.0998, -0.002);
    node_door_pane_3_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_pane_3_10.userData.sculptComponent = {"id": "door-pane-3", "name": "Door pane 3", "level": "micro", "role": "window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Small glass pane riding on the hinged door leaf.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "door", "attachment": {"parentSocket": "leaf", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.03, "height": 0.1609, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.03, -0.0998, -0.002], "rotation": [0, 0, 0], "scale": [0.03, 0.1609, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.1609, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_door_pane_3_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.1609, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}};
  (nodes["door"] ?? root).add(node_door_pane_3_10);
  nodes["door-pane-3"] = node_door_pane_3_10;
  const mesh_door_pane_3_10Geometry = endpoint_door_pane_3_10
    ? new THREE.CylinderGeometry(endpoint_door_pane_3_10.endRadius, endpoint_door_pane_3_10.baseRadius, endpoint_door_pane_3_10.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_pane_3_10) {
    mesh_door_pane_3_10Geometry.scale(0.03, 0.1609, 0.008);
  }
  const mesh_door_pane_3_10 = new THREE.Mesh(
    mesh_door_pane_3_10Geometry,
    materialMap["glass-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_pane_3_10.name = "Door pane 3";
  if (endpoint_door_pane_3_10) {
    mesh_door_pane_3_10.position.copy(endpoint_door_pane_3_10.midpoint);
    mesh_door_pane_3_10.quaternion.copy(endpoint_door_pane_3_10.quaternion);
  }
  mesh_door_pane_3_10.castShadow = options.castShadow ?? true;
  mesh_door_pane_3_10.receiveShadow = options.receiveShadow ?? true;
  mesh_door_pane_3_10.userData.sculptComponent = {"id": "door-pane-3", "name": "Door pane 3", "level": "micro", "role": "window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Small glass pane riding on the hinged door leaf.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "door", "attachment": {"parentSocket": "leaf", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.03, "height": 0.1609, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.03, -0.0998, -0.002], "rotation": [0, 0, 0], "scale": [0.03, 0.1609, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.1609, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_door_pane_3_10.add(mesh_door_pane_3_10);
  meshes["door-pane-3"] = mesh_door_pane_3_10;
  colliders["door-pane-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.1609, 0.008], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["door-pane-3"] ??= [];
  destructionGroups["door-pane-3"].push(node_door_pane_3_10);

  const endpoint_door_pane_4_11 = makeAttachmentEndpoint(null);
  const node_door_pane_4_11 = new THREE.Group();
  node_door_pane_4_11.name = "Door pane 4__pivot";
  node_door_pane_4_11.scale.set(1, 1, 1);
  if (endpoint_door_pane_4_11) {
    node_door_pane_4_11.position.copy(endpoint_door_pane_4_11.start);
    node_door_pane_4_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_pane_4_11.position.set(0.1105, -0.0977, -0.002);
    node_door_pane_4_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_pane_4_11.userData.sculptComponent = {"id": "door-pane-4", "name": "Door pane 4", "level": "micro", "role": "window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Small glass pane riding on the hinged door leaf.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "door", "attachment": {"parentSocket": "leaf", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0279, "height": 0.1567, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1105, -0.0977, -0.002], "rotation": [0, 0, 0], "scale": [0.0279, 0.1567, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0279, 0.1567, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_door_pane_4_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0279, 0.1567, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}};
  (nodes["door"] ?? root).add(node_door_pane_4_11);
  nodes["door-pane-4"] = node_door_pane_4_11;
  const mesh_door_pane_4_11Geometry = endpoint_door_pane_4_11
    ? new THREE.CylinderGeometry(endpoint_door_pane_4_11.endRadius, endpoint_door_pane_4_11.baseRadius, endpoint_door_pane_4_11.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_pane_4_11) {
    mesh_door_pane_4_11Geometry.scale(0.0279, 0.1567, 0.008);
  }
  const mesh_door_pane_4_11 = new THREE.Mesh(
    mesh_door_pane_4_11Geometry,
    materialMap["glass-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_pane_4_11.name = "Door pane 4";
  if (endpoint_door_pane_4_11) {
    mesh_door_pane_4_11.position.copy(endpoint_door_pane_4_11.midpoint);
    mesh_door_pane_4_11.quaternion.copy(endpoint_door_pane_4_11.quaternion);
  }
  mesh_door_pane_4_11.castShadow = options.castShadow ?? true;
  mesh_door_pane_4_11.receiveShadow = options.receiveShadow ?? true;
  mesh_door_pane_4_11.userData.sculptComponent = {"id": "door-pane-4", "name": "Door pane 4", "level": "micro", "role": "window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Small glass pane riding on the hinged door leaf.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "door", "attachment": {"parentSocket": "leaf", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0279, "height": 0.1567, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1105, -0.0977, -0.002], "rotation": [0, 0, 0], "scale": [0.0279, 0.1567, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0279, 0.1567, 0.008], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-pane-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_door_pane_4_11.add(mesh_door_pane_4_11);
  meshes["door-pane-4"] = mesh_door_pane_4_11;
  colliders["door-pane-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0279, 0.1567, 0.008], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["door-pane-4"] ??= [];
  destructionGroups["door-pane-4"].push(node_door_pane_4_11);

  const endpoint_stripe_1_12 = makeAttachmentEndpoint(null);
  const node_stripe_1_12 = new THREE.Group();
  node_stripe_1_12.name = "Orange side stripe 1__pivot";
  node_stripe_1_12.scale.set(1, 1, 1);
  if (endpoint_stripe_1_12) {
    node_stripe_1_12.position.copy(endpoint_stripe_1_12.start);
    node_stripe_1_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_1_12.position.set(-0.2414, 0.2607, 0.424);
    node_stripe_1_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_1_12.userData.sculptComponent = {"id": "stripe-1", "name": "Orange side stripe 1", "level": "meso", "role": "trim", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Painted orange line along the side, a flat strip on the surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.005, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3798, "height": 0.015, "depth": 0.01, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2414, 0.2607, 0.424], "rotation": [0, 0, 0], "scale": [0.3798, 0.015, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3798, 0.015, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}}, "material": "orange-trim", "materialLayers": ["orange-trim"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_stripe_1_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3798, 0.015, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}};
  (nodes["body"] ?? root).add(node_stripe_1_12);
  nodes["stripe-1"] = node_stripe_1_12;
  const mesh_stripe_1_12Geometry = endpoint_stripe_1_12
    ? new THREE.CylinderGeometry(endpoint_stripe_1_12.endRadius, endpoint_stripe_1_12.baseRadius, endpoint_stripe_1_12.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_stripe_1_12) {
    mesh_stripe_1_12Geometry.scale(0.3798, 0.015, 0.01);
  }
  const mesh_stripe_1_12 = new THREE.Mesh(
    mesh_stripe_1_12Geometry,
    materialMap["orange-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_1_12.name = "Orange side stripe 1";
  if (endpoint_stripe_1_12) {
    mesh_stripe_1_12.position.copy(endpoint_stripe_1_12.midpoint);
    mesh_stripe_1_12.quaternion.copy(endpoint_stripe_1_12.quaternion);
  }
  mesh_stripe_1_12.castShadow = options.castShadow ?? true;
  mesh_stripe_1_12.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_1_12.userData.sculptComponent = {"id": "stripe-1", "name": "Orange side stripe 1", "level": "meso", "role": "trim", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Painted orange line along the side, a flat strip on the surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.005, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3798, "height": 0.015, "depth": 0.01, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2414, 0.2607, 0.424], "rotation": [0, 0, 0], "scale": [0.3798, 0.015, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3798, 0.015, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}}, "material": "orange-trim", "materialLayers": ["orange-trim"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_stripe_1_12.add(mesh_stripe_1_12);
  meshes["stripe-1"] = mesh_stripe_1_12;
  colliders["stripe-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.3798, 0.015, 0.01], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-1"] ??= [];
  destructionGroups["stripe-1"].push(node_stripe_1_12);

  const endpoint_stripe_2_13 = makeAttachmentEndpoint(null);
  const node_stripe_2_13 = new THREE.Group();
  node_stripe_2_13.name = "Orange side stripe 2__pivot";
  node_stripe_2_13.scale.set(1, 1, 1);
  if (endpoint_stripe_2_13) {
    node_stripe_2_13.position.copy(endpoint_stripe_2_13.start);
    node_stripe_2_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_2_13.position.set(-0.2414, 0.2328, 0.424);
    node_stripe_2_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_2_13.userData.sculptComponent = {"id": "stripe-2", "name": "Orange side stripe 2", "level": "micro", "role": "trim", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Painted orange line along the side, a flat strip on the surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.005, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3798, "height": 0.015, "depth": 0.01, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2414, 0.2328, 0.424], "rotation": [0, 0, 0], "scale": [0.3798, 0.015, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3798, 0.015, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}}, "material": "orange-trim", "materialLayers": ["orange-trim"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_stripe_2_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3798, 0.015, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}};
  (nodes["body"] ?? root).add(node_stripe_2_13);
  nodes["stripe-2"] = node_stripe_2_13;
  const mesh_stripe_2_13Geometry = endpoint_stripe_2_13
    ? new THREE.CylinderGeometry(endpoint_stripe_2_13.endRadius, endpoint_stripe_2_13.baseRadius, endpoint_stripe_2_13.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_stripe_2_13) {
    mesh_stripe_2_13Geometry.scale(0.3798, 0.015, 0.01);
  }
  const mesh_stripe_2_13 = new THREE.Mesh(
    mesh_stripe_2_13Geometry,
    materialMap["orange-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_2_13.name = "Orange side stripe 2";
  if (endpoint_stripe_2_13) {
    mesh_stripe_2_13.position.copy(endpoint_stripe_2_13.midpoint);
    mesh_stripe_2_13.quaternion.copy(endpoint_stripe_2_13.quaternion);
  }
  mesh_stripe_2_13.castShadow = options.castShadow ?? true;
  mesh_stripe_2_13.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_2_13.userData.sculptComponent = {"id": "stripe-2", "name": "Orange side stripe 2", "level": "micro", "role": "trim", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Painted orange line along the side, a flat strip on the surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.005, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3798, "height": 0.015, "depth": 0.01, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2414, 0.2328, 0.424], "rotation": [0, 0, 0], "scale": [0.3798, 0.015, 0.01]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3798, 0.015, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}}, "material": "orange-trim", "materialLayers": ["orange-trim"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_stripe_2_13.add(mesh_stripe_2_13);
  meshes["stripe-2"] = mesh_stripe_2_13;
  colliders["stripe-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.3798, 0.015, 0.01], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-2"] ??= [];
  destructionGroups["stripe-2"].push(node_stripe_2_13);

  const attachment_wheel_rear_near_14 = {"parentSocket": "axle-rear", "localStart": [-0.3069, 0.0858, 0.4], "localEnd": [-0.3069, 0.0858, 0.445], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_wheel_rear_near_14 = makeAttachmentEndpoint(attachment_wheel_rear_near_14);
  const node_wheel_rear_near_14 = new THREE.Group();
  node_wheel_rear_near_14.name = "Wheel rear near__pivot";
  node_wheel_rear_near_14.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_near_14) {
    node_wheel_rear_near_14.position.copy(endpoint_wheel_rear_near_14.start);
    node_wheel_rear_near_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_rear_near_14.position.set(-0.3069, 0.0858, 0.4);
    node_wheel_rear_near_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_rear_near_14.userData.sculptComponent = {"id": "wheel-rear-near", "name": "Wheel rear near", "level": "macro", "role": "wheel", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rubber disc: a short cylinder on the axle, rotating about z.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "axle-rear", "localStart": [-0.3069, 0.0858, 0.4], "localEnd": [-0.3069, 0.0858, 0.445], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.176, "height": 0.09, "depth": 0.176, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.3069, 0.0858, 0.4], "rotation": [0, 0, 0], "scale": [0.176, 0.09, 0.176]}, "actionProfile": {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, 0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-rear-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}}, "material": "tyre-rubber", "materialLayers": ["tyre-rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tread-rim", "kind": "ridge", "note": "darker shoulder ring (vertexPaint axis-band)"}], "surfaceDetail": {"macroRoughness": 0.9, "microRoughness": 0.1, "bumpAmplitude": 0.004, "normalPattern": "tread rim ring (vertexPaint) around the tyre shoulder", "displacementPattern": "none", "occlusionPattern": "hub recess", "edgeWearPattern": "none", "notes": "matte rubber"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(59, 43, 31, 1.0)", "secondaryAlbedo": "rgba(42, 29, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#3b2b1f", "regions": [{"id": "tread-rim", "kind": "axis-band", "axis": "y", "min": -0.5, "max": -0.35, "softness": 0.02, "color": "#2a1d14"}, {"id": "tread-rim-far", "kind": "axis-band", "axis": "y", "min": 0.35, "max": 0.5, "softness": 0.02, "color": "#2a1d14"}]}};
  node_wheel_rear_near_14.userData.actionProfile = {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, 0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-rear-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}};
  (nodes["body"] ?? root).add(node_wheel_rear_near_14);
  nodes["wheel-rear-near"] = node_wheel_rear_near_14;
  const mesh_wheel_rear_near_14Geometry = endpoint_wheel_rear_near_14
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_near_14.endRadius, endpoint_wheel_rear_near_14.baseRadius, endpoint_wheel_rear_near_14.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_wheel_rear_near_14) {
    mesh_wheel_rear_near_14Geometry.scale(0.176, 0.09, 0.176);
  }
  applyVertexPaint(mesh_wheel_rear_near_14Geometry, "#3b2b1f", [{"id": "tread-rim", "kind": "axis-band", "color": "#2a1d14", "softness": 0.02, "axis": "y", "min": -0.5, "max": -0.35}, {"id": "tread-rim-far", "kind": "axis-band", "color": "#2a1d14", "softness": 0.02, "axis": "y", "min": 0.35, "max": 0.5}]);
  const mesh_wheel_rear_near_14 = new THREE.Mesh(
    mesh_wheel_rear_near_14Geometry,
    materialMap["tyre-rubber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_near_14.name = "Wheel rear near";
  mesh_wheel_rear_near_14.material = mesh_wheel_rear_near_14.material.clone();
  mesh_wheel_rear_near_14.material.vertexColors = true;
  (mesh_wheel_rear_near_14.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_wheel_rear_near_14) {
    mesh_wheel_rear_near_14.position.copy(endpoint_wheel_rear_near_14.midpoint);
    mesh_wheel_rear_near_14.quaternion.copy(endpoint_wheel_rear_near_14.quaternion);
  }
  mesh_wheel_rear_near_14.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_near_14.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_near_14.userData.sculptComponent = {"id": "wheel-rear-near", "name": "Wheel rear near", "level": "macro", "role": "wheel", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rubber disc: a short cylinder on the axle, rotating about z.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "axle-rear", "localStart": [-0.3069, 0.0858, 0.4], "localEnd": [-0.3069, 0.0858, 0.445], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.176, "height": 0.09, "depth": 0.176, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.3069, 0.0858, 0.4], "rotation": [0, 0, 0], "scale": [0.176, 0.09, 0.176]}, "actionProfile": {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, 0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-rear-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}}, "material": "tyre-rubber", "materialLayers": ["tyre-rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tread-rim", "kind": "ridge", "note": "darker shoulder ring (vertexPaint axis-band)"}], "surfaceDetail": {"macroRoughness": 0.9, "microRoughness": 0.1, "bumpAmplitude": 0.004, "normalPattern": "tread rim ring (vertexPaint) around the tyre shoulder", "displacementPattern": "none", "occlusionPattern": "hub recess", "edgeWearPattern": "none", "notes": "matte rubber"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(59, 43, 31, 1.0)", "secondaryAlbedo": "rgba(42, 29, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#3b2b1f", "regions": [{"id": "tread-rim", "kind": "axis-band", "axis": "y", "min": -0.5, "max": -0.35, "softness": 0.02, "color": "#2a1d14"}, {"id": "tread-rim-far", "kind": "axis-band", "axis": "y", "min": 0.35, "max": 0.5, "softness": 0.02, "color": "#2a1d14"}]}};
  node_wheel_rear_near_14.add(mesh_wheel_rear_near_14);
  meshes["wheel-rear-near"] = mesh_wheel_rear_near_14;
  colliders["wheel-rear-near"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"};
  destructionGroups["wheel-rear-near"] ??= [];
  destructionGroups["wheel-rear-near"].push(node_wheel_rear_near_14);
  const socket_wheel_rear_near_hub_0 = new THREE.Object3D();
  socket_wheel_rear_near_hub_0.name = "hub";
  socket_wheel_rear_near_hub_0.position.set(0.0, 0.0, 0.046);
  socket_wheel_rear_near_hub_0.rotation.set(0, 0, 0);
  socket_wheel_rear_near_hub_0.userData.socket = {"id": "hub", "localPosition": [0, 0, 0.046]};
  node_wheel_rear_near_14.add(socket_wheel_rear_near_hub_0);
  sockets["wheel-rear-near:hub"] = socket_wheel_rear_near_hub_0;

  const attachment_hub_rear_near_15 = {"parentSocket": "hub", "localStart": [0, 0, 0.046], "localEnd": [0, 0, 0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_hub_rear_near_15 = makeAttachmentEndpoint(attachment_hub_rear_near_15);
  const node_hub_rear_near_15 = new THREE.Group();
  node_hub_rear_near_15.name = "Hub rear near__pivot";
  node_hub_rear_near_15.scale.set(1, 1, 1);
  if (endpoint_hub_rear_near_15) {
    node_hub_rear_near_15.position.copy(endpoint_hub_rear_near_15.start);
    node_hub_rear_near_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hub_rear_near_15.position.set(0.0, 0.0, 0.046);
    node_hub_rear_near_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_hub_rear_near_15.userData.sculptComponent = {"id": "hub-rear-near", "name": "Hub rear near", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat yellow hub cap disc on the wheel face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "wheel-rear-near", "attachment": {"parentSocket": "hub", "localStart": [0, 0, 0.046], "localEnd": [0, 0, 0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0773, "height": 0.012, "depth": 0.0773, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0.046], "rotation": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-rear-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}}, "material": "hub-yellow", "materialLayers": ["hub-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 210, 74, 1.0)", "secondaryAlbedo": "rgba(255, 198, 30, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hub_rear_near_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-rear-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}};
  (nodes["wheel-rear-near"] ?? root).add(node_hub_rear_near_15);
  nodes["hub-rear-near"] = node_hub_rear_near_15;
  const mesh_hub_rear_near_15Geometry = endpoint_hub_rear_near_15
    ? new THREE.CylinderGeometry(endpoint_hub_rear_near_15.endRadius, endpoint_hub_rear_near_15.baseRadius, endpoint_hub_rear_near_15.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_hub_rear_near_15) {
    mesh_hub_rear_near_15Geometry.scale(0.0773, 0.012, 0.0773);
  }
  const mesh_hub_rear_near_15 = new THREE.Mesh(
    mesh_hub_rear_near_15Geometry,
    materialMap["hub-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hub_rear_near_15.name = "Hub rear near";
  if (endpoint_hub_rear_near_15) {
    mesh_hub_rear_near_15.position.copy(endpoint_hub_rear_near_15.midpoint);
    mesh_hub_rear_near_15.quaternion.copy(endpoint_hub_rear_near_15.quaternion);
  }
  mesh_hub_rear_near_15.castShadow = options.castShadow ?? true;
  mesh_hub_rear_near_15.receiveShadow = options.receiveShadow ?? true;
  mesh_hub_rear_near_15.userData.sculptComponent = {"id": "hub-rear-near", "name": "Hub rear near", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat yellow hub cap disc on the wheel face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "wheel-rear-near", "attachment": {"parentSocket": "hub", "localStart": [0, 0, 0.046], "localEnd": [0, 0, 0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0773, "height": 0.012, "depth": 0.0773, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0.046], "rotation": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-rear-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}}, "material": "hub-yellow", "materialLayers": ["hub-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 210, 74, 1.0)", "secondaryAlbedo": "rgba(255, 198, 30, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hub_rear_near_15.add(mesh_hub_rear_near_15);
  meshes["hub-rear-near"] = mesh_hub_rear_near_15;
  colliders["hub-rear-near"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["hub-rear-near"] ??= [];
  destructionGroups["hub-rear-near"].push(node_hub_rear_near_15);

  const attachment_wheel_front_near_16 = {"parentSocket": "axle-front", "localStart": [0.1803, 0.0858, 0.4], "localEnd": [0.1803, 0.0858, 0.445], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_wheel_front_near_16 = makeAttachmentEndpoint(attachment_wheel_front_near_16);
  const node_wheel_front_near_16 = new THREE.Group();
  node_wheel_front_near_16.name = "Wheel front near__pivot";
  node_wheel_front_near_16.scale.set(1, 1, 1);
  if (endpoint_wheel_front_near_16) {
    node_wheel_front_near_16.position.copy(endpoint_wheel_front_near_16.start);
    node_wheel_front_near_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_front_near_16.position.set(0.1803, 0.0858, 0.4);
    node_wheel_front_near_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_front_near_16.userData.sculptComponent = {"id": "wheel-front-near", "name": "Wheel front near", "level": "macro", "role": "wheel", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rubber disc: a short cylinder on the axle, rotating about z.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "axle-front", "localStart": [0.1803, 0.0858, 0.4], "localEnd": [0.1803, 0.0858, 0.445], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.176, "height": 0.09, "depth": 0.176, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1803, 0.0858, 0.4], "rotation": [0, 0, 0], "scale": [0.176, 0.09, 0.176]}, "actionProfile": {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, 0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-front-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}}, "material": "tyre-rubber", "materialLayers": ["tyre-rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tread-rim", "kind": "ridge", "note": "darker shoulder ring (vertexPaint axis-band)"}], "surfaceDetail": {"macroRoughness": 0.9, "microRoughness": 0.1, "bumpAmplitude": 0.004, "normalPattern": "tread rim ring (vertexPaint) around the tyre shoulder", "displacementPattern": "none", "occlusionPattern": "hub recess", "edgeWearPattern": "none", "notes": "matte rubber"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(59, 43, 31, 1.0)", "secondaryAlbedo": "rgba(42, 29, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#3b2b1f", "regions": [{"id": "tread-rim", "kind": "axis-band", "axis": "y", "min": -0.5, "max": -0.35, "softness": 0.02, "color": "#2a1d14"}, {"id": "tread-rim-far", "kind": "axis-band", "axis": "y", "min": 0.35, "max": 0.5, "softness": 0.02, "color": "#2a1d14"}]}};
  node_wheel_front_near_16.userData.actionProfile = {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, 0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-front-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}};
  (nodes["body"] ?? root).add(node_wheel_front_near_16);
  nodes["wheel-front-near"] = node_wheel_front_near_16;
  const mesh_wheel_front_near_16Geometry = endpoint_wheel_front_near_16
    ? new THREE.CylinderGeometry(endpoint_wheel_front_near_16.endRadius, endpoint_wheel_front_near_16.baseRadius, endpoint_wheel_front_near_16.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_wheel_front_near_16) {
    mesh_wheel_front_near_16Geometry.scale(0.176, 0.09, 0.176);
  }
  applyVertexPaint(mesh_wheel_front_near_16Geometry, "#3b2b1f", [{"id": "tread-rim", "kind": "axis-band", "color": "#2a1d14", "softness": 0.02, "axis": "y", "min": -0.5, "max": -0.35}, {"id": "tread-rim-far", "kind": "axis-band", "color": "#2a1d14", "softness": 0.02, "axis": "y", "min": 0.35, "max": 0.5}]);
  const mesh_wheel_front_near_16 = new THREE.Mesh(
    mesh_wheel_front_near_16Geometry,
    materialMap["tyre-rubber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_near_16.name = "Wheel front near";
  mesh_wheel_front_near_16.material = mesh_wheel_front_near_16.material.clone();
  mesh_wheel_front_near_16.material.vertexColors = true;
  (mesh_wheel_front_near_16.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_wheel_front_near_16) {
    mesh_wheel_front_near_16.position.copy(endpoint_wheel_front_near_16.midpoint);
    mesh_wheel_front_near_16.quaternion.copy(endpoint_wheel_front_near_16.quaternion);
  }
  mesh_wheel_front_near_16.castShadow = options.castShadow ?? true;
  mesh_wheel_front_near_16.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_near_16.userData.sculptComponent = {"id": "wheel-front-near", "name": "Wheel front near", "level": "macro", "role": "wheel", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rubber disc: a short cylinder on the axle, rotating about z.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "axle-front", "localStart": [0.1803, 0.0858, 0.4], "localEnd": [0.1803, 0.0858, 0.445], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.176, "height": 0.09, "depth": 0.176, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1803, 0.0858, 0.4], "rotation": [0, 0, 0], "scale": [0.176, 0.09, 0.176]}, "actionProfile": {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, 0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-front-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}}, "material": "tyre-rubber", "materialLayers": ["tyre-rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tread-rim", "kind": "ridge", "note": "darker shoulder ring (vertexPaint axis-band)"}], "surfaceDetail": {"macroRoughness": 0.9, "microRoughness": 0.1, "bumpAmplitude": 0.004, "normalPattern": "tread rim ring (vertexPaint) around the tyre shoulder", "displacementPattern": "none", "occlusionPattern": "hub recess", "edgeWearPattern": "none", "notes": "matte rubber"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(59, 43, 31, 1.0)", "secondaryAlbedo": "rgba(42, 29, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#3b2b1f", "regions": [{"id": "tread-rim", "kind": "axis-band", "axis": "y", "min": -0.5, "max": -0.35, "softness": 0.02, "color": "#2a1d14"}, {"id": "tread-rim-far", "kind": "axis-band", "axis": "y", "min": 0.35, "max": 0.5, "softness": 0.02, "color": "#2a1d14"}]}};
  node_wheel_front_near_16.add(mesh_wheel_front_near_16);
  meshes["wheel-front-near"] = mesh_wheel_front_near_16;
  colliders["wheel-front-near"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"};
  destructionGroups["wheel-front-near"] ??= [];
  destructionGroups["wheel-front-near"].push(node_wheel_front_near_16);
  const socket_wheel_front_near_hub_0 = new THREE.Object3D();
  socket_wheel_front_near_hub_0.name = "hub";
  socket_wheel_front_near_hub_0.position.set(0.0, 0.0, 0.046);
  socket_wheel_front_near_hub_0.rotation.set(0, 0, 0);
  socket_wheel_front_near_hub_0.userData.socket = {"id": "hub", "localPosition": [0, 0, 0.046]};
  node_wheel_front_near_16.add(socket_wheel_front_near_hub_0);
  sockets["wheel-front-near:hub"] = socket_wheel_front_near_hub_0;

  const attachment_hub_front_near_17 = {"parentSocket": "hub", "localStart": [0, 0, 0.046], "localEnd": [0, 0, 0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_hub_front_near_17 = makeAttachmentEndpoint(attachment_hub_front_near_17);
  const node_hub_front_near_17 = new THREE.Group();
  node_hub_front_near_17.name = "Hub front near__pivot";
  node_hub_front_near_17.scale.set(1, 1, 1);
  if (endpoint_hub_front_near_17) {
    node_hub_front_near_17.position.copy(endpoint_hub_front_near_17.start);
    node_hub_front_near_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hub_front_near_17.position.set(0.0, 0.0, 0.046);
    node_hub_front_near_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_hub_front_near_17.userData.sculptComponent = {"id": "hub-front-near", "name": "Hub front near", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat yellow hub cap disc on the wheel face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "wheel-front-near", "attachment": {"parentSocket": "hub", "localStart": [0, 0, 0.046], "localEnd": [0, 0, 0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0773, "height": 0.012, "depth": 0.0773, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0.046], "rotation": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-front-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}}, "material": "hub-yellow", "materialLayers": ["hub-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 210, 74, 1.0)", "secondaryAlbedo": "rgba(255, 198, 30, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hub_front_near_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-front-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}};
  (nodes["wheel-front-near"] ?? root).add(node_hub_front_near_17);
  nodes["hub-front-near"] = node_hub_front_near_17;
  const mesh_hub_front_near_17Geometry = endpoint_hub_front_near_17
    ? new THREE.CylinderGeometry(endpoint_hub_front_near_17.endRadius, endpoint_hub_front_near_17.baseRadius, endpoint_hub_front_near_17.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_hub_front_near_17) {
    mesh_hub_front_near_17Geometry.scale(0.0773, 0.012, 0.0773);
  }
  const mesh_hub_front_near_17 = new THREE.Mesh(
    mesh_hub_front_near_17Geometry,
    materialMap["hub-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hub_front_near_17.name = "Hub front near";
  if (endpoint_hub_front_near_17) {
    mesh_hub_front_near_17.position.copy(endpoint_hub_front_near_17.midpoint);
    mesh_hub_front_near_17.quaternion.copy(endpoint_hub_front_near_17.quaternion);
  }
  mesh_hub_front_near_17.castShadow = options.castShadow ?? true;
  mesh_hub_front_near_17.receiveShadow = options.receiveShadow ?? true;
  mesh_hub_front_near_17.userData.sculptComponent = {"id": "hub-front-near", "name": "Hub front near", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat yellow hub cap disc on the wheel face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "wheel-front-near", "attachment": {"parentSocket": "hub", "localStart": [0, 0, 0.046], "localEnd": [0, 0, 0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0773, "height": 0.012, "depth": 0.0773, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0.046], "rotation": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-front-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}}, "material": "hub-yellow", "materialLayers": ["hub-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 210, 74, 1.0)", "secondaryAlbedo": "rgba(255, 198, 30, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hub_front_near_17.add(mesh_hub_front_near_17);
  meshes["hub-front-near"] = mesh_hub_front_near_17;
  colliders["hub-front-near"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["hub-front-near"] ??= [];
  destructionGroups["hub-front-near"].push(node_hub_front_near_17);

  const attachment_wheel_rear_far_18 = {"parentSocket": "axle-rear", "localStart": [-0.3069, 0.0858, 0.02], "localEnd": [-0.3069, 0.0858, -0.025], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_wheel_rear_far_18 = makeAttachmentEndpoint(attachment_wheel_rear_far_18);
  const node_wheel_rear_far_18 = new THREE.Group();
  node_wheel_rear_far_18.name = "Wheel rear far__pivot";
  node_wheel_rear_far_18.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_far_18) {
    node_wheel_rear_far_18.position.copy(endpoint_wheel_rear_far_18.start);
    node_wheel_rear_far_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_rear_far_18.position.set(-0.3069, 0.0858, 0.02);
    node_wheel_rear_far_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_rear_far_18.userData.sculptComponent = {"id": "wheel-rear-far", "name": "Wheel rear far", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.6, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rubber disc: a short cylinder on the axle, rotating about z.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "axle-rear", "localStart": [-0.3069, 0.0858, 0.02], "localEnd": [-0.3069, 0.0858, -0.025], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.176, "height": 0.09, "depth": 0.176, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.3069, 0.0858, 0.02], "rotation": [0, 0, 0], "scale": [0.176, 0.09, 0.176]}, "actionProfile": {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, -0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-rear-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}}, "material": "tyre-rubber", "materialLayers": ["tyre-rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tread-rim", "kind": "ridge", "note": "darker shoulder ring (vertexPaint axis-band)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(59, 43, 31, 1.0)", "secondaryAlbedo": "rgba(42, 29, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#3b2b1f", "regions": [{"id": "tread-rim", "kind": "axis-band", "axis": "y", "min": -0.5, "max": -0.35, "softness": 0.02, "color": "#2a1d14"}, {"id": "tread-rim-far", "kind": "axis-band", "axis": "y", "min": 0.35, "max": 0.5, "softness": 0.02, "color": "#2a1d14"}]}};
  node_wheel_rear_far_18.userData.actionProfile = {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, -0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-rear-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}};
  (nodes["body"] ?? root).add(node_wheel_rear_far_18);
  nodes["wheel-rear-far"] = node_wheel_rear_far_18;
  const mesh_wheel_rear_far_18Geometry = endpoint_wheel_rear_far_18
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_far_18.endRadius, endpoint_wheel_rear_far_18.baseRadius, endpoint_wheel_rear_far_18.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_wheel_rear_far_18) {
    mesh_wheel_rear_far_18Geometry.scale(0.176, 0.09, 0.176);
  }
  applyVertexPaint(mesh_wheel_rear_far_18Geometry, "#3b2b1f", [{"id": "tread-rim", "kind": "axis-band", "color": "#2a1d14", "softness": 0.02, "axis": "y", "min": -0.5, "max": -0.35}, {"id": "tread-rim-far", "kind": "axis-band", "color": "#2a1d14", "softness": 0.02, "axis": "y", "min": 0.35, "max": 0.5}]);
  const mesh_wheel_rear_far_18 = new THREE.Mesh(
    mesh_wheel_rear_far_18Geometry,
    materialMap["tyre-rubber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_far_18.name = "Wheel rear far";
  mesh_wheel_rear_far_18.material = mesh_wheel_rear_far_18.material.clone();
  mesh_wheel_rear_far_18.material.vertexColors = true;
  (mesh_wheel_rear_far_18.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_wheel_rear_far_18) {
    mesh_wheel_rear_far_18.position.copy(endpoint_wheel_rear_far_18.midpoint);
    mesh_wheel_rear_far_18.quaternion.copy(endpoint_wheel_rear_far_18.quaternion);
  }
  mesh_wheel_rear_far_18.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_far_18.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_far_18.userData.sculptComponent = {"id": "wheel-rear-far", "name": "Wheel rear far", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.6, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rubber disc: a short cylinder on the axle, rotating about z.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "axle-rear", "localStart": [-0.3069, 0.0858, 0.02], "localEnd": [-0.3069, 0.0858, -0.025], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.176, "height": 0.09, "depth": 0.176, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.3069, 0.0858, 0.02], "rotation": [0, 0, 0], "scale": [0.176, 0.09, 0.176]}, "actionProfile": {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, -0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-rear-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}}, "material": "tyre-rubber", "materialLayers": ["tyre-rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tread-rim", "kind": "ridge", "note": "darker shoulder ring (vertexPaint axis-band)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(59, 43, 31, 1.0)", "secondaryAlbedo": "rgba(42, 29, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#3b2b1f", "regions": [{"id": "tread-rim", "kind": "axis-band", "axis": "y", "min": -0.5, "max": -0.35, "softness": 0.02, "color": "#2a1d14"}, {"id": "tread-rim-far", "kind": "axis-band", "axis": "y", "min": 0.35, "max": 0.5, "softness": 0.02, "color": "#2a1d14"}]}};
  node_wheel_rear_far_18.add(mesh_wheel_rear_far_18);
  meshes["wheel-rear-far"] = mesh_wheel_rear_far_18;
  colliders["wheel-rear-far"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"};
  destructionGroups["wheel-rear-far"] ??= [];
  destructionGroups["wheel-rear-far"].push(node_wheel_rear_far_18);
  const socket_wheel_rear_far_hub_0 = new THREE.Object3D();
  socket_wheel_rear_far_hub_0.name = "hub";
  socket_wheel_rear_far_hub_0.position.set(0.0, 0.0, -0.046);
  socket_wheel_rear_far_hub_0.rotation.set(0, 0, 0);
  socket_wheel_rear_far_hub_0.userData.socket = {"id": "hub", "localPosition": [0, 0, -0.046]};
  node_wheel_rear_far_18.add(socket_wheel_rear_far_hub_0);
  sockets["wheel-rear-far:hub"] = socket_wheel_rear_far_hub_0;

  const attachment_hub_rear_far_19 = {"parentSocket": "hub", "localStart": [0, 0, -0.046], "localEnd": [0, 0, -0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_hub_rear_far_19 = makeAttachmentEndpoint(attachment_hub_rear_far_19);
  const node_hub_rear_far_19 = new THREE.Group();
  node_hub_rear_far_19.name = "Hub rear far__pivot";
  node_hub_rear_far_19.scale.set(1, 1, 1);
  if (endpoint_hub_rear_far_19) {
    node_hub_rear_far_19.position.copy(endpoint_hub_rear_far_19.start);
    node_hub_rear_far_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hub_rear_far_19.position.set(0.0, 0.0, -0.046);
    node_hub_rear_far_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_hub_rear_far_19.userData.sculptComponent = {"id": "hub-rear-far", "name": "Hub rear far", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat yellow hub cap disc on the wheel face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "wheel-rear-far", "attachment": {"parentSocket": "hub", "localStart": [0, 0, -0.046], "localEnd": [0, 0, -0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0773, "height": 0.012, "depth": 0.0773, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, -0.046], "rotation": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-rear-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}}, "material": "hub-yellow", "materialLayers": ["hub-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 210, 74, 1.0)", "secondaryAlbedo": "rgba(255, 198, 30, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hub_rear_far_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-rear-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}};
  (nodes["wheel-rear-far"] ?? root).add(node_hub_rear_far_19);
  nodes["hub-rear-far"] = node_hub_rear_far_19;
  const mesh_hub_rear_far_19Geometry = endpoint_hub_rear_far_19
    ? new THREE.CylinderGeometry(endpoint_hub_rear_far_19.endRadius, endpoint_hub_rear_far_19.baseRadius, endpoint_hub_rear_far_19.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_hub_rear_far_19) {
    mesh_hub_rear_far_19Geometry.scale(0.0773, 0.012, 0.0773);
  }
  const mesh_hub_rear_far_19 = new THREE.Mesh(
    mesh_hub_rear_far_19Geometry,
    materialMap["hub-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hub_rear_far_19.name = "Hub rear far";
  if (endpoint_hub_rear_far_19) {
    mesh_hub_rear_far_19.position.copy(endpoint_hub_rear_far_19.midpoint);
    mesh_hub_rear_far_19.quaternion.copy(endpoint_hub_rear_far_19.quaternion);
  }
  mesh_hub_rear_far_19.castShadow = options.castShadow ?? true;
  mesh_hub_rear_far_19.receiveShadow = options.receiveShadow ?? true;
  mesh_hub_rear_far_19.userData.sculptComponent = {"id": "hub-rear-far", "name": "Hub rear far", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat yellow hub cap disc on the wheel face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "wheel-rear-far", "attachment": {"parentSocket": "hub", "localStart": [0, 0, -0.046], "localEnd": [0, 0, -0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0773, "height": 0.012, "depth": 0.0773, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, -0.046], "rotation": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-rear-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}}, "material": "hub-yellow", "materialLayers": ["hub-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 210, 74, 1.0)", "secondaryAlbedo": "rgba(255, 198, 30, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hub_rear_far_19.add(mesh_hub_rear_far_19);
  meshes["hub-rear-far"] = mesh_hub_rear_far_19;
  colliders["hub-rear-far"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["hub-rear-far"] ??= [];
  destructionGroups["hub-rear-far"].push(node_hub_rear_far_19);

  const attachment_wheel_front_far_20 = {"parentSocket": "axle-front", "localStart": [0.1803, 0.0858, 0.02], "localEnd": [0.1803, 0.0858, -0.025], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_wheel_front_far_20 = makeAttachmentEndpoint(attachment_wheel_front_far_20);
  const node_wheel_front_far_20 = new THREE.Group();
  node_wheel_front_far_20.name = "Wheel front far__pivot";
  node_wheel_front_far_20.scale.set(1, 1, 1);
  if (endpoint_wheel_front_far_20) {
    node_wheel_front_far_20.position.copy(endpoint_wheel_front_far_20.start);
    node_wheel_front_far_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_front_far_20.position.set(0.1803, 0.0858, 0.02);
    node_wheel_front_far_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_front_far_20.userData.sculptComponent = {"id": "wheel-front-far", "name": "Wheel front far", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.6, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rubber disc: a short cylinder on the axle, rotating about z.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "axle-front", "localStart": [0.1803, 0.0858, 0.02], "localEnd": [0.1803, 0.0858, -0.025], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.176, "height": 0.09, "depth": 0.176, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.1803, 0.0858, 0.02], "rotation": [0, 0, 0], "scale": [0.176, 0.09, 0.176]}, "actionProfile": {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, -0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-front-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}}, "material": "tyre-rubber", "materialLayers": ["tyre-rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tread-rim", "kind": "ridge", "note": "darker shoulder ring (vertexPaint axis-band)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(59, 43, 31, 1.0)", "secondaryAlbedo": "rgba(42, 29, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#3b2b1f", "regions": [{"id": "tread-rim", "kind": "axis-band", "axis": "y", "min": -0.5, "max": -0.35, "softness": 0.02, "color": "#2a1d14"}, {"id": "tread-rim-far", "kind": "axis-band", "axis": "y", "min": 0.35, "max": 0.5, "softness": 0.02, "color": "#2a1d14"}]}};
  node_wheel_front_far_20.userData.actionProfile = {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, -0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-front-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}};
  (nodes["body"] ?? root).add(node_wheel_front_far_20);
  nodes["wheel-front-far"] = node_wheel_front_far_20;
  const mesh_wheel_front_far_20Geometry = endpoint_wheel_front_far_20
    ? new THREE.CylinderGeometry(endpoint_wheel_front_far_20.endRadius, endpoint_wheel_front_far_20.baseRadius, endpoint_wheel_front_far_20.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_wheel_front_far_20) {
    mesh_wheel_front_far_20Geometry.scale(0.176, 0.09, 0.176);
  }
  applyVertexPaint(mesh_wheel_front_far_20Geometry, "#3b2b1f", [{"id": "tread-rim", "kind": "axis-band", "color": "#2a1d14", "softness": 0.02, "axis": "y", "min": -0.5, "max": -0.35}, {"id": "tread-rim-far", "kind": "axis-band", "color": "#2a1d14", "softness": 0.02, "axis": "y", "min": 0.35, "max": 0.5}]);
  const mesh_wheel_front_far_20 = new THREE.Mesh(
    mesh_wheel_front_far_20Geometry,
    materialMap["tyre-rubber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_far_20.name = "Wheel front far";
  mesh_wheel_front_far_20.material = mesh_wheel_front_far_20.material.clone();
  mesh_wheel_front_far_20.material.vertexColors = true;
  (mesh_wheel_front_far_20.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_wheel_front_far_20) {
    mesh_wheel_front_far_20.position.copy(endpoint_wheel_front_far_20.midpoint);
    mesh_wheel_front_far_20.quaternion.copy(endpoint_wheel_front_far_20.quaternion);
  }
  mesh_wheel_front_far_20.castShadow = options.castShadow ?? true;
  mesh_wheel_front_far_20.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_far_20.userData.sculptComponent = {"id": "wheel-front-far", "name": "Wheel front far", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.6, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rubber disc: a short cylinder on the axle, rotating about z.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "axle-front", "localStart": [0.1803, 0.0858, 0.02], "localEnd": [0.1803, 0.0858, -0.025], "contactType": "axle", "baseRadius": 0.088, "endRadius": 0.088, "embedDepth": 0.04, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.176, "height": 0.09, "depth": 0.176, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.1803, 0.0858, 0.02], "rotation": [0, 0, 0], "scale": [0.176, 0.09, 0.176]}, "actionProfile": {"animationRole": "wheel", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "hub", "localPosition": [0, 0, -0.046]}], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "wheel-front-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tyre-rubber"}}, "material": "tyre-rubber", "materialLayers": ["tyre-rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tread-rim", "kind": "ridge", "note": "darker shoulder ring (vertexPaint axis-band)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(59, 43, 31, 1.0)", "secondaryAlbedo": "rgba(42, 29, 20, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#3b2b1f", "regions": [{"id": "tread-rim", "kind": "axis-band", "axis": "y", "min": -0.5, "max": -0.35, "softness": 0.02, "color": "#2a1d14"}, {"id": "tread-rim-far", "kind": "axis-band", "axis": "y", "min": 0.35, "max": 0.5, "softness": 0.02, "color": "#2a1d14"}]}};
  node_wheel_front_far_20.add(mesh_wheel_front_far_20);
  meshes["wheel-front-far"] = mesh_wheel_front_far_20;
  colliders["wheel-front-far"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.176, 0.09, 0.176], "isTrigger": false, "notes": "wheel proxy"};
  destructionGroups["wheel-front-far"] ??= [];
  destructionGroups["wheel-front-far"].push(node_wheel_front_far_20);
  const socket_wheel_front_far_hub_0 = new THREE.Object3D();
  socket_wheel_front_far_hub_0.name = "hub";
  socket_wheel_front_far_hub_0.position.set(0.0, 0.0, -0.046);
  socket_wheel_front_far_hub_0.rotation.set(0, 0, 0);
  socket_wheel_front_far_hub_0.userData.socket = {"id": "hub", "localPosition": [0, 0, -0.046]};
  node_wheel_front_far_20.add(socket_wheel_front_far_hub_0);
  sockets["wheel-front-far:hub"] = socket_wheel_front_far_hub_0;

  const attachment_hub_front_far_21 = {"parentSocket": "hub", "localStart": [0, 0, -0.046], "localEnd": [0, 0, -0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_hub_front_far_21 = makeAttachmentEndpoint(attachment_hub_front_far_21);
  const node_hub_front_far_21 = new THREE.Group();
  node_hub_front_far_21.name = "Hub front far__pivot";
  node_hub_front_far_21.scale.set(1, 1, 1);
  if (endpoint_hub_front_far_21) {
    node_hub_front_far_21.position.copy(endpoint_hub_front_far_21.start);
    node_hub_front_far_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hub_front_far_21.position.set(0.0, 0.0, -0.046);
    node_hub_front_far_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_hub_front_far_21.userData.sculptComponent = {"id": "hub-front-far", "name": "Hub front far", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat yellow hub cap disc on the wheel face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "wheel-front-far", "attachment": {"parentSocket": "hub", "localStart": [0, 0, -0.046], "localEnd": [0, 0, -0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0773, "height": 0.012, "depth": 0.0773, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, -0.046], "rotation": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-front-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}}, "material": "hub-yellow", "materialLayers": ["hub-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 210, 74, 1.0)", "secondaryAlbedo": "rgba(255, 198, 30, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hub_front_far_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-front-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}};
  (nodes["wheel-front-far"] ?? root).add(node_hub_front_far_21);
  nodes["hub-front-far"] = node_hub_front_far_21;
  const mesh_hub_front_far_21Geometry = endpoint_hub_front_far_21
    ? new THREE.CylinderGeometry(endpoint_hub_front_far_21.endRadius, endpoint_hub_front_far_21.baseRadius, endpoint_hub_front_far_21.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_hub_front_far_21) {
    mesh_hub_front_far_21Geometry.scale(0.0773, 0.012, 0.0773);
  }
  const mesh_hub_front_far_21 = new THREE.Mesh(
    mesh_hub_front_far_21Geometry,
    materialMap["hub-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hub_front_far_21.name = "Hub front far";
  if (endpoint_hub_front_far_21) {
    mesh_hub_front_far_21.position.copy(endpoint_hub_front_far_21.midpoint);
    mesh_hub_front_far_21.quaternion.copy(endpoint_hub_front_far_21.quaternion);
  }
  mesh_hub_front_far_21.castShadow = options.castShadow ?? true;
  mesh_hub_front_far_21.receiveShadow = options.receiveShadow ?? true;
  mesh_hub_front_far_21.userData.sculptComponent = {"id": "hub-front-far", "name": "Hub front far", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat yellow hub cap disc on the wheel face.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "wheel-front-far", "attachment": {"parentSocket": "hub", "localStart": [0, 0, -0.046], "localEnd": [0, 0, -0.058], "contactType": "butt", "baseRadius": 0.0386, "endRadius": 0.0386, "embedDepth": 0.004, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0773, "height": 0.012, "depth": 0.0773, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, -0.046], "rotation": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hub-front-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hub-yellow"}}, "material": "hub-yellow", "materialLayers": ["hub-yellow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 210, 74, 1.0)", "secondaryAlbedo": "rgba(255, 198, 30, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hub_front_far_21.add(mesh_hub_front_far_21);
  meshes["hub-front-far"] = mesh_hub_front_far_21;
  colliders["hub-front-far"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0773, 0.012, 0.0773], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["hub-front-far"] ??= [];
  destructionGroups["hub-front-far"].push(node_hub_front_far_21);

  const endpoint_bumper_front_22 = makeAttachmentEndpoint(null);
  const node_bumper_front_22 = new THREE.Group();
  node_bumper_front_22.name = "Front bumper__pivot";
  node_bumper_front_22.scale.set(1, 1, 1);
  if (endpoint_bumper_front_22) {
    node_bumper_front_22.position.copy(endpoint_bumper_front_22.start);
    node_bumper_front_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_bumper_front_22.position.set(0.5172, 0.088, 0.21);
    node_bumper_front_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_bumper_front_22.userData.sculptComponent = {"id": "bumper-front", "name": "Front bumper", "level": "meso", "role": "trim", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid orange bar across the lower front.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.015, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.01, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.05, "height": 0.0858, "depth": 0.42, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.5172, 0.088, 0.21], "rotation": [0, 0, 0], "scale": [0.05, 0.0858, 0.42]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.0858, 0.42], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bumper-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}}, "material": "orange-trim", "materialLayers": ["orange-trim"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 140, 46, 1.0)", "secondaryAlbedo": "rgba(255, 140, 46, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_bumper_front_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.0858, 0.42], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bumper-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}};
  (nodes["body"] ?? root).add(node_bumper_front_22);
  nodes["bumper-front"] = node_bumper_front_22;
  const mesh_bumper_front_22Geometry = endpoint_bumper_front_22
    ? new THREE.CylinderGeometry(endpoint_bumper_front_22.endRadius, endpoint_bumper_front_22.baseRadius, endpoint_bumper_front_22.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_bumper_front_22) {
    mesh_bumper_front_22Geometry.scale(0.05, 0.0858, 0.42);
  }
  const mesh_bumper_front_22 = new THREE.Mesh(
    mesh_bumper_front_22Geometry,
    materialMap["orange-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bumper_front_22.name = "Front bumper";
  if (endpoint_bumper_front_22) {
    mesh_bumper_front_22.position.copy(endpoint_bumper_front_22.midpoint);
    mesh_bumper_front_22.quaternion.copy(endpoint_bumper_front_22.quaternion);
  }
  mesh_bumper_front_22.castShadow = options.castShadow ?? true;
  mesh_bumper_front_22.receiveShadow = options.receiveShadow ?? true;
  mesh_bumper_front_22.userData.sculptComponent = {"id": "bumper-front", "name": "Front bumper", "level": "meso", "role": "trim", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid orange bar across the lower front.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.015, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.01, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.05, "height": 0.0858, "depth": 0.42, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.5172, 0.088, 0.21], "rotation": [0, 0, 0], "scale": [0.05, 0.0858, 0.42]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.0858, 0.42], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bumper-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}}, "material": "orange-trim", "materialLayers": ["orange-trim"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 140, 46, 1.0)", "secondaryAlbedo": "rgba(255, 140, 46, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_bumper_front_22.add(mesh_bumper_front_22);
  meshes["bumper-front"] = mesh_bumper_front_22;
  colliders["bumper-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.0858, 0.42], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["bumper-front"] ??= [];
  destructionGroups["bumper-front"].push(node_bumper_front_22);

  const endpoint_grill_23 = makeAttachmentEndpoint(null);
  const node_grill_23 = new THREE.Group();
  node_grill_23.name = "Grill__pivot";
  node_grill_23.scale.set(1, 1, 1);
  if (endpoint_grill_23) {
    node_grill_23.position.copy(endpoint_grill_23.start);
    node_grill_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_grill_23.position.set(0.5021, 0.1845, 0.21);
    node_grill_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_grill_23.userData.sculptComponent = {"id": "grill", "name": "Grill", "level": "meso", "role": "trim", "importance": 0.7, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Orange grill plate on the hood front face with three horizontal slats.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.005, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01, "height": 0.0966, "depth": 0.189, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.5021, 0.1845, 0.21], "rotation": [0, 0, 0], "scale": [0.01, 0.0966, 0.189]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.01, 0.0966, 0.189], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}}, "material": "orange-trim", "materialLayers": ["orange-trim"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "slats", "kind": "ridge", "note": "three horizontal slats built as micro boxes"}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.05, "bumpAmplitude": 0.006, "normalPattern": "three raised slats (micro boxes)", "displacementPattern": "none", "occlusionPattern": "between slats", "edgeWearPattern": "none", "notes": "relief is real geometry"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 140, 46, 1.0)", "secondaryAlbedo": "rgba(255, 140, 46, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_grill_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.01, 0.0966, 0.189], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}};
  (nodes["body"] ?? root).add(node_grill_23);
  nodes["grill"] = node_grill_23;
  const mesh_grill_23Geometry = endpoint_grill_23
    ? new THREE.CylinderGeometry(endpoint_grill_23.endRadius, endpoint_grill_23.baseRadius, endpoint_grill_23.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_grill_23) {
    mesh_grill_23Geometry.scale(0.01, 0.0966, 0.189);
  }
  const mesh_grill_23 = new THREE.Mesh(
    mesh_grill_23Geometry,
    materialMap["orange-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grill_23.name = "Grill";
  if (endpoint_grill_23) {
    mesh_grill_23.position.copy(endpoint_grill_23.midpoint);
    mesh_grill_23.quaternion.copy(endpoint_grill_23.quaternion);
  }
  mesh_grill_23.castShadow = options.castShadow ?? true;
  mesh_grill_23.receiveShadow = options.receiveShadow ?? true;
  mesh_grill_23.userData.sculptComponent = {"id": "grill", "name": "Grill", "level": "meso", "role": "trim", "importance": 0.7, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Orange grill plate on the hood front face with three horizontal slats.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.005, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01, "height": 0.0966, "depth": 0.189, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.5021, 0.1845, 0.21], "rotation": [0, 0, 0], "scale": [0.01, 0.0966, 0.189]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.01, 0.0966, 0.189], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}}, "material": "orange-trim", "materialLayers": ["orange-trim"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "slats", "kind": "ridge", "note": "three horizontal slats built as micro boxes"}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.05, "bumpAmplitude": 0.006, "normalPattern": "three raised slats (micro boxes)", "displacementPattern": "none", "occlusionPattern": "between slats", "edgeWearPattern": "none", "notes": "relief is real geometry"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 140, 46, 1.0)", "secondaryAlbedo": "rgba(255, 140, 46, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_grill_23.add(mesh_grill_23);
  meshes["grill"] = mesh_grill_23;
  colliders["grill"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.01, 0.0966, 0.189], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["grill"] ??= [];
  destructionGroups["grill"].push(node_grill_23);

  const endpoint_grill_slat_1_24 = makeAttachmentEndpoint(null);
  const node_grill_slat_1_24 = new THREE.Group();
  node_grill_slat_1_24.name = "Grill slat 1__pivot";
  node_grill_slat_1_24.scale.set(1, 1, 1);
  if (endpoint_grill_slat_1_24) {
    node_grill_slat_1_24.position.copy(endpoint_grill_slat_1_24.start);
    node_grill_slat_1_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_grill_slat_1_24.position.set(0.006, -0.028, 0.0);
    node_grill_slat_1_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_grill_slat_1_24.userData.sculptComponent = {"id": "grill-slat-1", "name": "Grill slat 1", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Raised horizontal slat on the grill plate.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "grill", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.003, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.006, "height": 0.012, "depth": 0.168, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.006, -0.028, 0], "rotation": [0, 0, 0], "scale": [0.006, 0.012, 0.168]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill-slat-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(34, 27, 23, 1.0)", "secondaryAlbedo": "rgba(34, 27, 23, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_grill_slat_1_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill-slat-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["grill"] ?? root).add(node_grill_slat_1_24);
  nodes["grill-slat-1"] = node_grill_slat_1_24;
  const mesh_grill_slat_1_24Geometry = endpoint_grill_slat_1_24
    ? new THREE.CylinderGeometry(endpoint_grill_slat_1_24.endRadius, endpoint_grill_slat_1_24.baseRadius, endpoint_grill_slat_1_24.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_grill_slat_1_24) {
    mesh_grill_slat_1_24Geometry.scale(0.006, 0.012, 0.168);
  }
  const mesh_grill_slat_1_24 = new THREE.Mesh(
    mesh_grill_slat_1_24Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grill_slat_1_24.name = "Grill slat 1";
  if (endpoint_grill_slat_1_24) {
    mesh_grill_slat_1_24.position.copy(endpoint_grill_slat_1_24.midpoint);
    mesh_grill_slat_1_24.quaternion.copy(endpoint_grill_slat_1_24.quaternion);
  }
  mesh_grill_slat_1_24.castShadow = options.castShadow ?? true;
  mesh_grill_slat_1_24.receiveShadow = options.receiveShadow ?? true;
  mesh_grill_slat_1_24.userData.sculptComponent = {"id": "grill-slat-1", "name": "Grill slat 1", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Raised horizontal slat on the grill plate.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "grill", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.003, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.006, "height": 0.012, "depth": 0.168, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.006, -0.028, 0], "rotation": [0, 0, 0], "scale": [0.006, 0.012, 0.168]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill-slat-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(34, 27, 23, 1.0)", "secondaryAlbedo": "rgba(34, 27, 23, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_grill_slat_1_24.add(mesh_grill_slat_1_24);
  meshes["grill-slat-1"] = mesh_grill_slat_1_24;
  colliders["grill-slat-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["grill-slat-1"] ??= [];
  destructionGroups["grill-slat-1"].push(node_grill_slat_1_24);

  const endpoint_grill_slat_2_25 = makeAttachmentEndpoint(null);
  const node_grill_slat_2_25 = new THREE.Group();
  node_grill_slat_2_25.name = "Grill slat 2__pivot";
  node_grill_slat_2_25.scale.set(1, 1, 1);
  if (endpoint_grill_slat_2_25) {
    node_grill_slat_2_25.position.copy(endpoint_grill_slat_2_25.start);
    node_grill_slat_2_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_grill_slat_2_25.position.set(0.006, 0.0, 0.0);
    node_grill_slat_2_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_grill_slat_2_25.userData.sculptComponent = {"id": "grill-slat-2", "name": "Grill slat 2", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Raised horizontal slat on the grill plate.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "grill", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.003, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.006, "height": 0.012, "depth": 0.168, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.006, 0.0, 0], "rotation": [0, 0, 0], "scale": [0.006, 0.012, 0.168]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill-slat-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(34, 27, 23, 1.0)", "secondaryAlbedo": "rgba(34, 27, 23, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_grill_slat_2_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill-slat-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["grill"] ?? root).add(node_grill_slat_2_25);
  nodes["grill-slat-2"] = node_grill_slat_2_25;
  const mesh_grill_slat_2_25Geometry = endpoint_grill_slat_2_25
    ? new THREE.CylinderGeometry(endpoint_grill_slat_2_25.endRadius, endpoint_grill_slat_2_25.baseRadius, endpoint_grill_slat_2_25.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_grill_slat_2_25) {
    mesh_grill_slat_2_25Geometry.scale(0.006, 0.012, 0.168);
  }
  const mesh_grill_slat_2_25 = new THREE.Mesh(
    mesh_grill_slat_2_25Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grill_slat_2_25.name = "Grill slat 2";
  if (endpoint_grill_slat_2_25) {
    mesh_grill_slat_2_25.position.copy(endpoint_grill_slat_2_25.midpoint);
    mesh_grill_slat_2_25.quaternion.copy(endpoint_grill_slat_2_25.quaternion);
  }
  mesh_grill_slat_2_25.castShadow = options.castShadow ?? true;
  mesh_grill_slat_2_25.receiveShadow = options.receiveShadow ?? true;
  mesh_grill_slat_2_25.userData.sculptComponent = {"id": "grill-slat-2", "name": "Grill slat 2", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Raised horizontal slat on the grill plate.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "grill", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.003, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.006, "height": 0.012, "depth": 0.168, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.006, 0.0, 0], "rotation": [0, 0, 0], "scale": [0.006, 0.012, 0.168]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill-slat-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(34, 27, 23, 1.0)", "secondaryAlbedo": "rgba(34, 27, 23, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_grill_slat_2_25.add(mesh_grill_slat_2_25);
  meshes["grill-slat-2"] = mesh_grill_slat_2_25;
  colliders["grill-slat-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["grill-slat-2"] ??= [];
  destructionGroups["grill-slat-2"].push(node_grill_slat_2_25);

  const endpoint_grill_slat_3_26 = makeAttachmentEndpoint(null);
  const node_grill_slat_3_26 = new THREE.Group();
  node_grill_slat_3_26.name = "Grill slat 3__pivot";
  node_grill_slat_3_26.scale.set(1, 1, 1);
  if (endpoint_grill_slat_3_26) {
    node_grill_slat_3_26.position.copy(endpoint_grill_slat_3_26.start);
    node_grill_slat_3_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_grill_slat_3_26.position.set(0.006, 0.028, 0.0);
    node_grill_slat_3_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_grill_slat_3_26.userData.sculptComponent = {"id": "grill-slat-3", "name": "Grill slat 3", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Raised horizontal slat on the grill plate.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "grill", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.003, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.006, "height": 0.012, "depth": 0.168, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.006, 0.028, 0], "rotation": [0, 0, 0], "scale": [0.006, 0.012, 0.168]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill-slat-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(34, 27, 23, 1.0)", "secondaryAlbedo": "rgba(34, 27, 23, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_grill_slat_3_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill-slat-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["grill"] ?? root).add(node_grill_slat_3_26);
  nodes["grill-slat-3"] = node_grill_slat_3_26;
  const mesh_grill_slat_3_26Geometry = endpoint_grill_slat_3_26
    ? new THREE.CylinderGeometry(endpoint_grill_slat_3_26.endRadius, endpoint_grill_slat_3_26.baseRadius, endpoint_grill_slat_3_26.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_grill_slat_3_26) {
    mesh_grill_slat_3_26Geometry.scale(0.006, 0.012, 0.168);
  }
  const mesh_grill_slat_3_26 = new THREE.Mesh(
    mesh_grill_slat_3_26Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grill_slat_3_26.name = "Grill slat 3";
  if (endpoint_grill_slat_3_26) {
    mesh_grill_slat_3_26.position.copy(endpoint_grill_slat_3_26.midpoint);
    mesh_grill_slat_3_26.quaternion.copy(endpoint_grill_slat_3_26.quaternion);
  }
  mesh_grill_slat_3_26.castShadow = options.castShadow ?? true;
  mesh_grill_slat_3_26.receiveShadow = options.receiveShadow ?? true;
  mesh_grill_slat_3_26.userData.sculptComponent = {"id": "grill-slat-3", "name": "Grill slat 3", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Raised horizontal slat on the grill plate.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "grill", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.003, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.006, "height": 0.012, "depth": 0.168, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.006, 0.028, 0], "rotation": [0, 0, 0], "scale": [0.006, 0.012, 0.168]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grill-slat-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(34, 27, 23, 1.0)", "secondaryAlbedo": "rgba(34, 27, 23, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_grill_slat_3_26.add(mesh_grill_slat_3_26);
  meshes["grill-slat-3"] = mesh_grill_slat_3_26;
  colliders["grill-slat-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.006, 0.012, 0.168], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["grill-slat-3"] ??= [];
  destructionGroups["grill-slat-3"].push(node_grill_slat_3_26);

  const endpoint_headlight_27 = makeAttachmentEndpoint(null);
  const node_headlight_27 = new THREE.Group();
  node_headlight_27.name = "Headlight__pivot";
  node_headlight_27.scale.set(1, 1, 1);
  if (endpoint_headlight_27) {
    node_headlight_27.position.copy(endpoint_headlight_27.start);
    node_headlight_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_headlight_27.position.set(0.4979, 0.191, 0.3612);
    node_headlight_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_headlight_27.userData.sculptComponent = {"id": "headlight", "name": "Headlight", "level": "meso", "role": "lamp", "importance": 0.6, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Small glossy blue lamp on the hood front corner.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.01, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.03, "height": 0.045, "depth": 0.045, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.4979, 0.191, 0.3612], "rotation": [0, 0, 0], "scale": [0.03, 0.045, 0.045]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.045, 0.045], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "headlight", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "headlight-glow"}}, "material": "headlight-glow", "materialLayers": ["headlight-glow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(191, 232, 255, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_headlight_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.045, 0.045], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "headlight", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "headlight-glow"}};
  (nodes["body"] ?? root).add(node_headlight_27);
  nodes["headlight"] = node_headlight_27;
  const mesh_headlight_27Geometry = endpoint_headlight_27
    ? new THREE.CylinderGeometry(endpoint_headlight_27.endRadius, endpoint_headlight_27.baseRadius, endpoint_headlight_27.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_headlight_27) {
    mesh_headlight_27Geometry.scale(0.03, 0.045, 0.045);
  }
  const mesh_headlight_27 = new THREE.Mesh(
    mesh_headlight_27Geometry,
    materialMap["headlight-glow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_headlight_27.name = "Headlight";
  if (endpoint_headlight_27) {
    mesh_headlight_27.position.copy(endpoint_headlight_27.midpoint);
    mesh_headlight_27.quaternion.copy(endpoint_headlight_27.quaternion);
  }
  mesh_headlight_27.castShadow = options.castShadow ?? true;
  mesh_headlight_27.receiveShadow = options.receiveShadow ?? true;
  mesh_headlight_27.userData.sculptComponent = {"id": "headlight", "name": "Headlight", "level": "meso", "role": "lamp", "importance": 0.6, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Small glossy blue lamp on the hood front corner.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "front", "contactType": "embed", "embedDepth": 0.01, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.03, "height": 0.045, "depth": 0.045, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.4979, 0.191, 0.3612], "rotation": [0, 0, 0], "scale": [0.03, 0.045, 0.045]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.045, 0.045], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "headlight", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "headlight-glow"}}, "material": "headlight-glow", "materialLayers": ["headlight-glow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(191, 232, 255, 1.0)", "secondaryAlbedo": "rgba(255, 255, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_headlight_27.add(mesh_headlight_27);
  meshes["headlight"] = mesh_headlight_27;
  colliders["headlight"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.045, 0.045], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["headlight"] ??= [];
  destructionGroups["headlight"].push(node_headlight_27);

  const endpoint_rear_light_28 = makeAttachmentEndpoint(null);
  const node_rear_light_28 = new THREE.Group();
  node_rear_light_28.name = "Rear light__pivot";
  node_rear_light_28.scale.set(1, 1, 1);
  if (endpoint_rear_light_28) {
    node_rear_light_28.position.copy(endpoint_rear_light_28.start);
    node_rear_light_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rear_light_28.position.set(-0.5086, 0.0987, 0.336);
    node_rear_light_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_rear_light_28.userData.sculptComponent = {"id": "rear-light", "name": "Rear light", "level": "micro", "role": "lamp", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small orange box light at the lower rear corner.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "rear", "contactType": "embed", "embedDepth": 0.01, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.024, "height": 0.0644, "depth": 0.05, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.5086, 0.0987, 0.336], "rotation": [0, 0, 0], "scale": [0.024, 0.0644, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.024, 0.0644, 0.05], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rear-light", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}}, "material": "orange-trim", "materialLayers": ["orange-trim"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 140, 46, 1.0)", "secondaryAlbedo": "rgba(255, 140, 46, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_rear_light_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.024, 0.0644, 0.05], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rear-light", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}};
  (nodes["body"] ?? root).add(node_rear_light_28);
  nodes["rear-light"] = node_rear_light_28;
  const mesh_rear_light_28Geometry = endpoint_rear_light_28
    ? new THREE.CylinderGeometry(endpoint_rear_light_28.endRadius, endpoint_rear_light_28.baseRadius, endpoint_rear_light_28.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_rear_light_28) {
    mesh_rear_light_28Geometry.scale(0.024, 0.0644, 0.05);
  }
  const mesh_rear_light_28 = new THREE.Mesh(
    mesh_rear_light_28Geometry,
    materialMap["orange-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_light_28.name = "Rear light";
  if (endpoint_rear_light_28) {
    mesh_rear_light_28.position.copy(endpoint_rear_light_28.midpoint);
    mesh_rear_light_28.quaternion.copy(endpoint_rear_light_28.quaternion);
  }
  mesh_rear_light_28.castShadow = options.castShadow ?? true;
  mesh_rear_light_28.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_light_28.userData.sculptComponent = {"id": "rear-light", "name": "Rear light", "level": "micro", "role": "lamp", "importance": 0.4, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small orange box light at the lower rear corner.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "rear", "contactType": "embed", "embedDepth": 0.01, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.024, "height": 0.0644, "depth": 0.05, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.5086, 0.0987, 0.336], "rotation": [0, 0, 0], "scale": [0.024, 0.0644, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.024, 0.0644, 0.05], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rear-light", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "orange-trim"}}, "material": "orange-trim", "materialLayers": ["orange-trim"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 140, 46, 1.0)", "secondaryAlbedo": "rgba(255, 140, 46, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_rear_light_28.add(mesh_rear_light_28);
  meshes["rear-light"] = mesh_rear_light_28;
  colliders["rear-light"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.024, 0.0644, 0.05], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["rear-light"] ??= [];
  destructionGroups["rear-light"].push(node_rear_light_28);

  const endpoint_eye_a_29 = makeAttachmentEndpoint(null);
  const node_eye_a_29 = new THREE.Group();
  node_eye_a_29.name = "Eye (front)__pivot";
  node_eye_a_29.scale.set(1, 1, 1);
  if (endpoint_eye_a_29) {
    node_eye_a_29.position.copy(endpoint_eye_a_29.start);
    node_eye_a_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_a_29.position.set(0.047, 0.0097, 0.016);
    node_eye_a_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_a_29.userData.sculptComponent = {"id": "eye-a", "name": "Eye (front)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.045, "height": 0.05, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.047, 0.0097, 0.016], "rotation": [0, 0, 0], "scale": [0.045, 0.05, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.045, 0.05, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_a_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.045, 0.05, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["window-cab"] ?? root).add(node_eye_a_29);
  nodes["eye-a"] = node_eye_a_29;
  const mesh_eye_a_29Geometry = endpoint_eye_a_29
    ? new THREE.CylinderGeometry(endpoint_eye_a_29.endRadius, endpoint_eye_a_29.baseRadius, endpoint_eye_a_29.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_a_29) {
    mesh_eye_a_29Geometry.scale(0.045, 0.05, 0.012);
  }
  const mesh_eye_a_29 = new THREE.Mesh(
    mesh_eye_a_29Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_a_29.name = "Eye (front)";
  if (endpoint_eye_a_29) {
    mesh_eye_a_29.position.copy(endpoint_eye_a_29.midpoint);
    mesh_eye_a_29.quaternion.copy(endpoint_eye_a_29.quaternion);
  }
  mesh_eye_a_29.castShadow = options.castShadow ?? true;
  mesh_eye_a_29.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_a_29.userData.sculptComponent = {"id": "eye-a", "name": "Eye (front)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.045, "height": 0.05, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.047, 0.0097, 0.016], "rotation": [0, 0, 0], "scale": [0.045, 0.05, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.045, 0.05, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_a_29.add(mesh_eye_a_29);
  meshes["eye-a"] = mesh_eye_a_29;
  colliders["eye-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.045, 0.05, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["eye-a"] ??= [];
  destructionGroups["eye-a"].push(node_eye_a_29);

  const endpoint_eye_b_30 = makeAttachmentEndpoint(null);
  const node_eye_b_30 = new THREE.Group();
  node_eye_b_30.name = "Eye (rear)__pivot";
  node_eye_b_30.scale.set(1, 1, 1);
  if (endpoint_eye_b_30) {
    node_eye_b_30.position.copy(endpoint_eye_b_30.start);
    node_eye_b_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_b_30.position.set(-0.0517, 0.0097, 0.016);
    node_eye_b_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_b_30.userData.sculptComponent = {"id": "eye-b", "name": "Eye (rear)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.045, "height": 0.05, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0517, 0.0097, 0.016], "rotation": [0, 0, 0], "scale": [0.045, 0.05, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.045, 0.05, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_b_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.045, 0.05, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["window-cab"] ?? root).add(node_eye_b_30);
  nodes["eye-b"] = node_eye_b_30;
  const mesh_eye_b_30Geometry = endpoint_eye_b_30
    ? new THREE.CylinderGeometry(endpoint_eye_b_30.endRadius, endpoint_eye_b_30.baseRadius, endpoint_eye_b_30.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_b_30) {
    mesh_eye_b_30Geometry.scale(0.045, 0.05, 0.012);
  }
  const mesh_eye_b_30 = new THREE.Mesh(
    mesh_eye_b_30Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_b_30.name = "Eye (rear)";
  if (endpoint_eye_b_30) {
    mesh_eye_b_30.position.copy(endpoint_eye_b_30.midpoint);
    mesh_eye_b_30.quaternion.copy(endpoint_eye_b_30.quaternion);
  }
  mesh_eye_b_30.castShadow = options.castShadow ?? true;
  mesh_eye_b_30.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_b_30.userData.sculptComponent = {"id": "eye-b", "name": "Eye (rear)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.045, "height": 0.05, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0517, 0.0097, 0.016], "rotation": [0, 0, 0], "scale": [0.045, 0.05, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.045, 0.05, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_b_30.add(mesh_eye_b_30);
  meshes["eye-b"] = mesh_eye_b_30;
  colliders["eye-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.045, 0.05, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["eye-b"] ??= [];
  destructionGroups["eye-b"].push(node_eye_b_30);

  const endpoint_catchlight_a_31 = makeAttachmentEndpoint(null);
  const node_catchlight_a_31 = new THREE.Group();
  node_catchlight_a_31.name = "Catchlight (front)__pivot";
  node_catchlight_a_31.scale.set(1, 1, 1);
  if (endpoint_catchlight_a_31) {
    node_catchlight_a_31.position.copy(endpoint_catchlight_a_31.start);
    node_catchlight_a_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_catchlight_a_31.position.set(0.0599, 0.0247, 0.016);
    node_catchlight_a_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_catchlight_a_31.userData.sculptComponent = {"id": "catchlight-a", "name": "Catchlight (front)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.016, "height": 0.016, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0599, 0.0247, 0.016], "rotation": [0, 0, 0], "scale": [0.016, 0.016, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_a_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["window-cab"] ?? root).add(node_catchlight_a_31);
  nodes["catchlight-a"] = node_catchlight_a_31;
  const mesh_catchlight_a_31Geometry = endpoint_catchlight_a_31
    ? new THREE.CylinderGeometry(endpoint_catchlight_a_31.endRadius, endpoint_catchlight_a_31.baseRadius, endpoint_catchlight_a_31.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_a_31) {
    mesh_catchlight_a_31Geometry.scale(0.016, 0.016, 0.012);
  }
  const mesh_catchlight_a_31 = new THREE.Mesh(
    mesh_catchlight_a_31Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_a_31.name = "Catchlight (front)";
  if (endpoint_catchlight_a_31) {
    mesh_catchlight_a_31.position.copy(endpoint_catchlight_a_31.midpoint);
    mesh_catchlight_a_31.quaternion.copy(endpoint_catchlight_a_31.quaternion);
  }
  mesh_catchlight_a_31.castShadow = options.castShadow ?? true;
  mesh_catchlight_a_31.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_a_31.userData.sculptComponent = {"id": "catchlight-a", "name": "Catchlight (front)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.016, "height": 0.016, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0599, 0.0247, 0.016], "rotation": [0, 0, 0], "scale": [0.016, 0.016, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_a_31.add(mesh_catchlight_a_31);
  meshes["catchlight-a"] = mesh_catchlight_a_31;
  colliders["catchlight-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-a"] ??= [];
  destructionGroups["catchlight-a"].push(node_catchlight_a_31);

  const endpoint_catchlight_b_32 = makeAttachmentEndpoint(null);
  const node_catchlight_b_32 = new THREE.Group();
  node_catchlight_b_32.name = "Catchlight (rear)__pivot";
  node_catchlight_b_32.scale.set(1, 1, 1);
  if (endpoint_catchlight_b_32) {
    node_catchlight_b_32.position.copy(endpoint_catchlight_b_32.start);
    node_catchlight_b_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_catchlight_b_32.position.set(-0.0388, 0.0247, 0.016);
    node_catchlight_b_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_catchlight_b_32.userData.sculptComponent = {"id": "catchlight-b", "name": "Catchlight (rear)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.016, "height": 0.016, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0388, 0.0247, 0.016], "rotation": [0, 0, 0], "scale": [0.016, 0.016, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_b_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["window-cab"] ?? root).add(node_catchlight_b_32);
  nodes["catchlight-b"] = node_catchlight_b_32;
  const mesh_catchlight_b_32Geometry = endpoint_catchlight_b_32
    ? new THREE.CylinderGeometry(endpoint_catchlight_b_32.endRadius, endpoint_catchlight_b_32.baseRadius, endpoint_catchlight_b_32.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_b_32) {
    mesh_catchlight_b_32Geometry.scale(0.016, 0.016, 0.012);
  }
  const mesh_catchlight_b_32 = new THREE.Mesh(
    mesh_catchlight_b_32Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_b_32.name = "Catchlight (rear)";
  if (endpoint_catchlight_b_32) {
    mesh_catchlight_b_32.position.copy(endpoint_catchlight_b_32.midpoint);
    mesh_catchlight_b_32.quaternion.copy(endpoint_catchlight_b_32.quaternion);
  }
  mesh_catchlight_b_32.castShadow = options.castShadow ?? true;
  mesh_catchlight_b_32.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_b_32.userData.sculptComponent = {"id": "catchlight-b", "name": "Catchlight (rear)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.016, "height": 0.016, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0388, 0.0247, 0.016], "rotation": [0, 0, 0], "scale": [0.016, 0.016, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_b_32.add(mesh_catchlight_b_32);
  meshes["catchlight-b"] = mesh_catchlight_b_32;
  colliders["catchlight-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.016, 0.016, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-b"] ??= [];
  destructionGroups["catchlight-b"].push(node_catchlight_b_32);

  const endpoint_cheek_a_33 = makeAttachmentEndpoint(null);
  const node_cheek_a_33 = new THREE.Group();
  node_cheek_a_33.name = "Cheek (front)__pivot";
  node_cheek_a_33.scale.set(1, 1, 1);
  if (endpoint_cheek_a_33) {
    node_cheek_a_33.position.copy(endpoint_cheek_a_33.start);
    node_cheek_a_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cheek_a_33.position.set(0.0835, -0.044, 0.016);
    node_cheek_a_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_cheek_a_33.userData.sculptComponent = {"id": "cheek-a", "name": "Cheek (front)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.03, "height": 0.02, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0835, -0.044, 0.016], "rotation": [0, 0, 0], "scale": [0.03, 0.02, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.02, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_a_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.02, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}};
  (nodes["window-cab"] ?? root).add(node_cheek_a_33);
  nodes["cheek-a"] = node_cheek_a_33;
  const mesh_cheek_a_33Geometry = endpoint_cheek_a_33
    ? new THREE.CylinderGeometry(endpoint_cheek_a_33.endRadius, endpoint_cheek_a_33.baseRadius, endpoint_cheek_a_33.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_cheek_a_33) {
    mesh_cheek_a_33Geometry.scale(0.03, 0.02, 0.012);
  }
  const mesh_cheek_a_33 = new THREE.Mesh(
    mesh_cheek_a_33Geometry,
    materialMap["cheek-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cheek_a_33.name = "Cheek (front)";
  if (endpoint_cheek_a_33) {
    mesh_cheek_a_33.position.copy(endpoint_cheek_a_33.midpoint);
    mesh_cheek_a_33.quaternion.copy(endpoint_cheek_a_33.quaternion);
  }
  mesh_cheek_a_33.castShadow = options.castShadow ?? true;
  mesh_cheek_a_33.receiveShadow = options.receiveShadow ?? true;
  mesh_cheek_a_33.userData.sculptComponent = {"id": "cheek-a", "name": "Cheek (front)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.03, "height": 0.02, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0835, -0.044, 0.016], "rotation": [0, 0, 0], "scale": [0.03, 0.02, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.02, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_a_33.add(mesh_cheek_a_33);
  meshes["cheek-a"] = mesh_cheek_a_33;
  colliders["cheek-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.02, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["cheek-a"] ??= [];
  destructionGroups["cheek-a"].push(node_cheek_a_33);

  const endpoint_cheek_b_34 = makeAttachmentEndpoint(null);
  const node_cheek_b_34 = new THREE.Group();
  node_cheek_b_34.name = "Cheek (rear)__pivot";
  node_cheek_b_34.scale.set(1, 1, 1);
  if (endpoint_cheek_b_34) {
    node_cheek_b_34.position.copy(endpoint_cheek_b_34.start);
    node_cheek_b_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cheek_b_34.position.set(-0.0817, -0.044, 0.016);
    node_cheek_b_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_cheek_b_34.userData.sculptComponent = {"id": "cheek-b", "name": "Cheek (rear)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.03, "height": 0.02, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0817, -0.044, 0.016], "rotation": [0, 0, 0], "scale": [0.03, 0.02, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.02, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_b_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.02, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}};
  (nodes["window-cab"] ?? root).add(node_cheek_b_34);
  nodes["cheek-b"] = node_cheek_b_34;
  const mesh_cheek_b_34Geometry = endpoint_cheek_b_34
    ? new THREE.CylinderGeometry(endpoint_cheek_b_34.endRadius, endpoint_cheek_b_34.baseRadius, endpoint_cheek_b_34.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_cheek_b_34) {
    mesh_cheek_b_34Geometry.scale(0.03, 0.02, 0.012);
  }
  const mesh_cheek_b_34 = new THREE.Mesh(
    mesh_cheek_b_34Geometry,
    materialMap["cheek-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cheek_b_34.name = "Cheek (rear)";
  if (endpoint_cheek_b_34) {
    mesh_cheek_b_34.position.copy(endpoint_cheek_b_34.midpoint);
    mesh_cheek_b_34.quaternion.copy(endpoint_cheek_b_34.quaternion);
  }
  mesh_cheek_b_34.castShadow = options.castShadow ?? true;
  mesh_cheek_b_34.receiveShadow = options.receiveShadow ?? true;
  mesh_cheek_b_34.userData.sculptComponent = {"id": "cheek-b", "name": "Cheek (rear)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Flat face marking on the cab window.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.03, "height": 0.02, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0817, -0.044, 0.016], "rotation": [0, 0, 0], "scale": [0.03, 0.02, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.02, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_b_34.add(mesh_cheek_b_34);
  meshes["cheek-b"] = mesh_cheek_b_34;
  colliders["cheek-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.03, 0.02, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["cheek-b"] ??= [];
  destructionGroups["cheek-b"].push(node_cheek_b_34);

  const endpoint_smile_35 = makeAttachmentEndpoint(null);
  const node_smile_35 = new THREE.Group();
  node_smile_35.name = "Smile__pivot";
  node_smile_35.scale.set(1, 1, 1);
  if (endpoint_smile_35) {
    node_smile_35.position.copy(endpoint_smile_35.start);
    node_smile_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_smile_35.position.set(0.0, 0.0, 0.017);
    node_smile_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_smile_35.userData.sculptComponent = {"id": "smile", "name": "Smile", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Thin painted smile arc on the cab window, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.0495, -0.0375, 0], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0131, -0.0633, 0], "rx": 0.006, "rz": 0.005, "twist": 0.0}, {"position": [0.0363, -0.0633, 0], "rx": 0.006, "rz": 0.005, "twist": 0.0}, {"position": [0.0749, -0.0375, 0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 6, "capEnds": true}}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.017], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smile", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_smile_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smile", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}};
  (nodes["window-cab"] ?? root).add(node_smile_35);
  nodes["smile"] = node_smile_35;
  const mesh_smile_35Geometry = endpoint_smile_35
    ? new THREE.CylinderGeometry(endpoint_smile_35.endRadius, endpoint_smile_35.baseRadius, endpoint_smile_35.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0495, -0.0375, 0], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0131, -0.0633, 0], "rx": 0.006, "rz": 0.005, "twist": 0.0}, {"position": [0.0363, -0.0633, 0], "rx": 0.006, "rz": 0.005, "twist": 0.0}, {"position": [0.0749, -0.0375, 0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 6, "capEnds": true});
  if (!endpoint_smile_35) {
    mesh_smile_35Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_smile_35 = new THREE.Mesh(
    mesh_smile_35Geometry,
    materialMap["dark-matte"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_smile_35.name = "Smile";
  if (endpoint_smile_35) {
    mesh_smile_35.position.copy(endpoint_smile_35.midpoint);
    mesh_smile_35.quaternion.copy(endpoint_smile_35.quaternion);
  }
  mesh_smile_35.castShadow = options.castShadow ?? true;
  mesh_smile_35.receiveShadow = options.receiveShadow ?? true;
  mesh_smile_35.userData.sculptComponent = {"id": "smile", "name": "Smile", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Thin painted smile arc on the cab window, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.0495, -0.0375, 0], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0131, -0.0633, 0], "rx": 0.006, "rz": 0.005, "twist": 0.0}, {"position": [0.0363, -0.0633, 0], "rx": 0.006, "rz": 0.005, "twist": 0.0}, {"position": [0.0749, -0.0375, 0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 6, "capEnds": true}}, "parent": "window-cab", "attachment": {"parentSocket": "side", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.017], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smile", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark-matte"}}, "material": "dark-matte", "materialLayers": ["dark-matte"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_smile_35.add(mesh_smile_35);
  meshes["smile"] = mesh_smile_35;
  colliders["smile"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["smile"] ??= [];
  destructionGroups["smile"].push(node_smile_35);

  // repetition system: wheels (InstancedMesh, radial, count=4, level=meso)
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
    cluster.name = "wheels";
    parent.add(cluster);
  }

  // repetition system: door-panes (InstancedMesh, radial, count=4, level=meso)
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
    cluster.name = "door-panes";
    parent.add(cluster);
  }

  // repetition system: grill-slats (InstancedMesh, radial, count=3, level=meso)
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
    const cluster = new THREE.InstancedMesh(geo, mat, 3);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 3; i++) {
      const ang = ((0.0) + (i * 360) / 3) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "grill-slats";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createWigglePlayBusLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "WigglePlay Bus look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "directional", "direction": [-0.35, 0.6, 1.0], "intensity": 1.5, "color": "#ffffff", "castShadow": true, "evidence": "the sticker is lit flat from the viewer side; a frontal upper-left key lights the vertical side face fully"}, {"id": "fill", "type": "hemisphere", "skyColor": "#ffffff", "groundColor": "#e6e0d6", "intensity": 1.0, "evidence": "neutral warm-grey ground so the vertical yellow side is neither dimmed nor tinted (the mascot fill uses lavender)"}, {"id": "rim", "type": "directional", "direction": [0.5, 0.4, -1.0], "intensity": 0.5, "color": "#e6d6ff", "evidence": "lighter edge along the top silhouette"}, {"id": "exposure", "type": "renderer", "toneMapping": "Neutral", "exposure": 1.35, "outputColorSpace": "srgb", "evidence": "ACES filmic desaturated the school-bus yellow to (188,171,88); Neutral keeps the hue, and exposure 1.35 brings the side face to the sampled value"}, {"id": "ground", "type": "contact-shadow", "contactShadow": "soft blurred disc under the object, opacity 0.35; ambient occlusion via material AO channel disabled (textureless)", "evidence": "sticker has no cast shadow; a soft contact shadow grounds the 3D prop"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createWigglePlayBusEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameWigglePlayBusCamera(
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
export function createWigglePlayBusPresentationComposer(
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

export function configureWigglePlayBusRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createWigglePlayBusInspectControls(
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

export const GENERATED_STAMP = "gen-1788889921-14654";
