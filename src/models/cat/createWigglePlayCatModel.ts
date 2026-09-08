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

// Generated from ObjectSculptSpec target: WigglePlay cat
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createWigglePlayCatModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "WigglePlay cat";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["hidden"] = createSculptMaterial(
    "hidden",
    {"id": "hidden", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000"]}, "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "roughness": {"base": 1.0, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": ""}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": [], "notes": "invisible carrier", "opacity": {"base": 0.0}, "qualityTier": "utility", "textureless": {"declared": true, "evidence": ["invisible root carrier; never rendered"]}},
    options
  );
  materialMap["cat-orange"] = createSculptMaterial(
    "cat-orange",
    {"id": "cat-orange", "name": "Tabby orange fur", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ffa040", "color": "#ffa040", "albedo": {"dominant": "#ffa040", "secondary": ["#fffbe6", "#f7cca6", "#d8823f"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ffa040", "#fffbe6", "#f7cca6", "#d8823f"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.85, "variation": 0.05}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "muzzle", "region": "lower face", "color": "#fffbe6", "note": "cream muzzle and chin (vertexPaint ellipsoid)"}, {"id": "chin-shade", "region": "under the chin", "color": "#f7cca6", "note": "peach chin/neck band (vertexPaint axis-band)"}, {"id": "belly", "region": "chest and belly", "color": "#fffbe6", "note": "cream belly patch (vertexPaint ellipsoid)"}, {"id": "stripes", "region": "forehead, head sides, shoulders, flanks, tail", "color": "#d8823f", "note": "darker tabby stripes built as stroke components"}, {"id": "outline", "region": "silhouette", "color": "#5a2814", "note": "2D sticker outline; optional runtime inverted hull, not geometry"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["stripe-orange"] = createSculptMaterial(
    "stripe-orange",
    {"id": "stripe-orange", "name": "Tabby stripe", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#d8823f", "color": "#d8823f", "albedo": {"dominant": "#d8823f", "secondary": ["#d8823f"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#d8823f", "#d8823f"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.85, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#d8823f", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["cream-fur"] = createSculptMaterial(
    "cream-fur",
    {"id": "cream-fur", "name": "Cream fur", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#fffbe6", "color": "#fffbe6", "albedo": {"dominant": "#fffbe6", "secondary": ["#f7cca6"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#fffbe6", "#f7cca6"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.85, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#fffbe6", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["peach-fur"] = createSculptMaterial(
    "peach-fur",
    {"id": "peach-fur", "name": "Peach fur (paws, tail tip shade)", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#f7cca6", "color": "#f7cca6", "albedo": {"dominant": "#f7cca6", "secondary": ["#fffbe6"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#f7cca6", "#fffbe6"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.85, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#f7cca6", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["cheek-pink"] = createSculptMaterial(
    "cheek-pink",
    {"id": "cheek-pink", "name": "Cheek blush", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ff8c7c", "color": "#ff8c7c", "albedo": {"dominant": "#ff8c7c", "secondary": ["#ff8c7c"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ff8c7c", "#ff8c7c"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.6, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#ff8c7c", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["ear-pink"] = createSculptMaterial(
    "ear-pink",
    {"id": "ear-pink", "name": "Inner ear", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ff9a86", "color": "#ff9a86", "albedo": {"dominant": "#ff9a86", "secondary": ["#ff8c7c"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ff9a86", "#ff8c7c"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.7, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#ff9a86", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["eye-brown"] = createSculptMaterial(
    "eye-brown",
    {"id": "eye-brown", "name": "Eyes, nose, mouth", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#5a2814", "color": "#5a2814", "albedo": {"dominant": "#5a2814", "secondary": ["#5a2814"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#5a2814", "#5a2814"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#5a2814", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}, "clearcoat": {"base": 0.6}, "clearcoatRoughness": {"base": 0.15}},
    options
  );
  materialMap["tongue-pink"] = createSculptMaterial(
    "tongue-pink",
    {"id": "tongue-pink", "name": "Tongue", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ff7d8e", "color": "#ff7d8e", "albedo": {"dominant": "#ff7d8e", "secondary": ["#ff8c7c"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ff7d8e", "#ff8c7c"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.4, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#ff7d8e", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}},
    options
  );
  materialMap["catchlight"] = createSculptMaterial(
    "catchlight",
    {"id": "catchlight", "name": "Catchlight white", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ffffff", "color": "#ffffff", "albedo": {"dominant": "#ffffff", "secondary": ["#ffffff"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ffffff", "#ffffff"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.35, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#ffffff", "note": "single flat colour region"}], "shaderNotes": ["flat colour sticker material"], "notes": "sticker-derived flat material", "textureless": {"declared": true, "evidence": ["flat airbrushed sticker fill; no grain, print or pores"]}, "emissive": "#ffffff", "emissiveIntensity": {"base": 1.0}},
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
    node_body_1.position.set(0.0, 0.2562, 0.0);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "The sitting body is one plump blob: a dense lathe squashed front-to-back; the cream chest patch and peach lower belly are vertex-painted regions; stripes are separate strokes.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "latheProfile": {"points": [[0.0001, -0.2375], [0.2557, -0.225], [0.2922, -0.2125], [0.2969, -0.1999], [0.2995, -0.1874], [0.3099, -0.1749], [0.326, -0.1624], [0.3406, -0.15], [0.3516, -0.1375], [0.3604, -0.1249], [0.3677, -0.1125], [0.3734, -0.1], [0.3786, -0.0874], [0.3828, -0.075], [0.3849, -0.0624], [0.3859, -0.05], [0.387, -0.0374], [0.3875, -0.025], [0.3875, -0.0125], [0.3875, 0.0], [0.387, 0.0125], [0.3854, 0.025], [0.3828, 0.0376], [0.3797, 0.0501], [0.3766, 0.0625], [0.3729, 0.075], [0.3688, 0.0876], [0.3646, 0.1001], [0.3599, 0.1126], [0.3542, 0.125], [0.3484, 0.1375], [0.3432, 0.15], [0.3375, 0.1626], [0.3313, 0.175], [0.325, 0.1875], [0.3187, 0.2], [0.3125, 0.2126], [0.3063, 0.2251], [0.3016, 0.2375]], "segments": 64}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.775, "height": 0.475, "depth": 0.54, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, 0.2562, 0.0], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 0.6968]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "neck", "localPosition": [0, 0.1425, 0.05]}, {"id": "shoulder-l", "localPosition": [-0.2325, -0.0238, 0.162]}, {"id": "shoulder-r", "localPosition": [0.2325, -0.0238, 0.162]}, {"id": "tail-root", "localPosition": [0.3488, -0.1425, -0.05]}, {"id": "hip-l", "localPosition": [-0.1162, -0.2137, 0.135]}, {"id": "hip-r", "localPosition": [0.1162, -0.2137, 0.135]}, {"id": "skin", "localPosition": [0, 0, 0.27]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.775, 0.475, 0.54], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "belly", "kind": "decal", "note": "cream chest patch and peach lower belly (vertexPaint)"}], "surfaceDetail": {"macroRoughness": 0.85, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "none (flat sticker fur)", "displacementPattern": "none", "occlusionPattern": "under the head and between the legs", "edgeWearPattern": "none", "notes": "smooth lathe, matte"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(255, 251, 230, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#ffa040", "regions": [{"id": "collar-shade", "kind": "axis-band", "axis": "y", "min": 0.1542, "max": 1.0, "softness": 0.02, "color": "#f7cca6"}, {"id": "belly", "kind": "ellipsoid", "center": [0.0, 0.0292, 0.162], "radii": [0.2292, 0.1375, 0.216], "softness": 0.02, "color": "#fffbe6"}, {"id": "belly-low", "kind": "ellipsoid", "center": [0.0, -0.1333, 0.162], "radii": [0.0708, 0.0833, 0.216], "softness": 0.015, "color": "#f7cca6"}]}};
  node_body_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "neck", "localPosition": [0, 0.1425, 0.05]}, {"id": "shoulder-l", "localPosition": [-0.2325, -0.0238, 0.162]}, {"id": "shoulder-r", "localPosition": [0.2325, -0.0238, 0.162]}, {"id": "tail-root", "localPosition": [0.3488, -0.1425, -0.05]}, {"id": "hip-l", "localPosition": [-0.1162, -0.2137, 0.135]}, {"id": "hip-r", "localPosition": [0.1162, -0.2137, 0.135]}, {"id": "skin", "localPosition": [0, 0, 0.27]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.775, 0.475, 0.54], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}};
  (nodes["root"] ?? root).add(node_body_1);
  nodes["body"] = node_body_1;
  const mesh_body_1Geometry = endpoint_body_1
    ? new THREE.CylinderGeometry(endpoint_body_1.endRadius, endpoint_body_1.baseRadius, endpoint_body_1.length, 16, 6)
    : buildLatheGeometry({"points": [[0.0001, -0.2375], [0.2557, -0.225], [0.2922, -0.2125], [0.2969, -0.1999], [0.2995, -0.1874], [0.3099, -0.1749], [0.326, -0.1624], [0.3406, -0.15], [0.3516, -0.1375], [0.3604, -0.1249], [0.3677, -0.1125], [0.3734, -0.1], [0.3786, -0.0874], [0.3828, -0.075], [0.3849, -0.0624], [0.3859, -0.05], [0.387, -0.0374], [0.3875, -0.025], [0.3875, -0.0125], [0.3875, 0.0], [0.387, 0.0125], [0.3854, 0.025], [0.3828, 0.0376], [0.3797, 0.0501], [0.3766, 0.0625], [0.3729, 0.075], [0.3688, 0.0876], [0.3646, 0.1001], [0.3599, 0.1126], [0.3542, 0.125], [0.3484, 0.1375], [0.3432, 0.15], [0.3375, 0.1626], [0.3313, 0.175], [0.325, 0.1875], [0.3187, 0.2], [0.3125, 0.2126], [0.3063, 0.2251], [0.3016, 0.2375]], "segments": 64});
  if (!endpoint_body_1) {
    mesh_body_1Geometry.scale(1.0, 1.0, 0.6968);
  }
  applyVertexPaint(mesh_body_1Geometry, "#ffa040", [{"id": "collar-shade", "kind": "axis-band", "color": "#f7cca6", "softness": 0.02, "axis": "y", "min": 0.1542, "max": 1.0}, {"id": "belly", "kind": "ellipsoid", "color": "#fffbe6", "softness": 0.02, "center": [0.0, 0.0292, 0.162], "radii": [0.2292, 0.1375, 0.216]}, {"id": "belly-low", "kind": "ellipsoid", "color": "#f7cca6", "softness": 0.015, "center": [0.0, -0.1333, 0.162], "radii": [0.0708, 0.0833, 0.216]}]);
  const mesh_body_1 = new THREE.Mesh(
    mesh_body_1Geometry,
    materialMap["cat-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
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
  mesh_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "The sitting body is one plump blob: a dense lathe squashed front-to-back; the cream chest patch and peach lower belly are vertex-painted regions; stripes are separate strokes.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "latheProfile": {"points": [[0.0001, -0.2375], [0.2557, -0.225], [0.2922, -0.2125], [0.2969, -0.1999], [0.2995, -0.1874], [0.3099, -0.1749], [0.326, -0.1624], [0.3406, -0.15], [0.3516, -0.1375], [0.3604, -0.1249], [0.3677, -0.1125], [0.3734, -0.1], [0.3786, -0.0874], [0.3828, -0.075], [0.3849, -0.0624], [0.3859, -0.05], [0.387, -0.0374], [0.3875, -0.025], [0.3875, -0.0125], [0.3875, 0.0], [0.387, 0.0125], [0.3854, 0.025], [0.3828, 0.0376], [0.3797, 0.0501], [0.3766, 0.0625], [0.3729, 0.075], [0.3688, 0.0876], [0.3646, 0.1001], [0.3599, 0.1126], [0.3542, 0.125], [0.3484, 0.1375], [0.3432, 0.15], [0.3375, 0.1626], [0.3313, 0.175], [0.325, 0.1875], [0.3187, 0.2], [0.3125, 0.2126], [0.3063, 0.2251], [0.3016, 0.2375]], "segments": 64}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.775, "height": 0.475, "depth": 0.54, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, 0.2562, 0.0], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 0.6968]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "neck", "localPosition": [0, 0.1425, 0.05]}, {"id": "shoulder-l", "localPosition": [-0.2325, -0.0238, 0.162]}, {"id": "shoulder-r", "localPosition": [0.2325, -0.0238, 0.162]}, {"id": "tail-root", "localPosition": [0.3488, -0.1425, -0.05]}, {"id": "hip-l", "localPosition": [-0.1162, -0.2137, 0.135]}, {"id": "hip-r", "localPosition": [0.1162, -0.2137, 0.135]}, {"id": "skin", "localPosition": [0, 0, 0.27]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.775, 0.475, 0.54], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "belly", "kind": "decal", "note": "cream chest patch and peach lower belly (vertexPaint)"}], "surfaceDetail": {"macroRoughness": 0.85, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "none (flat sticker fur)", "displacementPattern": "none", "occlusionPattern": "under the head and between the legs", "edgeWearPattern": "none", "notes": "smooth lathe, matte"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(255, 251, 230, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#ffa040", "regions": [{"id": "collar-shade", "kind": "axis-band", "axis": "y", "min": 0.1542, "max": 1.0, "softness": 0.02, "color": "#f7cca6"}, {"id": "belly", "kind": "ellipsoid", "center": [0.0, 0.0292, 0.162], "radii": [0.2292, 0.1375, 0.216], "softness": 0.02, "color": "#fffbe6"}, {"id": "belly-low", "kind": "ellipsoid", "center": [0.0, -0.1333, 0.162], "radii": [0.0708, 0.0833, 0.216], "softness": 0.015, "color": "#f7cca6"}]}};
  node_body_1.add(mesh_body_1);
  meshes["body"] = mesh_body_1;
  colliders["body"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.775, 0.475, 0.54], "isTrigger": false, "notes": "ellipsoid proxy"};
  destructionGroups["body"] ??= [];
  destructionGroups["body"].push(node_body_1);
  const socket_body_neck_0 = new THREE.Object3D();
  socket_body_neck_0.name = "neck";
  socket_body_neck_0.position.set(0.0, 0.1425, 0.05);
  socket_body_neck_0.rotation.set(0, 0, 0);
  socket_body_neck_0.userData.socket = {"id": "neck", "localPosition": [0, 0.1425, 0.05]};
  node_body_1.add(socket_body_neck_0);
  sockets["body:neck"] = socket_body_neck_0;
  const socket_body_shoulder_l_1 = new THREE.Object3D();
  socket_body_shoulder_l_1.name = "shoulder-l";
  socket_body_shoulder_l_1.position.set(-0.2325, -0.0238, 0.162);
  socket_body_shoulder_l_1.rotation.set(0, 0, 0);
  socket_body_shoulder_l_1.userData.socket = {"id": "shoulder-l", "localPosition": [-0.2325, -0.0238, 0.162]};
  node_body_1.add(socket_body_shoulder_l_1);
  sockets["body:shoulder-l"] = socket_body_shoulder_l_1;
  const socket_body_shoulder_r_2 = new THREE.Object3D();
  socket_body_shoulder_r_2.name = "shoulder-r";
  socket_body_shoulder_r_2.position.set(0.2325, -0.0238, 0.162);
  socket_body_shoulder_r_2.rotation.set(0, 0, 0);
  socket_body_shoulder_r_2.userData.socket = {"id": "shoulder-r", "localPosition": [0.2325, -0.0238, 0.162]};
  node_body_1.add(socket_body_shoulder_r_2);
  sockets["body:shoulder-r"] = socket_body_shoulder_r_2;
  const socket_body_tail_root_3 = new THREE.Object3D();
  socket_body_tail_root_3.name = "tail-root";
  socket_body_tail_root_3.position.set(0.3488, -0.1425, -0.05);
  socket_body_tail_root_3.rotation.set(0, 0, 0);
  socket_body_tail_root_3.userData.socket = {"id": "tail-root", "localPosition": [0.3488, -0.1425, -0.05]};
  node_body_1.add(socket_body_tail_root_3);
  sockets["body:tail-root"] = socket_body_tail_root_3;
  const socket_body_hip_l_4 = new THREE.Object3D();
  socket_body_hip_l_4.name = "hip-l";
  socket_body_hip_l_4.position.set(-0.1162, -0.2137, 0.135);
  socket_body_hip_l_4.rotation.set(0, 0, 0);
  socket_body_hip_l_4.userData.socket = {"id": "hip-l", "localPosition": [-0.1162, -0.2137, 0.135]};
  node_body_1.add(socket_body_hip_l_4);
  sockets["body:hip-l"] = socket_body_hip_l_4;
  const socket_body_hip_r_5 = new THREE.Object3D();
  socket_body_hip_r_5.name = "hip-r";
  socket_body_hip_r_5.position.set(0.1162, -0.2137, 0.135);
  socket_body_hip_r_5.rotation.set(0, 0, 0);
  socket_body_hip_r_5.userData.socket = {"id": "hip-r", "localPosition": [0.1162, -0.2137, 0.135]};
  node_body_1.add(socket_body_hip_r_5);
  sockets["body:hip-r"] = socket_body_hip_r_5;
  const socket_body_skin_6 = new THREE.Object3D();
  socket_body_skin_6.name = "skin";
  socket_body_skin_6.position.set(0.0, 0.0, 0.27);
  socket_body_skin_6.rotation.set(0, 0, 0);
  socket_body_skin_6.userData.socket = {"id": "skin", "localPosition": [0, 0, 0.27]};
  node_body_1.add(socket_body_skin_6);
  sockets["body:skin"] = socket_body_skin_6;

  const endpoint_head_2 = makeAttachmentEndpoint(null);
  const node_head_2 = new THREE.Group();
  node_head_2.name = "Head__pivot";
  node_head_2.scale.set(1, 1, 1);
  if (endpoint_head_2) {
    node_head_2.position.copy(endpoint_head_2.start);
    node_head_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_2.position.set(0.0, 0.4626, 0.03);
    node_head_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_2.userData.sculptComponent = {"id": "head", "name": "Head", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "The oversized head is a squashed dense lathe sitting on the body; the cream muzzle/chin and peach neck shade are vertex-painted regions; the face marks, ears and stripes are children so the whole head turns as one node.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "latheProfile": {"points": [[0.2995, -0.2251], [0.3016, -0.2126], [0.3094, -0.2], [0.3187, -0.1876], [0.3271, -0.1751], [0.3349, -0.1625], [0.3411, -0.1501], [0.3458, -0.1375], [0.3495, -0.125], [0.3521, -0.1126], [0.3536, -0.1], [0.3542, -0.0876], [0.3542, -0.075], [0.3536, -0.0626], [0.3521, -0.0501], [0.35, -0.0375], [0.3474, -0.0251], [0.3438, -0.0125], [0.3391, 0.0], [0.3339, 0.0124], [0.3286, 0.025], [0.3229, 0.0374], [0.3167, 0.05], [0.3118, 0.0624], [0.3093, 0.0749], [0.307, 0.0875], [0.3031, 0.0999], [0.2977, 0.1124], [0.2905, 0.125], [0.2814, 0.1374], [0.2703, 0.15], [0.2569, 0.1624], [0.2408, 0.1749], [0.2213, 0.1874], [0.1975, 0.1999], [0.1673, 0.2125], [0.0001, 0.2249]], "segments": 64}}, "parent": "body", "attachment": {"parentSocket": "neck", "contactType": "embed", "embedDepth": 0.12, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.7084, "height": 0.45, "depth": 0.54, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, 0.4626, 0.03], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 0.7623]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "center", "localPosition": [0, -0.135, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "crown", "localPosition": [0, 0.225, 0]}, {"id": "face", "localPosition": [0, 0, 0.27]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.7084, 0.45, 0.54], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "muzzle", "kind": "decal", "note": "cream muzzle and chin (vertexPaint)"}, {"id": "chin-shade", "kind": "decal", "note": "peach band under the chin (vertexPaint)"}], "surfaceDetail": {"macroRoughness": 0.85, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "none", "displacementPattern": "none", "occlusionPattern": "under the chin", "edgeWearPattern": "none", "notes": "smooth lathe, matte"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(255, 251, 230, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#ffa040", "regions": [{"id": "muzzle", "kind": "ellipsoid", "center": [0.0, -0.1667, 0.1485], "radii": [0.3208, 0.1333, 0.243], "softness": 0.02, "color": "#fffbe6"}, {"id": "chin-shade", "kind": "axis-band", "axis": "y", "min": -1.0, "max": -0.2, "softness": 0.02, "color": "#f7cca6"}]}};
  node_head_2.userData.actionProfile = {"animationRole": "head", "pivot": {"mode": "center", "localPosition": [0, -0.135, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "crown", "localPosition": [0, 0.225, 0]}, {"id": "face", "localPosition": [0, 0, 0.27]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.7084, 0.45, 0.54], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}};
  (nodes["body"] ?? root).add(node_head_2);
  nodes["head"] = node_head_2;
  const mesh_head_2Geometry = endpoint_head_2
    ? new THREE.CylinderGeometry(endpoint_head_2.endRadius, endpoint_head_2.baseRadius, endpoint_head_2.length, 16, 6)
    : buildLatheGeometry({"points": [[0.2995, -0.2251], [0.3016, -0.2126], [0.3094, -0.2], [0.3187, -0.1876], [0.3271, -0.1751], [0.3349, -0.1625], [0.3411, -0.1501], [0.3458, -0.1375], [0.3495, -0.125], [0.3521, -0.1126], [0.3536, -0.1], [0.3542, -0.0876], [0.3542, -0.075], [0.3536, -0.0626], [0.3521, -0.0501], [0.35, -0.0375], [0.3474, -0.0251], [0.3438, -0.0125], [0.3391, 0.0], [0.3339, 0.0124], [0.3286, 0.025], [0.3229, 0.0374], [0.3167, 0.05], [0.3118, 0.0624], [0.3093, 0.0749], [0.307, 0.0875], [0.3031, 0.0999], [0.2977, 0.1124], [0.2905, 0.125], [0.2814, 0.1374], [0.2703, 0.15], [0.2569, 0.1624], [0.2408, 0.1749], [0.2213, 0.1874], [0.1975, 0.1999], [0.1673, 0.2125], [0.0001, 0.2249]], "segments": 64});
  if (!endpoint_head_2) {
    mesh_head_2Geometry.scale(1.0, 1.0, 0.7623);
  }
  applyVertexPaint(mesh_head_2Geometry, "#ffa040", [{"id": "muzzle", "kind": "ellipsoid", "color": "#fffbe6", "softness": 0.02, "center": [0.0, -0.1667, 0.1485], "radii": [0.3208, 0.1333, 0.243]}, {"id": "chin-shade", "kind": "axis-band", "color": "#f7cca6", "softness": 0.02, "axis": "y", "min": -1.0, "max": -0.2}]);
  const mesh_head_2 = new THREE.Mesh(
    mesh_head_2Geometry,
    materialMap["cat-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_2.name = "Head";
  mesh_head_2.material = mesh_head_2.material.clone();
  mesh_head_2.material.vertexColors = true;
  (mesh_head_2.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_head_2) {
    mesh_head_2.position.copy(endpoint_head_2.midpoint);
    mesh_head_2.quaternion.copy(endpoint_head_2.quaternion);
  }
  mesh_head_2.castShadow = options.castShadow ?? true;
  mesh_head_2.receiveShadow = options.receiveShadow ?? true;
  mesh_head_2.userData.sculptComponent = {"id": "head", "name": "Head", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "The oversized head is a squashed dense lathe sitting on the body; the cream muzzle/chin and peach neck shade are vertex-painted regions; the face marks, ears and stripes are children so the whole head turns as one node.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "latheProfile": {"points": [[0.2995, -0.2251], [0.3016, -0.2126], [0.3094, -0.2], [0.3187, -0.1876], [0.3271, -0.1751], [0.3349, -0.1625], [0.3411, -0.1501], [0.3458, -0.1375], [0.3495, -0.125], [0.3521, -0.1126], [0.3536, -0.1], [0.3542, -0.0876], [0.3542, -0.075], [0.3536, -0.0626], [0.3521, -0.0501], [0.35, -0.0375], [0.3474, -0.0251], [0.3438, -0.0125], [0.3391, 0.0], [0.3339, 0.0124], [0.3286, 0.025], [0.3229, 0.0374], [0.3167, 0.05], [0.3118, 0.0624], [0.3093, 0.0749], [0.307, 0.0875], [0.3031, 0.0999], [0.2977, 0.1124], [0.2905, 0.125], [0.2814, 0.1374], [0.2703, 0.15], [0.2569, 0.1624], [0.2408, 0.1749], [0.2213, 0.1874], [0.1975, 0.1999], [0.1673, 0.2125], [0.0001, 0.2249]], "segments": 64}}, "parent": "body", "attachment": {"parentSocket": "neck", "contactType": "embed", "embedDepth": 0.12, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.7084, "height": 0.45, "depth": 0.54, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, 0.4626, 0.03], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 0.7623]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "center", "localPosition": [0, -0.135, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "crown", "localPosition": [0, 0.225, 0]}, {"id": "face", "localPosition": [0, 0, 0.27]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.7084, 0.45, 0.54], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "muzzle", "kind": "decal", "note": "cream muzzle and chin (vertexPaint)"}, {"id": "chin-shade", "kind": "decal", "note": "peach band under the chin (vertexPaint)"}], "surfaceDetail": {"macroRoughness": 0.85, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "none", "displacementPattern": "none", "occlusionPattern": "under the chin", "edgeWearPattern": "none", "notes": "smooth lathe, matte"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(255, 251, 230, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}, "vertexPaint": {"baseColor": "#ffa040", "regions": [{"id": "muzzle", "kind": "ellipsoid", "center": [0.0, -0.1667, 0.1485], "radii": [0.3208, 0.1333, 0.243], "softness": 0.02, "color": "#fffbe6"}, {"id": "chin-shade", "kind": "axis-band", "axis": "y", "min": -1.0, "max": -0.2, "softness": 0.02, "color": "#f7cca6"}]}};
  node_head_2.add(mesh_head_2);
  meshes["head"] = mesh_head_2;
  colliders["head"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.7084, 0.45, 0.54], "isTrigger": false, "notes": "ellipsoid proxy"};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_2);
  const socket_head_crown_0 = new THREE.Object3D();
  socket_head_crown_0.name = "crown";
  socket_head_crown_0.position.set(0.0, 0.225, 0.0);
  socket_head_crown_0.rotation.set(0, 0, 0);
  socket_head_crown_0.userData.socket = {"id": "crown", "localPosition": [0, 0.225, 0]};
  node_head_2.add(socket_head_crown_0);
  sockets["head:crown"] = socket_head_crown_0;
  const socket_head_face_1 = new THREE.Object3D();
  socket_head_face_1.name = "face";
  socket_head_face_1.position.set(0.0, 0.0, 0.27);
  socket_head_face_1.rotation.set(0, 0, 0);
  socket_head_face_1.userData.socket = {"id": "face", "localPosition": [0, 0, 0.27]};
  node_head_2.add(socket_head_face_1);
  sockets["head:face"] = socket_head_face_1;

  const attachment_ear_r_3 = {"parentSocket": "crown", "localStart": [-0.1898, 0.0832, 0.03], "localEnd": [-0.2617, 0.263, 0.03], "contactType": "socket-joint", "baseRadius": 0.125, "endRadius": 0.006, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_ear_r_3 = makeAttachmentEndpoint(attachment_ear_r_3);
  const node_ear_r_3 = new THREE.Group();
  node_ear_r_3.name = "Ear R__pivot";
  node_ear_r_3.scale.set(1, 1, 1);
  if (endpoint_ear_r_3) {
    node_ear_r_3.position.copy(endpoint_ear_r_3.start);
    node_ear_r_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_r_3.position.set(-0.1898, 0.0832, 0.03);
    node_ear_r_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_r_3.userData.sculptComponent = {"id": "ear-r", "name": "Ear R", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Triangular ear: a cone rooted inside the head dome pointing to the measured tip.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "crown", "localStart": [-0.1898, 0.0832, 0.03], "localEnd": [-0.2617, 0.263, 0.03], "contactType": "socket-joint", "baseRadius": 0.125, "endRadius": 0.006, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.1936, "depth": 0.25, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.1898, 0.0832, 0.03], "rotation": [0, 0, 0], "scale": [0.25, 0.1936, 0.25]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "inner", "localPosition": [0, 0.0871, 0.0688]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.25, 0.1936, 0.25], "isTrigger": false, "notes": "cone proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(255, 154, 134, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ear_r_3.userData.actionProfile = {"animationRole": "ear", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "inner", "localPosition": [0, 0.0871, 0.0688]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.25, 0.1936, 0.25], "isTrigger": false, "notes": "cone proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}};
  (nodes["head"] ?? root).add(node_ear_r_3);
  nodes["ear-r"] = node_ear_r_3;
  const mesh_ear_r_3Geometry = endpoint_ear_r_3
    ? new THREE.CylinderGeometry(endpoint_ear_r_3.endRadius, endpoint_ear_r_3.baseRadius, endpoint_ear_r_3.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_ear_r_3) {
    mesh_ear_r_3Geometry.scale(0.25, 0.1936, 0.25);
  }
  const mesh_ear_r_3 = new THREE.Mesh(
    mesh_ear_r_3Geometry,
    materialMap["cat-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_r_3.name = "Ear R";
  if (endpoint_ear_r_3) {
    mesh_ear_r_3.position.copy(endpoint_ear_r_3.midpoint);
    mesh_ear_r_3.quaternion.copy(endpoint_ear_r_3.quaternion);
  }
  mesh_ear_r_3.castShadow = options.castShadow ?? true;
  mesh_ear_r_3.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_r_3.userData.sculptComponent = {"id": "ear-r", "name": "Ear R", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Triangular ear: a cone rooted inside the head dome pointing to the measured tip.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "crown", "localStart": [-0.1898, 0.0832, 0.03], "localEnd": [-0.2617, 0.263, 0.03], "contactType": "socket-joint", "baseRadius": 0.125, "endRadius": 0.006, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.1936, "depth": 0.25, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.1898, 0.0832, 0.03], "rotation": [0, 0, 0], "scale": [0.25, 0.1936, 0.25]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "inner", "localPosition": [0, 0.0871, 0.0688]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.25, 0.1936, 0.25], "isTrigger": false, "notes": "cone proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(255, 154, 134, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ear_r_3.add(mesh_ear_r_3);
  meshes["ear-r"] = mesh_ear_r_3;
  colliders["ear-r"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.25, 0.1936, 0.25], "isTrigger": false, "notes": "cone proxy"};
  destructionGroups["ear-r"] ??= [];
  destructionGroups["ear-r"].push(node_ear_r_3);
  const socket_ear_r_inner_0 = new THREE.Object3D();
  socket_ear_r_inner_0.name = "inner";
  socket_ear_r_inner_0.position.set(0.0, 0.0871, 0.0688);
  socket_ear_r_inner_0.rotation.set(0, 0, 0);
  socket_ear_r_inner_0.userData.socket = {"id": "inner", "localPosition": [0, 0.0871, 0.0688]};
  node_ear_r_3.add(socket_ear_r_inner_0);
  sockets["ear-r:inner"] = socket_ear_r_inner_0;

  const attachment_ear_l_4 = {"parentSocket": "crown", "localStart": [0.1898, 0.0832, 0.03], "localEnd": [0.2617, 0.263, 0.03], "contactType": "socket-joint", "baseRadius": 0.125, "endRadius": 0.006, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_ear_l_4 = makeAttachmentEndpoint(attachment_ear_l_4);
  const node_ear_l_4 = new THREE.Group();
  node_ear_l_4.name = "Ear L__pivot";
  node_ear_l_4.scale.set(1, 1, 1);
  if (endpoint_ear_l_4) {
    node_ear_l_4.position.copy(endpoint_ear_l_4.start);
    node_ear_l_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_l_4.position.set(0.1898, 0.0832, 0.03);
    node_ear_l_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_l_4.userData.sculptComponent = {"id": "ear-l", "name": "Ear L", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Triangular ear: a cone rooted inside the head dome pointing to the measured tip.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "crown", "localStart": [0.1898, 0.0832, 0.03], "localEnd": [0.2617, 0.263, 0.03], "contactType": "socket-joint", "baseRadius": 0.125, "endRadius": 0.006, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.1936, "depth": 0.25, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1898, 0.0832, 0.03], "rotation": [0, 0, 0], "scale": [0.25, 0.1936, 0.25]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "inner", "localPosition": [0, 0.0871, 0.0688]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.25, 0.1936, 0.25], "isTrigger": false, "notes": "cone proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(255, 154, 134, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ear_l_4.userData.actionProfile = {"animationRole": "ear", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "inner", "localPosition": [0, 0.0871, 0.0688]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.25, 0.1936, 0.25], "isTrigger": false, "notes": "cone proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}};
  (nodes["head"] ?? root).add(node_ear_l_4);
  nodes["ear-l"] = node_ear_l_4;
  const mesh_ear_l_4Geometry = endpoint_ear_l_4
    ? new THREE.CylinderGeometry(endpoint_ear_l_4.endRadius, endpoint_ear_l_4.baseRadius, endpoint_ear_l_4.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_ear_l_4) {
    mesh_ear_l_4Geometry.scale(0.25, 0.1936, 0.25);
  }
  const mesh_ear_l_4 = new THREE.Mesh(
    mesh_ear_l_4Geometry,
    materialMap["cat-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_l_4.name = "Ear L";
  if (endpoint_ear_l_4) {
    mesh_ear_l_4.position.copy(endpoint_ear_l_4.midpoint);
    mesh_ear_l_4.quaternion.copy(endpoint_ear_l_4.quaternion);
  }
  mesh_ear_l_4.castShadow = options.castShadow ?? true;
  mesh_ear_l_4.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_l_4.userData.sculptComponent = {"id": "ear-l", "name": "Ear L", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Triangular ear: a cone rooted inside the head dome pointing to the measured tip.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "crown", "localStart": [0.1898, 0.0832, 0.03], "localEnd": [0.2617, 0.263, 0.03], "contactType": "socket-joint", "baseRadius": 0.125, "endRadius": 0.006, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.1936, "depth": 0.25, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1898, 0.0832, 0.03], "rotation": [0, 0, 0], "scale": [0.25, 0.1936, 0.25]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "inner", "localPosition": [0, 0.0871, 0.0688]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.25, 0.1936, 0.25], "isTrigger": false, "notes": "cone proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(255, 154, 134, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ear_l_4.add(mesh_ear_l_4);
  meshes["ear-l"] = mesh_ear_l_4;
  colliders["ear-l"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.25, 0.1936, 0.25], "isTrigger": false, "notes": "cone proxy"};
  destructionGroups["ear-l"] ??= [];
  destructionGroups["ear-l"].push(node_ear_l_4);
  const socket_ear_l_inner_0 = new THREE.Object3D();
  socket_ear_l_inner_0.name = "inner";
  socket_ear_l_inner_0.position.set(0.0, 0.0871, 0.0688);
  socket_ear_l_inner_0.rotation.set(0, 0, 0);
  socket_ear_l_inner_0.userData.socket = {"id": "inner", "localPosition": [0, 0.0871, 0.0688]};
  node_ear_l_4.add(socket_ear_l_inner_0);
  sockets["ear-l:inner"] = socket_ear_l_inner_0;

  const endpoint_ear_inner_r_5 = makeAttachmentEndpoint(null);
  const node_ear_inner_r_5 = new THREE.Group();
  node_ear_inner_r_5.name = "Inner ear R__pivot";
  node_ear_inner_r_5.scale.set(1, 1, 1);
  if (endpoint_ear_inner_r_5) {
    node_ear_inner_r_5.position.copy(endpoint_ear_inner_r_5.start);
    node_ear_inner_r_5.rotation.set(0.0, 0.0, -0.35);
  } else {
    node_ear_inner_r_5.position.set(0.0, 0.09, 0.075);
    node_ear_inner_r_5.rotation.set(0.0, 0.0, -0.35);
  }
  node_ear_inner_r_5.userData.sculptComponent = {"id": "ear-inner-r", "name": "Inner ear R", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Pink inner-ear patch on the front face of the ear cone.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ear-r", "attachment": {"parentSocket": "inner", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.075, "height": 0.12, "depth": 0.012, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.09, 0.075], "rotation": [0, 0, -0.35], "scale": [0.075, 0.12, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.075, 0.12, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-inner-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ear-pink"}}, "material": "ear-pink", "materialLayers": ["ear-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 154, 134, 1.0)", "secondaryAlbedo": "rgba(255, 140, 124, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ear_inner_r_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.075, 0.12, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-inner-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ear-pink"}};
  (nodes["ear-r"] ?? root).add(node_ear_inner_r_5);
  nodes["ear-inner-r"] = node_ear_inner_r_5;
  const mesh_ear_inner_r_5Geometry = endpoint_ear_inner_r_5
    ? new THREE.CylinderGeometry(endpoint_ear_inner_r_5.endRadius, endpoint_ear_inner_r_5.baseRadius, endpoint_ear_inner_r_5.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_ear_inner_r_5) {
    mesh_ear_inner_r_5Geometry.scale(0.075, 0.12, 0.012);
  }
  const mesh_ear_inner_r_5 = new THREE.Mesh(
    mesh_ear_inner_r_5Geometry,
    materialMap["ear-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_inner_r_5.name = "Inner ear R";
  if (endpoint_ear_inner_r_5) {
    mesh_ear_inner_r_5.position.copy(endpoint_ear_inner_r_5.midpoint);
    mesh_ear_inner_r_5.quaternion.copy(endpoint_ear_inner_r_5.quaternion);
  }
  mesh_ear_inner_r_5.castShadow = options.castShadow ?? true;
  mesh_ear_inner_r_5.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_inner_r_5.userData.sculptComponent = {"id": "ear-inner-r", "name": "Inner ear R", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Pink inner-ear patch on the front face of the ear cone.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ear-r", "attachment": {"parentSocket": "inner", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.075, "height": 0.12, "depth": 0.012, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.09, 0.075], "rotation": [0, 0, -0.35], "scale": [0.075, 0.12, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.075, 0.12, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-inner-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ear-pink"}}, "material": "ear-pink", "materialLayers": ["ear-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 154, 134, 1.0)", "secondaryAlbedo": "rgba(255, 140, 124, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ear_inner_r_5.add(mesh_ear_inner_r_5);
  meshes["ear-inner-r"] = mesh_ear_inner_r_5;
  colliders["ear-inner-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.075, 0.12, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["ear-inner-r"] ??= [];
  destructionGroups["ear-inner-r"].push(node_ear_inner_r_5);

  const endpoint_ear_inner_l_6 = makeAttachmentEndpoint(null);
  const node_ear_inner_l_6 = new THREE.Group();
  node_ear_inner_l_6.name = "Inner ear L__pivot";
  node_ear_inner_l_6.scale.set(1, 1, 1);
  if (endpoint_ear_inner_l_6) {
    node_ear_inner_l_6.position.copy(endpoint_ear_inner_l_6.start);
    node_ear_inner_l_6.rotation.set(0.0, 0.0, 0.35);
  } else {
    node_ear_inner_l_6.position.set(0.0, 0.09, 0.075);
    node_ear_inner_l_6.rotation.set(0.0, 0.0, 0.35);
  }
  node_ear_inner_l_6.userData.sculptComponent = {"id": "ear-inner-l", "name": "Inner ear L", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Pink inner-ear patch on the front face of the ear cone.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ear-l", "attachment": {"parentSocket": "inner", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.075, "height": 0.12, "depth": 0.012, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.09, 0.075], "rotation": [0, 0, 0.35], "scale": [0.075, 0.12, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.075, 0.12, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-inner-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ear-pink"}}, "material": "ear-pink", "materialLayers": ["ear-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 154, 134, 1.0)", "secondaryAlbedo": "rgba(255, 140, 124, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ear_inner_l_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.075, 0.12, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-inner-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ear-pink"}};
  (nodes["ear-l"] ?? root).add(node_ear_inner_l_6);
  nodes["ear-inner-l"] = node_ear_inner_l_6;
  const mesh_ear_inner_l_6Geometry = endpoint_ear_inner_l_6
    ? new THREE.CylinderGeometry(endpoint_ear_inner_l_6.endRadius, endpoint_ear_inner_l_6.baseRadius, endpoint_ear_inner_l_6.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_ear_inner_l_6) {
    mesh_ear_inner_l_6Geometry.scale(0.075, 0.12, 0.012);
  }
  const mesh_ear_inner_l_6 = new THREE.Mesh(
    mesh_ear_inner_l_6Geometry,
    materialMap["ear-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_inner_l_6.name = "Inner ear L";
  if (endpoint_ear_inner_l_6) {
    mesh_ear_inner_l_6.position.copy(endpoint_ear_inner_l_6.midpoint);
    mesh_ear_inner_l_6.quaternion.copy(endpoint_ear_inner_l_6.quaternion);
  }
  mesh_ear_inner_l_6.castShadow = options.castShadow ?? true;
  mesh_ear_inner_l_6.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_inner_l_6.userData.sculptComponent = {"id": "ear-inner-l", "name": "Inner ear L", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Pink inner-ear patch on the front face of the ear cone.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ear-l", "attachment": {"parentSocket": "inner", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.075, "height": 0.12, "depth": 0.012, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.09, 0.075], "rotation": [0, 0, 0.35], "scale": [0.075, 0.12, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.075, 0.12, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-inner-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ear-pink"}}, "material": "ear-pink", "materialLayers": ["ear-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 154, 134, 1.0)", "secondaryAlbedo": "rgba(255, 140, 124, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ear_inner_l_6.add(mesh_ear_inner_l_6);
  meshes["ear-inner-l"] = mesh_ear_inner_l_6;
  colliders["ear-inner-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.075, 0.12, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["ear-inner-l"] ??= [];
  destructionGroups["ear-inner-l"].push(node_ear_inner_l_6);

  const endpoint_eye_r_7 = makeAttachmentEndpoint(null);
  const node_eye_r_7 = new THREE.Group();
  node_eye_r_7.name = "Eye R__pivot";
  node_eye_r_7.scale.set(1, 1, 1);
  if (endpoint_eye_r_7) {
    node_eye_r_7.position.copy(endpoint_eye_r_7.start);
    node_eye_r_7.rotation.set(-0.057, -0.266, 0.0);
  } else {
    node_eye_r_7.position.set(-0.1185, -0.0522, 0.2609);
    node_eye_r_7.rotation.set(-0.057, -0.266, 0.0);
  }
  node_eye_r_7.userData.sculptComponent = {"id": "eye-r", "name": "Eye R", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Eye R: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1202, "height": 0.1136, "depth": 0.05, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.1185, -0.0522, 0.2609], "rotation": [-0.057, -0.266, 0], "scale": [0.1202, 0.1136, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1202, 0.1136, 0.05], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_r_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1202, 0.1136, 0.05], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}};
  (nodes["head"] ?? root).add(node_eye_r_7);
  nodes["eye-r"] = node_eye_r_7;
  const mesh_eye_r_7Geometry = endpoint_eye_r_7
    ? new THREE.CylinderGeometry(endpoint_eye_r_7.endRadius, endpoint_eye_r_7.baseRadius, endpoint_eye_r_7.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_r_7) {
    mesh_eye_r_7Geometry.scale(0.1202, 0.1136, 0.05);
  }
  const mesh_eye_r_7 = new THREE.Mesh(
    mesh_eye_r_7Geometry,
    materialMap["eye-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_r_7.name = "Eye R";
  if (endpoint_eye_r_7) {
    mesh_eye_r_7.position.copy(endpoint_eye_r_7.midpoint);
    mesh_eye_r_7.quaternion.copy(endpoint_eye_r_7.quaternion);
  }
  mesh_eye_r_7.castShadow = options.castShadow ?? true;
  mesh_eye_r_7.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_r_7.userData.sculptComponent = {"id": "eye-r", "name": "Eye R", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Eye R: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1202, "height": 0.1136, "depth": 0.05, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.1185, -0.0522, 0.2609], "rotation": [-0.057, -0.266, 0], "scale": [0.1202, 0.1136, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1202, 0.1136, 0.05], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_r_7.add(mesh_eye_r_7);
  meshes["eye-r"] = mesh_eye_r_7;
  colliders["eye-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.1202, 0.1136, 0.05], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["eye-r"] ??= [];
  destructionGroups["eye-r"].push(node_eye_r_7);

  const endpoint_eye_l_8 = makeAttachmentEndpoint(null);
  const node_eye_l_8 = new THREE.Group();
  node_eye_l_8.name = "Eye L__pivot";
  node_eye_l_8.scale.set(1, 1, 1);
  if (endpoint_eye_l_8) {
    node_eye_l_8.position.copy(endpoint_eye_l_8.start);
    node_eye_l_8.rotation.set(-0.057, 0.266, 0.0);
  } else {
    node_eye_l_8.position.set(0.1185, -0.0522, 0.2609);
    node_eye_l_8.rotation.set(-0.057, 0.266, 0.0);
  }
  node_eye_l_8.userData.sculptComponent = {"id": "eye-l", "name": "Eye L", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Eye L: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1202, "height": 0.1136, "depth": 0.05, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1185, -0.0522, 0.2609], "rotation": [-0.057, 0.266, 0], "scale": [0.1202, 0.1136, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1202, 0.1136, 0.05], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.3, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "none (glossy)", "displacementPattern": "none", "occlusionPattern": "eye rim", "edgeWearPattern": "none", "notes": "glossy disc with catchlights"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_l_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1202, 0.1136, 0.05], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}};
  (nodes["head"] ?? root).add(node_eye_l_8);
  nodes["eye-l"] = node_eye_l_8;
  const mesh_eye_l_8Geometry = endpoint_eye_l_8
    ? new THREE.CylinderGeometry(endpoint_eye_l_8.endRadius, endpoint_eye_l_8.baseRadius, endpoint_eye_l_8.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_l_8) {
    mesh_eye_l_8Geometry.scale(0.1202, 0.1136, 0.05);
  }
  const mesh_eye_l_8 = new THREE.Mesh(
    mesh_eye_l_8Geometry,
    materialMap["eye-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_l_8.name = "Eye L";
  if (endpoint_eye_l_8) {
    mesh_eye_l_8.position.copy(endpoint_eye_l_8.midpoint);
    mesh_eye_l_8.quaternion.copy(endpoint_eye_l_8.quaternion);
  }
  mesh_eye_l_8.castShadow = options.castShadow ?? true;
  mesh_eye_l_8.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_l_8.userData.sculptComponent = {"id": "eye-l", "name": "Eye L", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Eye L: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1202, "height": 0.1136, "depth": 0.05, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1185, -0.0522, 0.2609], "rotation": [-0.057, 0.266, 0], "scale": [0.1202, 0.1136, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1202, 0.1136, 0.05], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.3, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "none (glossy)", "displacementPattern": "none", "occlusionPattern": "eye rim", "edgeWearPattern": "none", "notes": "glossy disc with catchlights"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_eye_l_8.add(mesh_eye_l_8);
  meshes["eye-l"] = mesh_eye_l_8;
  colliders["eye-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.1202, 0.1136, 0.05], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_l_8);

  const endpoint_catchlight_a_9 = makeAttachmentEndpoint(null);
  const node_catchlight_a_9 = new THREE.Group();
  node_catchlight_a_9.name = "Catchlight (L big)__pivot";
  node_catchlight_a_9.scale.set(1, 1, 1);
  if (endpoint_catchlight_a_9) {
    node_catchlight_a_9.position.copy(endpoint_catchlight_a_9.start);
    node_catchlight_a_9.rotation.set(-0.0639, -0.221, 0.0);
  } else {
    node_catchlight_a_9.position.set(-0.0993, -0.045, 0.2908);
    node_catchlight_a_9.rotation.set(-0.0639, -0.221, 0.0);
  }
  node_catchlight_a_9.userData.sculptComponent = {"id": "catchlight-a", "name": "Catchlight (L big)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (L big): flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0276, "height": 0.026, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0993, -0.045, 0.2908], "rotation": [-0.0639, -0.221, 0], "scale": [0.0276, 0.026, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0276, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_a_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0276, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["head"] ?? root).add(node_catchlight_a_9);
  nodes["catchlight-a"] = node_catchlight_a_9;
  const mesh_catchlight_a_9Geometry = endpoint_catchlight_a_9
    ? new THREE.CylinderGeometry(endpoint_catchlight_a_9.endRadius, endpoint_catchlight_a_9.baseRadius, endpoint_catchlight_a_9.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_a_9) {
    mesh_catchlight_a_9Geometry.scale(0.0276, 0.026, 0.012);
  }
  const mesh_catchlight_a_9 = new THREE.Mesh(
    mesh_catchlight_a_9Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_a_9.name = "Catchlight (L big)";
  if (endpoint_catchlight_a_9) {
    mesh_catchlight_a_9.position.copy(endpoint_catchlight_a_9.midpoint);
    mesh_catchlight_a_9.quaternion.copy(endpoint_catchlight_a_9.quaternion);
  }
  mesh_catchlight_a_9.castShadow = options.castShadow ?? true;
  mesh_catchlight_a_9.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_a_9.userData.sculptComponent = {"id": "catchlight-a", "name": "Catchlight (L big)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (L big): flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0276, "height": 0.026, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.0993, -0.045, 0.2908], "rotation": [-0.0639, -0.221, 0], "scale": [0.0276, 0.026, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0276, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_a_9.add(mesh_catchlight_a_9);
  meshes["catchlight-a"] = mesh_catchlight_a_9;
  colliders["catchlight-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0276, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-a"] ??= [];
  destructionGroups["catchlight-a"].push(node_catchlight_a_9);

  const endpoint_catchlight_b_10 = makeAttachmentEndpoint(null);
  const node_catchlight_b_10 = new THREE.Group();
  node_catchlight_b_10.name = "Catchlight (L small)__pivot";
  node_catchlight_b_10.scale.set(1, 1, 1);
  if (endpoint_catchlight_b_10) {
    node_catchlight_b_10.position.copy(endpoint_catchlight_b_10.start);
    node_catchlight_b_10.rotation.set(0.0062, -0.3028, 0.0);
  } else {
    node_catchlight_b_10.position.set(-0.1342, -0.0849, 0.2838);
    node_catchlight_b_10.rotation.set(0.0062, -0.3028, 0.0);
  }
  node_catchlight_b_10.userData.sculptComponent = {"id": "catchlight-b", "name": "Catchlight (L small)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (L small): flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0131, "height": 0.0131, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.1342, -0.0849, 0.2838], "rotation": [0.0062, -0.3028, 0], "scale": [0.0131, 0.0131, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0131, 0.0131, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_b_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0131, 0.0131, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["head"] ?? root).add(node_catchlight_b_10);
  nodes["catchlight-b"] = node_catchlight_b_10;
  const mesh_catchlight_b_10Geometry = endpoint_catchlight_b_10
    ? new THREE.CylinderGeometry(endpoint_catchlight_b_10.endRadius, endpoint_catchlight_b_10.baseRadius, endpoint_catchlight_b_10.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_b_10) {
    mesh_catchlight_b_10Geometry.scale(0.0131, 0.0131, 0.012);
  }
  const mesh_catchlight_b_10 = new THREE.Mesh(
    mesh_catchlight_b_10Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_b_10.name = "Catchlight (L small)";
  if (endpoint_catchlight_b_10) {
    mesh_catchlight_b_10.position.copy(endpoint_catchlight_b_10.midpoint);
    mesh_catchlight_b_10.quaternion.copy(endpoint_catchlight_b_10.quaternion);
  }
  mesh_catchlight_b_10.castShadow = options.castShadow ?? true;
  mesh_catchlight_b_10.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_b_10.userData.sculptComponent = {"id": "catchlight-b", "name": "Catchlight (L small)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (L small): flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0131, "height": 0.0131, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.1342, -0.0849, 0.2838], "rotation": [0.0062, -0.3028, 0], "scale": [0.0131, 0.0131, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0131, 0.0131, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_b_10.add(mesh_catchlight_b_10);
  meshes["catchlight-b"] = mesh_catchlight_b_10;
  colliders["catchlight-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0131, 0.0131, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-b"] ??= [];
  destructionGroups["catchlight-b"].push(node_catchlight_b_10);

  const endpoint_catchlight_c_11 = makeAttachmentEndpoint(null);
  const node_catchlight_c_11 = new THREE.Group();
  node_catchlight_c_11.name = "Catchlight (R big)__pivot";
  node_catchlight_c_11.scale.set(1, 1, 1);
  if (endpoint_catchlight_c_11) {
    node_catchlight_c_11.position.copy(endpoint_catchlight_c_11.start);
    node_catchlight_c_11.rotation.set(-0.0638, 0.2173, 0.0);
  } else {
    node_catchlight_c_11.position.set(0.0976, -0.045, 0.2912);
    node_catchlight_c_11.rotation.set(-0.0638, 0.2173, 0.0);
  }
  node_catchlight_c_11.userData.sculptComponent = {"id": "catchlight-c", "name": "Catchlight (R big)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (R big): flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0276, "height": 0.026, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0976, -0.045, 0.2912], "rotation": [-0.0638, 0.2173, 0], "scale": [0.0276, 0.026, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0276, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-c", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_c_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0276, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-c", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["head"] ?? root).add(node_catchlight_c_11);
  nodes["catchlight-c"] = node_catchlight_c_11;
  const mesh_catchlight_c_11Geometry = endpoint_catchlight_c_11
    ? new THREE.CylinderGeometry(endpoint_catchlight_c_11.endRadius, endpoint_catchlight_c_11.baseRadius, endpoint_catchlight_c_11.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_c_11) {
    mesh_catchlight_c_11Geometry.scale(0.0276, 0.026, 0.012);
  }
  const mesh_catchlight_c_11 = new THREE.Mesh(
    mesh_catchlight_c_11Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_c_11.name = "Catchlight (R big)";
  if (endpoint_catchlight_c_11) {
    mesh_catchlight_c_11.position.copy(endpoint_catchlight_c_11.midpoint);
    mesh_catchlight_c_11.quaternion.copy(endpoint_catchlight_c_11.quaternion);
  }
  mesh_catchlight_c_11.castShadow = options.castShadow ?? true;
  mesh_catchlight_c_11.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_c_11.userData.sculptComponent = {"id": "catchlight-c", "name": "Catchlight (R big)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (R big): flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0276, "height": 0.026, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0976, -0.045, 0.2912], "rotation": [-0.0638, 0.2173, 0], "scale": [0.0276, 0.026, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0276, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-c", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_c_11.add(mesh_catchlight_c_11);
  meshes["catchlight-c"] = mesh_catchlight_c_11;
  colliders["catchlight-c"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0276, 0.026, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-c"] ??= [];
  destructionGroups["catchlight-c"].push(node_catchlight_c_11);

  const endpoint_catchlight_d_12 = makeAttachmentEndpoint(null);
  const node_catchlight_d_12 = new THREE.Group();
  node_catchlight_d_12.name = "Catchlight (R small)__pivot";
  node_catchlight_d_12.scale.set(1, 1, 1);
  if (endpoint_catchlight_d_12) {
    node_catchlight_d_12.position.copy(endpoint_catchlight_d_12.start);
    node_catchlight_d_12.rotation.set(0.0064, 0.2986, 0.0);
  } else {
    node_catchlight_d_12.position.set(0.1326, -0.085, 0.2843);
    node_catchlight_d_12.rotation.set(0.0064, 0.2986, 0.0);
  }
  node_catchlight_d_12.userData.sculptComponent = {"id": "catchlight-d", "name": "Catchlight (R small)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (R small): flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0131, "height": 0.0131, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1326, -0.085, 0.2843], "rotation": [0.0064, 0.2986, 0], "scale": [0.0131, 0.0131, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0131, 0.0131, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-d", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_d_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0131, 0.0131, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-d", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["head"] ?? root).add(node_catchlight_d_12);
  nodes["catchlight-d"] = node_catchlight_d_12;
  const mesh_catchlight_d_12Geometry = endpoint_catchlight_d_12
    ? new THREE.CylinderGeometry(endpoint_catchlight_d_12.endRadius, endpoint_catchlight_d_12.baseRadius, endpoint_catchlight_d_12.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_d_12) {
    mesh_catchlight_d_12Geometry.scale(0.0131, 0.0131, 0.012);
  }
  const mesh_catchlight_d_12 = new THREE.Mesh(
    mesh_catchlight_d_12Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_d_12.name = "Catchlight (R small)";
  if (endpoint_catchlight_d_12) {
    mesh_catchlight_d_12.position.copy(endpoint_catchlight_d_12.midpoint);
    mesh_catchlight_d_12.quaternion.copy(endpoint_catchlight_d_12.quaternion);
  }
  mesh_catchlight_d_12.castShadow = options.castShadow ?? true;
  mesh_catchlight_d_12.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_d_12.userData.sculptComponent = {"id": "catchlight-d", "name": "Catchlight (R small)", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Catchlight (R small): flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0131, "height": 0.0131, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1326, -0.085, 0.2843], "rotation": [0.0064, 0.2986, 0], "scale": [0.0131, 0.0131, 0.012]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0131, 0.0131, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-d", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_catchlight_d_12.add(mesh_catchlight_d_12);
  meshes["catchlight-d"] = mesh_catchlight_d_12;
  colliders["catchlight-d"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0131, 0.0131, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-d"] ??= [];
  destructionGroups["catchlight-d"].push(node_catchlight_d_12);

  const endpoint_nose_13 = makeAttachmentEndpoint(null);
  const node_nose_13 = new THREE.Group();
  node_nose_13.name = "Nose__pivot";
  node_nose_13.scale.set(1, 1, 1);
  if (endpoint_nose_13) {
    node_nose_13.position.copy(endpoint_nose_13.start);
    node_nose_13.rotation.set(0.0332, 0.0, 0.0);
  } else {
    node_nose_13.position.set(0.0, -0.101, 0.2815);
    node_nose_13.rotation.set(0.0332, 0.0, 0.0);
  }
  node_nose_13.userData.sculptComponent = {"id": "nose", "name": "Nose", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Nose: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0427, "height": 0.0295, "depth": 0.03, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, -0.101, 0.2815], "rotation": [0.0332, 0.0, 0], "scale": [0.0427, 0.0295, 0.03]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0427, 0.0295, 0.03], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_nose_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0427, 0.0295, 0.03], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}};
  (nodes["head"] ?? root).add(node_nose_13);
  nodes["nose"] = node_nose_13;
  const mesh_nose_13Geometry = endpoint_nose_13
    ? new THREE.CylinderGeometry(endpoint_nose_13.endRadius, endpoint_nose_13.baseRadius, endpoint_nose_13.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_nose_13) {
    mesh_nose_13Geometry.scale(0.0427, 0.0295, 0.03);
  }
  const mesh_nose_13 = new THREE.Mesh(
    mesh_nose_13Geometry,
    materialMap["eye-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_13.name = "Nose";
  if (endpoint_nose_13) {
    mesh_nose_13.position.copy(endpoint_nose_13.midpoint);
    mesh_nose_13.quaternion.copy(endpoint_nose_13.quaternion);
  }
  mesh_nose_13.castShadow = options.castShadow ?? true;
  mesh_nose_13.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_13.userData.sculptComponent = {"id": "nose", "name": "Nose", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Nose: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0427, "height": 0.0295, "depth": 0.03, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, -0.101, 0.2815], "rotation": [0.0332, 0.0, 0], "scale": [0.0427, 0.0295, 0.03]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0427, 0.0295, 0.03], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_nose_13.add(mesh_nose_13);
  meshes["nose"] = mesh_nose_13;
  colliders["nose"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0427, 0.0295, 0.03], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["nose"] ??= [];
  destructionGroups["nose"].push(node_nose_13);

  const endpoint_mouth_open_14 = makeAttachmentEndpoint(null);
  const node_mouth_open_14 = new THREE.Group();
  node_mouth_open_14.name = "Open mouth__pivot";
  node_mouth_open_14.scale.set(1, 1, 1);
  if (endpoint_mouth_open_14) {
    node_mouth_open_14.position.copy(endpoint_mouth_open_14.start);
    node_mouth_open_14.rotation.set(0.1864, 0.0, 0.0);
  } else {
    node_mouth_open_14.position.set(0.0, -0.1558, 0.2619);
    node_mouth_open_14.rotation.set(0.1864, 0.0, 0.0);
  }
  node_mouth_open_14.userData.sculptComponent = {"id": "mouth-open", "name": "Open mouth", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Open mouth: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0467, "height": 0.0367, "depth": 0.02, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, -0.1558, 0.2619], "rotation": [0.1864, 0.0, 0], "scale": [0.0467, 0.0367, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0467, 0.0367, 0.02], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth-open", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_mouth_open_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0467, 0.0367, 0.02], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth-open", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}};
  (nodes["head"] ?? root).add(node_mouth_open_14);
  nodes["mouth-open"] = node_mouth_open_14;
  const mesh_mouth_open_14Geometry = endpoint_mouth_open_14
    ? new THREE.CylinderGeometry(endpoint_mouth_open_14.endRadius, endpoint_mouth_open_14.baseRadius, endpoint_mouth_open_14.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_mouth_open_14) {
    mesh_mouth_open_14Geometry.scale(0.0467, 0.0367, 0.02);
  }
  const mesh_mouth_open_14 = new THREE.Mesh(
    mesh_mouth_open_14Geometry,
    materialMap["eye-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mouth_open_14.name = "Open mouth";
  if (endpoint_mouth_open_14) {
    mesh_mouth_open_14.position.copy(endpoint_mouth_open_14.midpoint);
    mesh_mouth_open_14.quaternion.copy(endpoint_mouth_open_14.quaternion);
  }
  mesh_mouth_open_14.castShadow = options.castShadow ?? true;
  mesh_mouth_open_14.receiveShadow = options.receiveShadow ?? true;
  mesh_mouth_open_14.userData.sculptComponent = {"id": "mouth-open", "name": "Open mouth", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Open mouth: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0467, "height": 0.0367, "depth": 0.02, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, -0.1558, 0.2619], "rotation": [0.1864, 0.0, 0], "scale": [0.0467, 0.0367, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0467, 0.0367, 0.02], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth-open", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_mouth_open_14.add(mesh_mouth_open_14);
  meshes["mouth-open"] = mesh_mouth_open_14;
  colliders["mouth-open"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0467, 0.0367, 0.02], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["mouth-open"] ??= [];
  destructionGroups["mouth-open"].push(node_mouth_open_14);

  const endpoint_tongue_15 = makeAttachmentEndpoint(null);
  const node_tongue_15 = new THREE.Group();
  node_tongue_15.name = "Tongue__pivot";
  node_tongue_15.scale.set(1, 1, 1);
  if (endpoint_tongue_15) {
    node_tongue_15.position.copy(endpoint_tongue_15.start);
    node_tongue_15.rotation.set(0.2192, 0.0, 0.0);
  } else {
    node_tongue_15.position.set(0.0, -0.166, 0.2656);
    node_tongue_15.rotation.set(0.2192, 0.0, 0.0);
  }
  node_tongue_15.userData.sculptComponent = {"id": "tongue", "name": "Tongue", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Tongue: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0333, "height": 0.02, "depth": 0.02, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, -0.166, 0.2656], "rotation": [0.2192, 0.0, 0], "scale": [0.0333, 0.02, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0333, 0.02, 0.02], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tongue", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tongue-pink"}}, "material": "tongue-pink", "materialLayers": ["tongue-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_tongue_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0333, 0.02, 0.02], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tongue", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tongue-pink"}};
  (nodes["head"] ?? root).add(node_tongue_15);
  nodes["tongue"] = node_tongue_15;
  const mesh_tongue_15Geometry = endpoint_tongue_15
    ? new THREE.CylinderGeometry(endpoint_tongue_15.endRadius, endpoint_tongue_15.baseRadius, endpoint_tongue_15.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_tongue_15) {
    mesh_tongue_15Geometry.scale(0.0333, 0.02, 0.02);
  }
  const mesh_tongue_15 = new THREE.Mesh(
    mesh_tongue_15Geometry,
    materialMap["tongue-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tongue_15.name = "Tongue";
  if (endpoint_tongue_15) {
    mesh_tongue_15.position.copy(endpoint_tongue_15.midpoint);
    mesh_tongue_15.quaternion.copy(endpoint_tongue_15.quaternion);
  }
  mesh_tongue_15.castShadow = options.castShadow ?? true;
  mesh_tongue_15.receiveShadow = options.receiveShadow ?? true;
  mesh_tongue_15.userData.sculptComponent = {"id": "tongue", "name": "Tongue", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Tongue: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0333, "height": 0.02, "depth": 0.02, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, -0.166, 0.2656], "rotation": [0.2192, 0.0, 0], "scale": [0.0333, 0.02, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0333, 0.02, 0.02], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tongue", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tongue-pink"}}, "material": "tongue-pink", "materialLayers": ["tongue-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_tongue_15.add(mesh_tongue_15);
  meshes["tongue"] = mesh_tongue_15;
  colliders["tongue"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0333, 0.02, 0.02], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["tongue"] ??= [];
  destructionGroups["tongue"].push(node_tongue_15);

  const endpoint_cheek_a_16 = makeAttachmentEndpoint(null);
  const node_cheek_a_16 = new THREE.Group();
  node_cheek_a_16.name = "Cheek L__pivot";
  node_cheek_a_16.scale.set(1, 1, 1);
  if (endpoint_cheek_a_16) {
    node_cheek_a_16.position.copy(endpoint_cheek_a_16.start);
    node_cheek_a_16.rotation.set(0.1606, -0.4283, 0.0);
  } else {
    node_cheek_a_16.position.set(-0.1767, -0.1422, 0.229);
    node_cheek_a_16.rotation.set(0.1606, -0.4283, 0.0);
  }
  node_cheek_a_16.userData.sculptComponent = {"id": "cheek-a", "name": "Cheek L", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Cheek L: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0789, "height": 0.048, "depth": 0.016, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.1767, -0.1422, 0.229], "rotation": [0.1606, -0.4283, 0], "scale": [0.0789, 0.048, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0789, 0.048, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_a_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0789, 0.048, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}};
  (nodes["head"] ?? root).add(node_cheek_a_16);
  nodes["cheek-a"] = node_cheek_a_16;
  const mesh_cheek_a_16Geometry = endpoint_cheek_a_16
    ? new THREE.CylinderGeometry(endpoint_cheek_a_16.endRadius, endpoint_cheek_a_16.baseRadius, endpoint_cheek_a_16.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_cheek_a_16) {
    mesh_cheek_a_16Geometry.scale(0.0789, 0.048, 0.016);
  }
  const mesh_cheek_a_16 = new THREE.Mesh(
    mesh_cheek_a_16Geometry,
    materialMap["cheek-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cheek_a_16.name = "Cheek L";
  if (endpoint_cheek_a_16) {
    mesh_cheek_a_16.position.copy(endpoint_cheek_a_16.midpoint);
    mesh_cheek_a_16.quaternion.copy(endpoint_cheek_a_16.quaternion);
  }
  mesh_cheek_a_16.castShadow = options.castShadow ?? true;
  mesh_cheek_a_16.receiveShadow = options.receiveShadow ?? true;
  mesh_cheek_a_16.userData.sculptComponent = {"id": "cheek-a", "name": "Cheek L", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Cheek L: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0789, "height": 0.048, "depth": 0.016, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.1767, -0.1422, 0.229], "rotation": [0.1606, -0.4283, 0], "scale": [0.0789, 0.048, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0789, 0.048, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_a_16.add(mesh_cheek_a_16);
  meshes["cheek-a"] = mesh_cheek_a_16;
  colliders["cheek-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0789, 0.048, 0.016], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["cheek-a"] ??= [];
  destructionGroups["cheek-a"].push(node_cheek_a_16);

  const endpoint_cheek_b_17 = makeAttachmentEndpoint(null);
  const node_cheek_b_17 = new THREE.Group();
  node_cheek_b_17.name = "Cheek R__pivot";
  node_cheek_b_17.scale.set(1, 1, 1);
  if (endpoint_cheek_b_17) {
    node_cheek_b_17.position.copy(endpoint_cheek_b_17.start);
    node_cheek_b_17.rotation.set(0.1606, 0.4283, 0.0);
  } else {
    node_cheek_b_17.position.set(0.1767, -0.1422, 0.229);
    node_cheek_b_17.rotation.set(0.1606, 0.4283, 0.0);
  }
  node_cheek_b_17.userData.sculptComponent = {"id": "cheek-b", "name": "Cheek R", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Cheek R: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0789, "height": 0.048, "depth": 0.016, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1767, -0.1422, 0.229], "rotation": [0.1606, 0.4283, 0], "scale": [0.0789, 0.048, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0789, 0.048, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_b_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0789, 0.048, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}};
  (nodes["head"] ?? root).add(node_cheek_b_17);
  nodes["cheek-b"] = node_cheek_b_17;
  const mesh_cheek_b_17Geometry = endpoint_cheek_b_17
    ? new THREE.CylinderGeometry(endpoint_cheek_b_17.endRadius, endpoint_cheek_b_17.baseRadius, endpoint_cheek_b_17.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_cheek_b_17) {
    mesh_cheek_b_17Geometry.scale(0.0789, 0.048, 0.016);
  }
  const mesh_cheek_b_17 = new THREE.Mesh(
    mesh_cheek_b_17Geometry,
    materialMap["cheek-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cheek_b_17.name = "Cheek R";
  if (endpoint_cheek_b_17) {
    mesh_cheek_b_17.position.copy(endpoint_cheek_b_17.midpoint);
    mesh_cheek_b_17.quaternion.copy(endpoint_cheek_b_17.quaternion);
  }
  mesh_cheek_b_17.castShadow = options.castShadow ?? true;
  mesh_cheek_b_17.receiveShadow = options.receiveShadow ?? true;
  mesh_cheek_b_17.userData.sculptComponent = {"id": "cheek-b", "name": "Cheek R", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Cheek R: flat marking seated on the fur surface.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.006, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0789, "height": 0.048, "depth": 0.016, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1767, -0.1422, 0.229], "rotation": [0.1606, 0.4283, 0], "scale": [0.0789, 0.048, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0789, 0.048, 0.016], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_cheek_b_17.add(mesh_cheek_b_17);
  meshes["cheek-b"] = mesh_cheek_b_17;
  colliders["cheek-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0789, 0.048, 0.016], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["cheek-b"] ??= [];
  destructionGroups["cheek-b"].push(node_cheek_b_17);

  const endpoint_smile_18 = makeAttachmentEndpoint(null);
  const node_smile_18 = new THREE.Group();
  node_smile_18.name = "Smile__pivot";
  node_smile_18.scale.set(1, 1, 1);
  if (endpoint_smile_18) {
    node_smile_18.position.copy(endpoint_smile_18.start);
    node_smile_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_smile_18.position.set(0.0, 0.0, 0.0);
    node_smile_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_smile_18.userData.sculptComponent = {"id": "smile", "name": "Smile", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Smile: w-shaped smile under the nose, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.038, -0.1249, 0.2728], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0215, -0.1397, 0.2705], "rx": 0.0056, "rz": 0.0056, "twist": 0.0}, {"position": [0.0, -0.1283, 0.2737], "rx": 0.0056, "rz": 0.0056, "twist": 0.0}, {"position": [0.0215, -0.1397, 0.2705], "rx": 0.0056, "rz": 0.0056, "twist": 0.0}, {"position": [0.038, -0.1249, 0.2728], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smile", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_smile_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smile", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}};
  (nodes["head"] ?? root).add(node_smile_18);
  nodes["smile"] = node_smile_18;
  const mesh_smile_18Geometry = endpoint_smile_18
    ? new THREE.CylinderGeometry(endpoint_smile_18.endRadius, endpoint_smile_18.baseRadius, endpoint_smile_18.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.038, -0.1249, 0.2728], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0215, -0.1397, 0.2705], "rx": 0.0056, "rz": 0.0056, "twist": 0.0}, {"position": [0.0, -0.1283, 0.2737], "rx": 0.0056, "rz": 0.0056, "twist": 0.0}, {"position": [0.0215, -0.1397, 0.2705], "rx": 0.0056, "rz": 0.0056, "twist": 0.0}, {"position": [0.038, -0.1249, 0.2728], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_smile_18) {
    mesh_smile_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_smile_18 = new THREE.Mesh(
    mesh_smile_18Geometry,
    materialMap["eye-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_smile_18.name = "Smile";
  if (endpoint_smile_18) {
    mesh_smile_18.position.copy(endpoint_smile_18.midpoint);
    mesh_smile_18.quaternion.copy(endpoint_smile_18.quaternion);
  }
  mesh_smile_18.castShadow = options.castShadow ?? true;
  mesh_smile_18.receiveShadow = options.receiveShadow ?? true;
  mesh_smile_18.userData.sculptComponent = {"id": "smile", "name": "Smile", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Smile: w-shaped smile under the nose, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.038, -0.1249, 0.2728], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.0215, -0.1397, 0.2705], "rx": 0.0056, "rz": 0.0056, "twist": 0.0}, {"position": [0.0, -0.1283, 0.2737], "rx": 0.0056, "rz": 0.0056, "twist": 0.0}, {"position": [0.0215, -0.1397, 0.2705], "rx": 0.0056, "rz": 0.0056, "twist": 0.0}, {"position": [0.038, -0.1249, 0.2728], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smile", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_smile_18.add(mesh_smile_18);
  meshes["smile"] = mesh_smile_18;
  colliders["smile"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["smile"] ??= [];
  destructionGroups["smile"].push(node_smile_18);

  const endpoint_brow_r_19 = makeAttachmentEndpoint(null);
  const node_brow_r_19 = new THREE.Group();
  node_brow_r_19.name = "Eyebrow R__pivot";
  node_brow_r_19.scale.set(1, 1, 1);
  if (endpoint_brow_r_19) {
    node_brow_r_19.position.copy(endpoint_brow_r_19.start);
    node_brow_r_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_brow_r_19.position.set(0.0, 0.0, 0.0);
    node_brow_r_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_brow_r_19.userData.sculptComponent = {"id": "brow-r", "name": "Eyebrow R", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Eyebrow R: thin painted stroke, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.1494, 0.0349, 0.2267], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.1269, 0.048, 0.2297], "rx": 0.0049, "rz": 0.0049, "twist": 0.0}, {"position": [-0.1036, 0.0389, 0.2403], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_brow_r_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}};
  (nodes["head"] ?? root).add(node_brow_r_19);
  nodes["brow-r"] = node_brow_r_19;
  const mesh_brow_r_19Geometry = endpoint_brow_r_19
    ? new THREE.CylinderGeometry(endpoint_brow_r_19.endRadius, endpoint_brow_r_19.baseRadius, endpoint_brow_r_19.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.1494, 0.0349, 0.2267], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.1269, 0.048, 0.2297], "rx": 0.0049, "rz": 0.0049, "twist": 0.0}, {"position": [-0.1036, 0.0389, 0.2403], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_brow_r_19) {
    mesh_brow_r_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_brow_r_19 = new THREE.Mesh(
    mesh_brow_r_19Geometry,
    materialMap["eye-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_r_19.name = "Eyebrow R";
  if (endpoint_brow_r_19) {
    mesh_brow_r_19.position.copy(endpoint_brow_r_19.midpoint);
    mesh_brow_r_19.quaternion.copy(endpoint_brow_r_19.quaternion);
  }
  mesh_brow_r_19.castShadow = options.castShadow ?? true;
  mesh_brow_r_19.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_r_19.userData.sculptComponent = {"id": "brow-r", "name": "Eyebrow R", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Eyebrow R: thin painted stroke, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.1494, 0.0349, 0.2267], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.1269, 0.048, 0.2297], "rx": 0.0049, "rz": 0.0049, "twist": 0.0}, {"position": [-0.1036, 0.0389, 0.2403], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_brow_r_19.add(mesh_brow_r_19);
  meshes["brow-r"] = mesh_brow_r_19;
  colliders["brow-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["brow-r"] ??= [];
  destructionGroups["brow-r"].push(node_brow_r_19);

  const endpoint_brow_l_20 = makeAttachmentEndpoint(null);
  const node_brow_l_20 = new THREE.Group();
  node_brow_l_20.name = "Eyebrow L__pivot";
  node_brow_l_20.scale.set(1, 1, 1);
  if (endpoint_brow_l_20) {
    node_brow_l_20.position.copy(endpoint_brow_l_20.start);
    node_brow_l_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_brow_l_20.position.set(0.0, 0.0, 0.0);
    node_brow_l_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_brow_l_20.userData.sculptComponent = {"id": "brow-l", "name": "Eyebrow L", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Eyebrow L: thin painted stroke, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.1036, 0.0389, 0.2403], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.1269, 0.048, 0.2297], "rx": 0.0049, "rz": 0.0049, "twist": 0.0}, {"position": [0.1494, 0.0349, 0.2267], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_brow_l_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}};
  (nodes["head"] ?? root).add(node_brow_l_20);
  nodes["brow-l"] = node_brow_l_20;
  const mesh_brow_l_20Geometry = endpoint_brow_l_20
    ? new THREE.CylinderGeometry(endpoint_brow_l_20.endRadius, endpoint_brow_l_20.baseRadius, endpoint_brow_l_20.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.1036, 0.0389, 0.2403], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.1269, 0.048, 0.2297], "rx": 0.0049, "rz": 0.0049, "twist": 0.0}, {"position": [0.1494, 0.0349, 0.2267], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_brow_l_20) {
    mesh_brow_l_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_brow_l_20 = new THREE.Mesh(
    mesh_brow_l_20Geometry,
    materialMap["eye-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_l_20.name = "Eyebrow L";
  if (endpoint_brow_l_20) {
    mesh_brow_l_20.position.copy(endpoint_brow_l_20.midpoint);
    mesh_brow_l_20.quaternion.copy(endpoint_brow_l_20.quaternion);
  }
  mesh_brow_l_20.castShadow = options.castShadow ?? true;
  mesh_brow_l_20.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_l_20.userData.sculptComponent = {"id": "brow-l", "name": "Eyebrow L", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Eyebrow L: thin painted stroke, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.1036, 0.0389, 0.2403], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [0.1269, 0.048, 0.2297], "rx": 0.0049, "rz": 0.0049, "twist": 0.0}, {"position": [0.1494, 0.0349, 0.2267], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-brown"}}, "material": "eye-brown", "materialLayers": ["eye-brown"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_brow_l_20.add(mesh_brow_l_20);
  meshes["brow-l"] = mesh_brow_l_20;
  colliders["brow-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["brow-l"] ??= [];
  destructionGroups["brow-l"].push(node_brow_l_20);

  const endpoint_stripe_forehead_c_21 = makeAttachmentEndpoint(null);
  const node_stripe_forehead_c_21 = new THREE.Group();
  node_stripe_forehead_c_21.name = "Stripe Forehead C__pivot";
  node_stripe_forehead_c_21.scale.set(1, 1, 1);
  if (endpoint_stripe_forehead_c_21) {
    node_stripe_forehead_c_21.position.copy(endpoint_stripe_forehead_c_21.start);
    node_stripe_forehead_c_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_forehead_c_21.position.set(0.0, 0.0, 0.0);
    node_stripe_forehead_c_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_forehead_c_21.userData.sculptComponent = {"id": "stripe-forehead-c", "name": "Stripe Forehead C", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Forehead C: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.0, 0.1407, 0.2173], "rx": 0.0123, "rz": 0.0123, "twist": 0.0}, {"position": [0.0, 0.086, 0.2422], "rx": 0.0245, "rz": 0.0245, "twist": 0.0}, {"position": [0.0, 0.0287, 0.2571], "rx": 0.0123, "rz": 0.0123, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-forehead-c", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_forehead_c_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-forehead-c", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["head"] ?? root).add(node_stripe_forehead_c_21);
  nodes["stripe-forehead-c"] = node_stripe_forehead_c_21;
  const mesh_stripe_forehead_c_21Geometry = endpoint_stripe_forehead_c_21
    ? new THREE.CylinderGeometry(endpoint_stripe_forehead_c_21.endRadius, endpoint_stripe_forehead_c_21.baseRadius, endpoint_stripe_forehead_c_21.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.1407, 0.2173], "rx": 0.0123, "rz": 0.0123, "twist": 0.0}, {"position": [0.0, 0.086, 0.2422], "rx": 0.0245, "rz": 0.0245, "twist": 0.0}, {"position": [0.0, 0.0287, 0.2571], "rx": 0.0123, "rz": 0.0123, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_forehead_c_21) {
    mesh_stripe_forehead_c_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_forehead_c_21 = new THREE.Mesh(
    mesh_stripe_forehead_c_21Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_forehead_c_21.name = "Stripe Forehead C";
  if (endpoint_stripe_forehead_c_21) {
    mesh_stripe_forehead_c_21.position.copy(endpoint_stripe_forehead_c_21.midpoint);
    mesh_stripe_forehead_c_21.quaternion.copy(endpoint_stripe_forehead_c_21.quaternion);
  }
  mesh_stripe_forehead_c_21.castShadow = options.castShadow ?? true;
  mesh_stripe_forehead_c_21.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_forehead_c_21.userData.sculptComponent = {"id": "stripe-forehead-c", "name": "Stripe Forehead C", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Forehead C: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.0, 0.1407, 0.2173], "rx": 0.0123, "rz": 0.0123, "twist": 0.0}, {"position": [0.0, 0.086, 0.2422], "rx": 0.0245, "rz": 0.0245, "twist": 0.0}, {"position": [0.0, 0.0287, 0.2571], "rx": 0.0123, "rz": 0.0123, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-forehead-c", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_forehead_c_21.add(mesh_stripe_forehead_c_21);
  meshes["stripe-forehead-c"] = mesh_stripe_forehead_c_21;
  colliders["stripe-forehead-c"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-forehead-c"] ??= [];
  destructionGroups["stripe-forehead-c"].push(node_stripe_forehead_c_21);

  const endpoint_stripe_forehead_a_22 = makeAttachmentEndpoint(null);
  const node_stripe_forehead_a_22 = new THREE.Group();
  node_stripe_forehead_a_22.name = "Stripe Forehead A__pivot";
  node_stripe_forehead_a_22.scale.set(1, 1, 1);
  if (endpoint_stripe_forehead_a_22) {
    node_stripe_forehead_a_22.position.copy(endpoint_stripe_forehead_a_22.start);
    node_stripe_forehead_a_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_forehead_a_22.position.set(0.0, 0.0, 0.0);
    node_stripe_forehead_a_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_forehead_a_22.userData.sculptComponent = {"id": "stripe-forehead-a", "name": "Stripe Forehead A", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Forehead A: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.0643, 0.1386, 0.2127], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}, {"position": [-0.0632, 0.0982, 0.2341], "rx": 0.0198, "rz": 0.0198, "twist": 0.0}, {"position": [-0.0629, 0.0626, 0.2407], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-forehead-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_forehead_a_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-forehead-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["head"] ?? root).add(node_stripe_forehead_a_22);
  nodes["stripe-forehead-a"] = node_stripe_forehead_a_22;
  const mesh_stripe_forehead_a_22Geometry = endpoint_stripe_forehead_a_22
    ? new THREE.CylinderGeometry(endpoint_stripe_forehead_a_22.endRadius, endpoint_stripe_forehead_a_22.baseRadius, endpoint_stripe_forehead_a_22.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0643, 0.1386, 0.2127], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}, {"position": [-0.0632, 0.0982, 0.2341], "rx": 0.0198, "rz": 0.0198, "twist": 0.0}, {"position": [-0.0629, 0.0626, 0.2407], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_forehead_a_22) {
    mesh_stripe_forehead_a_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_forehead_a_22 = new THREE.Mesh(
    mesh_stripe_forehead_a_22Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_forehead_a_22.name = "Stripe Forehead A";
  if (endpoint_stripe_forehead_a_22) {
    mesh_stripe_forehead_a_22.position.copy(endpoint_stripe_forehead_a_22.midpoint);
    mesh_stripe_forehead_a_22.quaternion.copy(endpoint_stripe_forehead_a_22.quaternion);
  }
  mesh_stripe_forehead_a_22.castShadow = options.castShadow ?? true;
  mesh_stripe_forehead_a_22.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_forehead_a_22.userData.sculptComponent = {"id": "stripe-forehead-a", "name": "Stripe Forehead A", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Forehead A: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.0643, 0.1386, 0.2127], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}, {"position": [-0.0632, 0.0982, 0.2341], "rx": 0.0198, "rz": 0.0198, "twist": 0.0}, {"position": [-0.0629, 0.0626, 0.2407], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-forehead-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_forehead_a_22.add(mesh_stripe_forehead_a_22);
  meshes["stripe-forehead-a"] = mesh_stripe_forehead_a_22;
  colliders["stripe-forehead-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-forehead-a"] ??= [];
  destructionGroups["stripe-forehead-a"].push(node_stripe_forehead_a_22);

  const endpoint_stripe_forehead_b_23 = makeAttachmentEndpoint(null);
  const node_stripe_forehead_b_23 = new THREE.Group();
  node_stripe_forehead_b_23.name = "Stripe Forehead B__pivot";
  node_stripe_forehead_b_23.scale.set(1, 1, 1);
  if (endpoint_stripe_forehead_b_23) {
    node_stripe_forehead_b_23.position.copy(endpoint_stripe_forehead_b_23.start);
    node_stripe_forehead_b_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_forehead_b_23.position.set(0.0, 0.0, 0.0);
    node_stripe_forehead_b_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_forehead_b_23.userData.sculptComponent = {"id": "stripe-forehead-b", "name": "Stripe Forehead B", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Forehead B: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.0679, 0.1389, 0.2117], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}, {"position": [0.0667, 0.0984, 0.2335], "rx": 0.0198, "rz": 0.0198, "twist": 0.0}, {"position": [0.0663, 0.0627, 0.2401], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-forehead-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_forehead_b_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-forehead-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["head"] ?? root).add(node_stripe_forehead_b_23);
  nodes["stripe-forehead-b"] = node_stripe_forehead_b_23;
  const mesh_stripe_forehead_b_23Geometry = endpoint_stripe_forehead_b_23
    ? new THREE.CylinderGeometry(endpoint_stripe_forehead_b_23.endRadius, endpoint_stripe_forehead_b_23.baseRadius, endpoint_stripe_forehead_b_23.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0679, 0.1389, 0.2117], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}, {"position": [0.0667, 0.0984, 0.2335], "rx": 0.0198, "rz": 0.0198, "twist": 0.0}, {"position": [0.0663, 0.0627, 0.2401], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_forehead_b_23) {
    mesh_stripe_forehead_b_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_forehead_b_23 = new THREE.Mesh(
    mesh_stripe_forehead_b_23Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_forehead_b_23.name = "Stripe Forehead B";
  if (endpoint_stripe_forehead_b_23) {
    mesh_stripe_forehead_b_23.position.copy(endpoint_stripe_forehead_b_23.midpoint);
    mesh_stripe_forehead_b_23.quaternion.copy(endpoint_stripe_forehead_b_23.quaternion);
  }
  mesh_stripe_forehead_b_23.castShadow = options.castShadow ?? true;
  mesh_stripe_forehead_b_23.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_forehead_b_23.userData.sculptComponent = {"id": "stripe-forehead-b", "name": "Stripe Forehead B", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Forehead B: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.0679, 0.1389, 0.2117], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}, {"position": [0.0667, 0.0984, 0.2335], "rx": 0.0198, "rz": 0.0198, "twist": 0.0}, {"position": [0.0663, 0.0627, 0.2401], "rx": 0.0099, "rz": 0.0099, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-forehead-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_forehead_b_23.add(mesh_stripe_forehead_b_23);
  meshes["stripe-forehead-b"] = mesh_stripe_forehead_b_23;
  colliders["stripe-forehead-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-forehead-b"] ??= [];
  destructionGroups["stripe-forehead-b"].push(node_stripe_forehead_b_23);

  const endpoint_stripe_head_a_24 = makeAttachmentEndpoint(null);
  const node_stripe_head_a_24 = new THREE.Group();
  node_stripe_head_a_24.name = "Stripe Head A__pivot";
  node_stripe_head_a_24.scale.set(1, 1, 1);
  if (endpoint_stripe_head_a_24) {
    node_stripe_head_a_24.position.copy(endpoint_stripe_head_a_24.start);
    node_stripe_head_a_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_head_a_24.position.set(0.0, 0.0, 0.0);
    node_stripe_head_a_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_head_a_24.userData.sculptComponent = {"id": "stripe-head-a", "name": "Stripe Head A", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Head A: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.3014, -0.0141, 0.1183], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}, {"position": [-0.2694, -0.0627, 0.1805], "rx": 0.0243, "rz": 0.0243, "twist": 0.0}, {"position": [-0.248, -0.1071, 0.1985], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-head-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_head_a_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-head-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["head"] ?? root).add(node_stripe_head_a_24);
  nodes["stripe-head-a"] = node_stripe_head_a_24;
  const mesh_stripe_head_a_24Geometry = endpoint_stripe_head_a_24
    ? new THREE.CylinderGeometry(endpoint_stripe_head_a_24.endRadius, endpoint_stripe_head_a_24.baseRadius, endpoint_stripe_head_a_24.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.3014, -0.0141, 0.1183], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}, {"position": [-0.2694, -0.0627, 0.1805], "rx": 0.0243, "rz": 0.0243, "twist": 0.0}, {"position": [-0.248, -0.1071, 0.1985], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_head_a_24) {
    mesh_stripe_head_a_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_head_a_24 = new THREE.Mesh(
    mesh_stripe_head_a_24Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_head_a_24.name = "Stripe Head A";
  if (endpoint_stripe_head_a_24) {
    mesh_stripe_head_a_24.position.copy(endpoint_stripe_head_a_24.midpoint);
    mesh_stripe_head_a_24.quaternion.copy(endpoint_stripe_head_a_24.quaternion);
  }
  mesh_stripe_head_a_24.castShadow = options.castShadow ?? true;
  mesh_stripe_head_a_24.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_head_a_24.userData.sculptComponent = {"id": "stripe-head-a", "name": "Stripe Head A", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Head A: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.3014, -0.0141, 0.1183], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}, {"position": [-0.2694, -0.0627, 0.1805], "rx": 0.0243, "rz": 0.0243, "twist": 0.0}, {"position": [-0.248, -0.1071, 0.1985], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-head-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_head_a_24.add(mesh_stripe_head_a_24);
  meshes["stripe-head-a"] = mesh_stripe_head_a_24;
  colliders["stripe-head-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-head-a"] ??= [];
  destructionGroups["stripe-head-a"].push(node_stripe_head_a_24);

  const endpoint_stripe_head_b_25 = makeAttachmentEndpoint(null);
  const node_stripe_head_b_25 = new THREE.Group();
  node_stripe_head_b_25.name = "Stripe Head B__pivot";
  node_stripe_head_b_25.scale.set(1, 1, 1);
  if (endpoint_stripe_head_b_25) {
    node_stripe_head_b_25.position.copy(endpoint_stripe_head_b_25.start);
    node_stripe_head_b_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_head_b_25.position.set(0.0, 0.0, 0.0);
    node_stripe_head_b_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_head_b_25.userData.sculptComponent = {"id": "stripe-head-b", "name": "Stripe Head B", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Head B: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.3014, -0.0141, 0.1183], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}, {"position": [0.2694, -0.0627, 0.1805], "rx": 0.0243, "rz": 0.0243, "twist": 0.0}, {"position": [0.248, -0.1071, 0.1985], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-head-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_head_b_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-head-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["head"] ?? root).add(node_stripe_head_b_25);
  nodes["stripe-head-b"] = node_stripe_head_b_25;
  const mesh_stripe_head_b_25Geometry = endpoint_stripe_head_b_25
    ? new THREE.CylinderGeometry(endpoint_stripe_head_b_25.endRadius, endpoint_stripe_head_b_25.baseRadius, endpoint_stripe_head_b_25.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.3014, -0.0141, 0.1183], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}, {"position": [0.2694, -0.0627, 0.1805], "rx": 0.0243, "rz": 0.0243, "twist": 0.0}, {"position": [0.248, -0.1071, 0.1985], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_head_b_25) {
    mesh_stripe_head_b_25Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_head_b_25 = new THREE.Mesh(
    mesh_stripe_head_b_25Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_head_b_25.name = "Stripe Head B";
  if (endpoint_stripe_head_b_25) {
    mesh_stripe_head_b_25.position.copy(endpoint_stripe_head_b_25.midpoint);
    mesh_stripe_head_b_25.quaternion.copy(endpoint_stripe_head_b_25.quaternion);
  }
  mesh_stripe_head_b_25.castShadow = options.castShadow ?? true;
  mesh_stripe_head_b_25.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_head_b_25.userData.sculptComponent = {"id": "stripe-head-b", "name": "Stripe Head B", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Head B: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.3014, -0.0141, 0.1183], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}, {"position": [0.2694, -0.0627, 0.1805], "rx": 0.0243, "rz": 0.0243, "twist": 0.0}, {"position": [0.248, -0.1071, 0.1985], "rx": 0.0121, "rz": 0.0121, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "head", "attachment": {"parentSocket": "face", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-head-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_head_b_25.add(mesh_stripe_head_b_25);
  meshes["stripe-head-b"] = mesh_stripe_head_b_25;
  colliders["stripe-head-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-head-b"] ??= [];
  destructionGroups["stripe-head-b"].push(node_stripe_head_b_25);

  const endpoint_stripe_shoulder_a_26 = makeAttachmentEndpoint(null);
  const node_stripe_shoulder_a_26 = new THREE.Group();
  node_stripe_shoulder_a_26.name = "Stripe Shoulder A__pivot";
  node_stripe_shoulder_a_26.scale.set(1, 1, 1);
  if (endpoint_stripe_shoulder_a_26) {
    node_stripe_shoulder_a_26.position.copy(endpoint_stripe_shoulder_a_26.start);
    node_stripe_shoulder_a_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_shoulder_a_26.position.set(0.0, 0.0, 0.0);
    node_stripe_shoulder_a_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_shoulder_a_26.userData.sculptComponent = {"id": "stripe-shoulder-a", "name": "Stripe Shoulder A", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Shoulder A: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.3419, 0.1672, 0.008], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}, {"position": [-0.2696, 0.1459, 0.1574], "rx": 0.0256, "rz": 0.0256, "twist": 0.0}, {"position": [-0.2092, 0.1248, 0.2072], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-shoulder-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_shoulder_a_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-shoulder-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["body"] ?? root).add(node_stripe_shoulder_a_26);
  nodes["stripe-shoulder-a"] = node_stripe_shoulder_a_26;
  const mesh_stripe_shoulder_a_26Geometry = endpoint_stripe_shoulder_a_26
    ? new THREE.CylinderGeometry(endpoint_stripe_shoulder_a_26.endRadius, endpoint_stripe_shoulder_a_26.baseRadius, endpoint_stripe_shoulder_a_26.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.3419, 0.1672, 0.008], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}, {"position": [-0.2696, 0.1459, 0.1574], "rx": 0.0256, "rz": 0.0256, "twist": 0.0}, {"position": [-0.2092, 0.1248, 0.2072], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_shoulder_a_26) {
    mesh_stripe_shoulder_a_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_shoulder_a_26 = new THREE.Mesh(
    mesh_stripe_shoulder_a_26Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_shoulder_a_26.name = "Stripe Shoulder A";
  if (endpoint_stripe_shoulder_a_26) {
    mesh_stripe_shoulder_a_26.position.copy(endpoint_stripe_shoulder_a_26.midpoint);
    mesh_stripe_shoulder_a_26.quaternion.copy(endpoint_stripe_shoulder_a_26.quaternion);
  }
  mesh_stripe_shoulder_a_26.castShadow = options.castShadow ?? true;
  mesh_stripe_shoulder_a_26.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_shoulder_a_26.userData.sculptComponent = {"id": "stripe-shoulder-a", "name": "Stripe Shoulder A", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Shoulder A: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.3419, 0.1672, 0.008], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}, {"position": [-0.2696, 0.1459, 0.1574], "rx": 0.0256, "rz": 0.0256, "twist": 0.0}, {"position": [-0.2092, 0.1248, 0.2072], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-shoulder-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_shoulder_a_26.add(mesh_stripe_shoulder_a_26);
  meshes["stripe-shoulder-a"] = mesh_stripe_shoulder_a_26;
  colliders["stripe-shoulder-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-shoulder-a"] ??= [];
  destructionGroups["stripe-shoulder-a"].push(node_stripe_shoulder_a_26);

  const endpoint_stripe_shoulder_b_27 = makeAttachmentEndpoint(null);
  const node_stripe_shoulder_b_27 = new THREE.Group();
  node_stripe_shoulder_b_27.name = "Stripe Shoulder B__pivot";
  node_stripe_shoulder_b_27.scale.set(1, 1, 1);
  if (endpoint_stripe_shoulder_b_27) {
    node_stripe_shoulder_b_27.position.copy(endpoint_stripe_shoulder_b_27.start);
    node_stripe_shoulder_b_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_shoulder_b_27.position.set(0.0, 0.0, 0.0);
    node_stripe_shoulder_b_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_shoulder_b_27.userData.sculptComponent = {"id": "stripe-shoulder-b", "name": "Stripe Shoulder B", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Shoulder B: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.3419, 0.1672, 0.008], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}, {"position": [0.2696, 0.1459, 0.1574], "rx": 0.0256, "rz": 0.0256, "twist": 0.0}, {"position": [0.2092, 0.1248, 0.2072], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-shoulder-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_shoulder_b_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-shoulder-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["body"] ?? root).add(node_stripe_shoulder_b_27);
  nodes["stripe-shoulder-b"] = node_stripe_shoulder_b_27;
  const mesh_stripe_shoulder_b_27Geometry = endpoint_stripe_shoulder_b_27
    ? new THREE.CylinderGeometry(endpoint_stripe_shoulder_b_27.endRadius, endpoint_stripe_shoulder_b_27.baseRadius, endpoint_stripe_shoulder_b_27.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.3419, 0.1672, 0.008], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}, {"position": [0.2696, 0.1459, 0.1574], "rx": 0.0256, "rz": 0.0256, "twist": 0.0}, {"position": [0.2092, 0.1248, 0.2072], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_shoulder_b_27) {
    mesh_stripe_shoulder_b_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_shoulder_b_27 = new THREE.Mesh(
    mesh_stripe_shoulder_b_27Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_shoulder_b_27.name = "Stripe Shoulder B";
  if (endpoint_stripe_shoulder_b_27) {
    mesh_stripe_shoulder_b_27.position.copy(endpoint_stripe_shoulder_b_27.midpoint);
    mesh_stripe_shoulder_b_27.quaternion.copy(endpoint_stripe_shoulder_b_27.quaternion);
  }
  mesh_stripe_shoulder_b_27.castShadow = options.castShadow ?? true;
  mesh_stripe_shoulder_b_27.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_shoulder_b_27.userData.sculptComponent = {"id": "stripe-shoulder-b", "name": "Stripe Shoulder B", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Shoulder B: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.3419, 0.1672, 0.008], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}, {"position": [0.2696, 0.1459, 0.1574], "rx": 0.0256, "rz": 0.0256, "twist": 0.0}, {"position": [0.2092, 0.1248, 0.2072], "rx": 0.0128, "rz": 0.0128, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-shoulder-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_shoulder_b_27.add(mesh_stripe_shoulder_b_27);
  meshes["stripe-shoulder-b"] = mesh_stripe_shoulder_b_27;
  colliders["stripe-shoulder-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-shoulder-b"] ??= [];
  destructionGroups["stripe-shoulder-b"].push(node_stripe_shoulder_b_27);

  const endpoint_stripe_flank_a_28 = makeAttachmentEndpoint(null);
  const node_stripe_flank_a_28 = new THREE.Group();
  node_stripe_flank_a_28.name = "Stripe Flank A__pivot";
  node_stripe_flank_a_28.scale.set(1, 1, 1);
  if (endpoint_stripe_flank_a_28) {
    node_stripe_flank_a_28.position.copy(endpoint_stripe_flank_a_28.start);
    node_stripe_flank_a_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_flank_a_28.position.set(0.0, 0.0, 0.0);
    node_stripe_flank_a_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_flank_a_28.userData.sculptComponent = {"id": "stripe-flank-a", "name": "Stripe Flank A", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Flank A: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.1968, 0.0062, 0.2403], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}, {"position": [-0.1566, -0.008, 0.2549], "rx": 0.0232, "rz": 0.0232, "twist": 0.0}, {"position": [-0.116, -0.0229, 0.2656], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-flank-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_flank_a_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-flank-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["body"] ?? root).add(node_stripe_flank_a_28);
  nodes["stripe-flank-a"] = node_stripe_flank_a_28;
  const mesh_stripe_flank_a_28Geometry = endpoint_stripe_flank_a_28
    ? new THREE.CylinderGeometry(endpoint_stripe_flank_a_28.endRadius, endpoint_stripe_flank_a_28.baseRadius, endpoint_stripe_flank_a_28.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.1968, 0.0062, 0.2403], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}, {"position": [-0.1566, -0.008, 0.2549], "rx": 0.0232, "rz": 0.0232, "twist": 0.0}, {"position": [-0.116, -0.0229, 0.2656], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_flank_a_28) {
    mesh_stripe_flank_a_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_flank_a_28 = new THREE.Mesh(
    mesh_stripe_flank_a_28Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_flank_a_28.name = "Stripe Flank A";
  if (endpoint_stripe_flank_a_28) {
    mesh_stripe_flank_a_28.position.copy(endpoint_stripe_flank_a_28.midpoint);
    mesh_stripe_flank_a_28.quaternion.copy(endpoint_stripe_flank_a_28.quaternion);
  }
  mesh_stripe_flank_a_28.castShadow = options.castShadow ?? true;
  mesh_stripe_flank_a_28.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_flank_a_28.userData.sculptComponent = {"id": "stripe-flank-a", "name": "Stripe Flank A", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Flank A: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.1968, 0.0062, 0.2403], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}, {"position": [-0.1566, -0.008, 0.2549], "rx": 0.0232, "rz": 0.0232, "twist": 0.0}, {"position": [-0.116, -0.0229, 0.2656], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-flank-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_flank_a_28.add(mesh_stripe_flank_a_28);
  meshes["stripe-flank-a"] = mesh_stripe_flank_a_28;
  colliders["stripe-flank-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-flank-a"] ??= [];
  destructionGroups["stripe-flank-a"].push(node_stripe_flank_a_28);

  const endpoint_stripe_flank_b_29 = makeAttachmentEndpoint(null);
  const node_stripe_flank_b_29 = new THREE.Group();
  node_stripe_flank_b_29.name = "Stripe Flank B__pivot";
  node_stripe_flank_b_29.scale.set(1, 1, 1);
  if (endpoint_stripe_flank_b_29) {
    node_stripe_flank_b_29.position.copy(endpoint_stripe_flank_b_29.start);
    node_stripe_flank_b_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_flank_b_29.position.set(0.0, 0.0, 0.0);
    node_stripe_flank_b_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_flank_b_29.userData.sculptComponent = {"id": "stripe-flank-b", "name": "Stripe Flank B", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Flank B: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.208, 0.0053, 0.2355], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}, {"position": [0.1674, -0.0088, 0.2515], "rx": 0.0232, "rz": 0.0232, "twist": 0.0}, {"position": [0.1265, -0.0234, 0.2632], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-flank-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_flank_b_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-flank-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["body"] ?? root).add(node_stripe_flank_b_29);
  nodes["stripe-flank-b"] = node_stripe_flank_b_29;
  const mesh_stripe_flank_b_29Geometry = endpoint_stripe_flank_b_29
    ? new THREE.CylinderGeometry(endpoint_stripe_flank_b_29.endRadius, endpoint_stripe_flank_b_29.baseRadius, endpoint_stripe_flank_b_29.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.208, 0.0053, 0.2355], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}, {"position": [0.1674, -0.0088, 0.2515], "rx": 0.0232, "rz": 0.0232, "twist": 0.0}, {"position": [0.1265, -0.0234, 0.2632], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_flank_b_29) {
    mesh_stripe_flank_b_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_flank_b_29 = new THREE.Mesh(
    mesh_stripe_flank_b_29Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_flank_b_29.name = "Stripe Flank B";
  if (endpoint_stripe_flank_b_29) {
    mesh_stripe_flank_b_29.position.copy(endpoint_stripe_flank_b_29.midpoint);
    mesh_stripe_flank_b_29.quaternion.copy(endpoint_stripe_flank_b_29.quaternion);
  }
  mesh_stripe_flank_b_29.castShadow = options.castShadow ?? true;
  mesh_stripe_flank_b_29.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_flank_b_29.userData.sculptComponent = {"id": "stripe-flank-b", "name": "Stripe Flank B", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Flank B: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.208, 0.0053, 0.2355], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}, {"position": [0.1674, -0.0088, 0.2515], "rx": 0.0232, "rz": 0.0232, "twist": 0.0}, {"position": [0.1265, -0.0234, 0.2632], "rx": 0.0116, "rz": 0.0116, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-flank-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_flank_b_29.add(mesh_stripe_flank_b_29);
  meshes["stripe-flank-b"] = mesh_stripe_flank_b_29;
  colliders["stripe-flank-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-flank-b"] ??= [];
  destructionGroups["stripe-flank-b"].push(node_stripe_flank_b_29);

  const endpoint_stripe_low_a_30 = makeAttachmentEndpoint(null);
  const node_stripe_low_a_30 = new THREE.Group();
  node_stripe_low_a_30.name = "Stripe Low A__pivot";
  node_stripe_low_a_30.scale.set(1, 1, 1);
  if (endpoint_stripe_low_a_30) {
    node_stripe_low_a_30.position.copy(endpoint_stripe_low_a_30.start);
    node_stripe_low_a_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_low_a_30.position.set(0.0, 0.0, 0.0);
    node_stripe_low_a_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_low_a_30.userData.sculptComponent = {"id": "stripe-low-a", "name": "Stripe Low A", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Low A: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.1823, -0.059, 0.2442], "rx": 0.01, "rz": 0.01, "twist": 0.0}, {"position": [-0.15, -0.0776, 0.2523], "rx": 0.0199, "rz": 0.0199, "twist": 0.0}, {"position": [-0.1188, -0.1014, 0.2534], "rx": 0.01, "rz": 0.01, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-low-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_low_a_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-low-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["body"] ?? root).add(node_stripe_low_a_30);
  nodes["stripe-low-a"] = node_stripe_low_a_30;
  const mesh_stripe_low_a_30Geometry = endpoint_stripe_low_a_30
    ? new THREE.CylinderGeometry(endpoint_stripe_low_a_30.endRadius, endpoint_stripe_low_a_30.baseRadius, endpoint_stripe_low_a_30.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.1823, -0.059, 0.2442], "rx": 0.01, "rz": 0.01, "twist": 0.0}, {"position": [-0.15, -0.0776, 0.2523], "rx": 0.0199, "rz": 0.0199, "twist": 0.0}, {"position": [-0.1188, -0.1014, 0.2534], "rx": 0.01, "rz": 0.01, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_low_a_30) {
    mesh_stripe_low_a_30Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_low_a_30 = new THREE.Mesh(
    mesh_stripe_low_a_30Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_low_a_30.name = "Stripe Low A";
  if (endpoint_stripe_low_a_30) {
    mesh_stripe_low_a_30.position.copy(endpoint_stripe_low_a_30.midpoint);
    mesh_stripe_low_a_30.quaternion.copy(endpoint_stripe_low_a_30.quaternion);
  }
  mesh_stripe_low_a_30.castShadow = options.castShadow ?? true;
  mesh_stripe_low_a_30.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_low_a_30.userData.sculptComponent = {"id": "stripe-low-a", "name": "Stripe Low A", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Low A: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.1823, -0.059, 0.2442], "rx": 0.01, "rz": 0.01, "twist": 0.0}, {"position": [-0.15, -0.0776, 0.2523], "rx": 0.0199, "rz": 0.0199, "twist": 0.0}, {"position": [-0.1188, -0.1014, 0.2534], "rx": 0.01, "rz": 0.01, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-low-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_low_a_30.add(mesh_stripe_low_a_30);
  meshes["stripe-low-a"] = mesh_stripe_low_a_30;
  colliders["stripe-low-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-low-a"] ??= [];
  destructionGroups["stripe-low-a"].push(node_stripe_low_a_30);

  const endpoint_stripe_low_b_31 = makeAttachmentEndpoint(null);
  const node_stripe_low_b_31 = new THREE.Group();
  node_stripe_low_b_31.name = "Stripe Low B__pivot";
  node_stripe_low_b_31.scale.set(1, 1, 1);
  if (endpoint_stripe_low_b_31) {
    node_stripe_low_b_31.position.copy(endpoint_stripe_low_b_31.start);
    node_stripe_low_b_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_low_b_31.position.set(0.0, 0.0, 0.0);
    node_stripe_low_b_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_low_b_31.userData.sculptComponent = {"id": "stripe-low-b", "name": "Stripe Low B", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Low B: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.1823, -0.059, 0.2442], "rx": 0.01, "rz": 0.01, "twist": 0.0}, {"position": [0.15, -0.0776, 0.2523], "rx": 0.0199, "rz": 0.0199, "twist": 0.0}, {"position": [0.1188, -0.1014, 0.2534], "rx": 0.01, "rz": 0.01, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-low-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_low_b_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-low-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["body"] ?? root).add(node_stripe_low_b_31);
  nodes["stripe-low-b"] = node_stripe_low_b_31;
  const mesh_stripe_low_b_31Geometry = endpoint_stripe_low_b_31
    ? new THREE.CylinderGeometry(endpoint_stripe_low_b_31.endRadius, endpoint_stripe_low_b_31.baseRadius, endpoint_stripe_low_b_31.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.1823, -0.059, 0.2442], "rx": 0.01, "rz": 0.01, "twist": 0.0}, {"position": [0.15, -0.0776, 0.2523], "rx": 0.0199, "rz": 0.0199, "twist": 0.0}, {"position": [0.1188, -0.1014, 0.2534], "rx": 0.01, "rz": 0.01, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_stripe_low_b_31) {
    mesh_stripe_low_b_31Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stripe_low_b_31 = new THREE.Mesh(
    mesh_stripe_low_b_31Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_low_b_31.name = "Stripe Low B";
  if (endpoint_stripe_low_b_31) {
    mesh_stripe_low_b_31.position.copy(endpoint_stripe_low_b_31.midpoint);
    mesh_stripe_low_b_31.quaternion.copy(endpoint_stripe_low_b_31.quaternion);
  }
  mesh_stripe_low_b_31.castShadow = options.castShadow ?? true;
  mesh_stripe_low_b_31.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_low_b_31.userData.sculptComponent = {"id": "stripe-low-b", "name": "Stripe Low B", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "Stripe Low B: darker tabby stripe on the fur, built as a tapered sweep so it stays crisp.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.1823, -0.059, 0.2442], "rx": 0.01, "rz": 0.01, "twist": 0.0}, {"position": [0.15, -0.0776, 0.2523], "rx": 0.0199, "rz": 0.0199, "twist": 0.0}, {"position": [0.1188, -0.1014, 0.2534], "rx": 0.01, "rz": 0.01, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "skin", "contactType": "embed", "embedDepth": 0.004, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stripe-low-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_stripe_low_b_31.add(mesh_stripe_low_b_31);
  meshes["stripe-low-b"] = mesh_stripe_low_b_31;
  colliders["stripe-low-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["stripe-low-b"] ??= [];
  destructionGroups["stripe-low-b"].push(node_stripe_low_b_31);

  const endpoint_foreleg_r_32 = makeAttachmentEndpoint(null);
  const node_foreleg_r_32 = new THREE.Group();
  node_foreleg_r_32.name = "Front foreleg R__pivot";
  node_foreleg_r_32.scale.set(1, 1, 1);
  if (endpoint_foreleg_r_32) {
    node_foreleg_r_32.position.copy(endpoint_foreleg_r_32.start);
    node_foreleg_r_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foreleg_r_32.position.set(-0.2096, -0.0501, 0.216);
    node_foreleg_r_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_foreleg_r_32.userData.sculptComponent = {"id": "foreleg-r", "name": "Front foreleg R", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Front foreleg: a rounded column in front of the body blob from the shoulder down to the paw.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "shoulder-r", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1563, "height": 0.2131, "depth": 0.1563, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2096, -0.0501, 0.216], "rotation": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [1, 0, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "paw", "localPosition": [0, -0.1066, 0.01]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563], "isTrigger": false, "notes": "foreleg proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foreleg-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(247, 204, 166, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_foreleg_r_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [1, 0, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "paw", "localPosition": [0, -0.1066, 0.01]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563], "isTrigger": false, "notes": "foreleg proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foreleg-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}};
  (nodes["body"] ?? root).add(node_foreleg_r_32);
  nodes["foreleg-r"] = node_foreleg_r_32;
  const mesh_foreleg_r_32Geometry = endpoint_foreleg_r_32
    ? new THREE.CylinderGeometry(endpoint_foreleg_r_32.endRadius, endpoint_foreleg_r_32.baseRadius, endpoint_foreleg_r_32.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_foreleg_r_32) {
    mesh_foreleg_r_32Geometry.scale(0.1563, 0.2131, 0.1563);
  }
  const mesh_foreleg_r_32 = new THREE.Mesh(
    mesh_foreleg_r_32Geometry,
    materialMap["cat-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foreleg_r_32.name = "Front foreleg R";
  if (endpoint_foreleg_r_32) {
    mesh_foreleg_r_32.position.copy(endpoint_foreleg_r_32.midpoint);
    mesh_foreleg_r_32.quaternion.copy(endpoint_foreleg_r_32.quaternion);
  }
  mesh_foreleg_r_32.castShadow = options.castShadow ?? true;
  mesh_foreleg_r_32.receiveShadow = options.receiveShadow ?? true;
  mesh_foreleg_r_32.userData.sculptComponent = {"id": "foreleg-r", "name": "Front foreleg R", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Front foreleg: a rounded column in front of the body blob from the shoulder down to the paw.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "shoulder-r", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1563, "height": 0.2131, "depth": 0.1563, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2096, -0.0501, 0.216], "rotation": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [1, 0, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "paw", "localPosition": [0, -0.1066, 0.01]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563], "isTrigger": false, "notes": "foreleg proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foreleg-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(247, 204, 166, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_foreleg_r_32.add(mesh_foreleg_r_32);
  meshes["foreleg-r"] = mesh_foreleg_r_32;
  colliders["foreleg-r"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563], "isTrigger": false, "notes": "foreleg proxy"};
  destructionGroups["foreleg-r"] ??= [];
  destructionGroups["foreleg-r"].push(node_foreleg_r_32);
  const socket_foreleg_r_paw_0 = new THREE.Object3D();
  socket_foreleg_r_paw_0.name = "paw";
  socket_foreleg_r_paw_0.position.set(0.0, -0.1066, 0.01);
  socket_foreleg_r_paw_0.rotation.set(0, 0, 0);
  socket_foreleg_r_paw_0.userData.socket = {"id": "paw", "localPosition": [0, -0.1066, 0.01]};
  node_foreleg_r_32.add(socket_foreleg_r_paw_0);
  sockets["foreleg-r:paw"] = socket_foreleg_r_paw_0;

  const endpoint_paw_r_33 = makeAttachmentEndpoint(null);
  const node_paw_r_33 = new THREE.Group();
  node_paw_r_33.name = "Front paw R__pivot";
  node_paw_r_33.scale.set(1, 1, 1);
  if (endpoint_paw_r_33) {
    node_paw_r_33.position.copy(endpoint_paw_r_33.start);
    node_paw_r_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_paw_r_33.position.set(0.0, -0.0966, 0.015);
    node_paw_r_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_paw_r_33.userData.sculptComponent = {"id": "paw-r", "name": "Front paw R", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Peach front paw at the foot of the foreleg.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "foreleg-r", "attachment": {"parentSocket": "paw", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0924, "height": 0.0533, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.0966, 0.015], "rotation": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "paw-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "peach-fur"}}, "material": "peach-fur", "materialLayers": ["peach-fur"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(247, 204, 166, 1.0)", "secondaryAlbedo": "rgba(255, 251, 230, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_paw_r_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "paw-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "peach-fur"}};
  (nodes["foreleg-r"] ?? root).add(node_paw_r_33);
  nodes["paw-r"] = node_paw_r_33;
  const mesh_paw_r_33Geometry = endpoint_paw_r_33
    ? new THREE.CylinderGeometry(endpoint_paw_r_33.endRadius, endpoint_paw_r_33.baseRadius, endpoint_paw_r_33.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_paw_r_33) {
    mesh_paw_r_33Geometry.scale(0.0924, 0.0533, 0.1);
  }
  const mesh_paw_r_33 = new THREE.Mesh(
    mesh_paw_r_33Geometry,
    materialMap["peach-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_paw_r_33.name = "Front paw R";
  if (endpoint_paw_r_33) {
    mesh_paw_r_33.position.copy(endpoint_paw_r_33.midpoint);
    mesh_paw_r_33.quaternion.copy(endpoint_paw_r_33.quaternion);
  }
  mesh_paw_r_33.castShadow = options.castShadow ?? true;
  mesh_paw_r_33.receiveShadow = options.receiveShadow ?? true;
  mesh_paw_r_33.userData.sculptComponent = {"id": "paw-r", "name": "Front paw R", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Peach front paw at the foot of the foreleg.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "foreleg-r", "attachment": {"parentSocket": "paw", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0924, "height": 0.0533, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.0966, 0.015], "rotation": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "paw-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "peach-fur"}}, "material": "peach-fur", "materialLayers": ["peach-fur"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(247, 204, 166, 1.0)", "secondaryAlbedo": "rgba(255, 251, 230, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_paw_r_33.add(mesh_paw_r_33);
  meshes["paw-r"] = mesh_paw_r_33;
  colliders["paw-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["paw-r"] ??= [];
  destructionGroups["paw-r"].push(node_paw_r_33);

  const endpoint_foreleg_l_34 = makeAttachmentEndpoint(null);
  const node_foreleg_l_34 = new THREE.Group();
  node_foreleg_l_34.name = "Front foreleg L__pivot";
  node_foreleg_l_34.scale.set(1, 1, 1);
  if (endpoint_foreleg_l_34) {
    node_foreleg_l_34.position.copy(endpoint_foreleg_l_34.start);
    node_foreleg_l_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foreleg_l_34.position.set(0.2096, -0.0501, 0.216);
    node_foreleg_l_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_foreleg_l_34.userData.sculptComponent = {"id": "foreleg-l", "name": "Front foreleg L", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Front foreleg: a rounded column in front of the body blob from the shoulder down to the paw.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "shoulder-l", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1563, "height": 0.2131, "depth": 0.1563, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2096, -0.0501, 0.216], "rotation": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [1, 0, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "paw", "localPosition": [0, -0.1066, 0.01]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563], "isTrigger": false, "notes": "foreleg proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foreleg-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(247, 204, 166, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_foreleg_l_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [1, 0, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "paw", "localPosition": [0, -0.1066, 0.01]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563], "isTrigger": false, "notes": "foreleg proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foreleg-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}};
  (nodes["body"] ?? root).add(node_foreleg_l_34);
  nodes["foreleg-l"] = node_foreleg_l_34;
  const mesh_foreleg_l_34Geometry = endpoint_foreleg_l_34
    ? new THREE.CylinderGeometry(endpoint_foreleg_l_34.endRadius, endpoint_foreleg_l_34.baseRadius, endpoint_foreleg_l_34.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_foreleg_l_34) {
    mesh_foreleg_l_34Geometry.scale(0.1563, 0.2131, 0.1563);
  }
  const mesh_foreleg_l_34 = new THREE.Mesh(
    mesh_foreleg_l_34Geometry,
    materialMap["cat-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foreleg_l_34.name = "Front foreleg L";
  if (endpoint_foreleg_l_34) {
    mesh_foreleg_l_34.position.copy(endpoint_foreleg_l_34.midpoint);
    mesh_foreleg_l_34.quaternion.copy(endpoint_foreleg_l_34.quaternion);
  }
  mesh_foreleg_l_34.castShadow = options.castShadow ?? true;
  mesh_foreleg_l_34.receiveShadow = options.receiveShadow ?? true;
  mesh_foreleg_l_34.userData.sculptComponent = {"id": "foreleg-l", "name": "Front foreleg L", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Front foreleg: a rounded column in front of the body blob from the shoulder down to the paw.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "shoulder-l", "contactType": "embed", "embedDepth": 0.08, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1563, "height": 0.2131, "depth": 0.1563, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2096, -0.0501, 0.216], "rotation": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [1, 0, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "paw", "localPosition": [0, -0.1066, 0.01]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563], "isTrigger": false, "notes": "foreleg proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foreleg-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(247, 204, 166, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_foreleg_l_34.add(mesh_foreleg_l_34);
  meshes["foreleg-l"] = mesh_foreleg_l_34;
  colliders["foreleg-l"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.1563, 0.2131, 0.1563], "isTrigger": false, "notes": "foreleg proxy"};
  destructionGroups["foreleg-l"] ??= [];
  destructionGroups["foreleg-l"].push(node_foreleg_l_34);
  const socket_foreleg_l_paw_0 = new THREE.Object3D();
  socket_foreleg_l_paw_0.name = "paw";
  socket_foreleg_l_paw_0.position.set(0.0, -0.1066, 0.01);
  socket_foreleg_l_paw_0.rotation.set(0, 0, 0);
  socket_foreleg_l_paw_0.userData.socket = {"id": "paw", "localPosition": [0, -0.1066, 0.01]};
  node_foreleg_l_34.add(socket_foreleg_l_paw_0);
  sockets["foreleg-l:paw"] = socket_foreleg_l_paw_0;

  const endpoint_paw_l_35 = makeAttachmentEndpoint(null);
  const node_paw_l_35 = new THREE.Group();
  node_paw_l_35.name = "Front paw L__pivot";
  node_paw_l_35.scale.set(1, 1, 1);
  if (endpoint_paw_l_35) {
    node_paw_l_35.position.copy(endpoint_paw_l_35.start);
    node_paw_l_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_paw_l_35.position.set(0.0, -0.0966, 0.015);
    node_paw_l_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_paw_l_35.userData.sculptComponent = {"id": "paw-l", "name": "Front paw L", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Peach front paw at the foot of the foreleg.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "foreleg-l", "attachment": {"parentSocket": "paw", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0924, "height": 0.0533, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.0966, 0.015], "rotation": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "paw-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "peach-fur"}}, "material": "peach-fur", "materialLayers": ["peach-fur"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(247, 204, 166, 1.0)", "secondaryAlbedo": "rgba(255, 251, 230, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_paw_l_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "paw-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "peach-fur"}};
  (nodes["foreleg-l"] ?? root).add(node_paw_l_35);
  nodes["paw-l"] = node_paw_l_35;
  const mesh_paw_l_35Geometry = endpoint_paw_l_35
    ? new THREE.CylinderGeometry(endpoint_paw_l_35.endRadius, endpoint_paw_l_35.baseRadius, endpoint_paw_l_35.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_paw_l_35) {
    mesh_paw_l_35Geometry.scale(0.0924, 0.0533, 0.1);
  }
  const mesh_paw_l_35 = new THREE.Mesh(
    mesh_paw_l_35Geometry,
    materialMap["peach-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_paw_l_35.name = "Front paw L";
  if (endpoint_paw_l_35) {
    mesh_paw_l_35.position.copy(endpoint_paw_l_35.midpoint);
    mesh_paw_l_35.quaternion.copy(endpoint_paw_l_35.quaternion);
  }
  mesh_paw_l_35.castShadow = options.castShadow ?? true;
  mesh_paw_l_35.receiveShadow = options.receiveShadow ?? true;
  mesh_paw_l_35.userData.sculptComponent = {"id": "paw-l", "name": "Front paw L", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Peach front paw at the foot of the foreleg.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "foreleg-l", "attachment": {"parentSocket": "paw", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0924, "height": 0.0533, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.0966, 0.015], "rotation": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "paw-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "peach-fur"}}, "material": "peach-fur", "materialLayers": ["peach-fur"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(247, 204, 166, 1.0)", "secondaryAlbedo": "rgba(255, 251, 230, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_paw_l_35.add(mesh_paw_l_35);
  meshes["paw-l"] = mesh_paw_l_35;
  colliders["paw-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0924, 0.0533, 0.1], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["paw-l"] ??= [];
  destructionGroups["paw-l"].push(node_paw_l_35);

  const endpoint_hind_paw_r_36 = makeAttachmentEndpoint(null);
  const node_hind_paw_r_36 = new THREE.Group();
  node_hind_paw_r_36.name = "Hind Paw R__pivot";
  node_hind_paw_r_36.scale.set(1, 1, 1);
  if (endpoint_hind_paw_r_36) {
    node_hind_paw_r_36.position.copy(endpoint_hind_paw_r_36.start);
    node_hind_paw_r_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hind_paw_r_36.position.set(-0.1097, -0.1661, 0.135);
    node_hind_paw_r_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_hind_paw_r_36.userData.sculptComponent = {"id": "hind-paw-r", "name": "Hind Paw R", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Cream hind paw peeking out under the belly.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "hip-r", "contactType": "embed", "embedDepth": 0.03, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1059, "height": 0.0605, "depth": 0.12, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.1097, -0.1661, 0.135], "rotation": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hind-paw-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cream-fur"}}, "material": "cream-fur", "materialLayers": ["cream-fur"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 251, 230, 1.0)", "secondaryAlbedo": "rgba(247, 204, 166, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hind_paw_r_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hind-paw-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cream-fur"}};
  (nodes["body"] ?? root).add(node_hind_paw_r_36);
  nodes["hind-paw-r"] = node_hind_paw_r_36;
  const mesh_hind_paw_r_36Geometry = endpoint_hind_paw_r_36
    ? new THREE.CylinderGeometry(endpoint_hind_paw_r_36.endRadius, endpoint_hind_paw_r_36.baseRadius, endpoint_hind_paw_r_36.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_hind_paw_r_36) {
    mesh_hind_paw_r_36Geometry.scale(0.1059, 0.0605, 0.12);
  }
  const mesh_hind_paw_r_36 = new THREE.Mesh(
    mesh_hind_paw_r_36Geometry,
    materialMap["cream-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hind_paw_r_36.name = "Hind Paw R";
  if (endpoint_hind_paw_r_36) {
    mesh_hind_paw_r_36.position.copy(endpoint_hind_paw_r_36.midpoint);
    mesh_hind_paw_r_36.quaternion.copy(endpoint_hind_paw_r_36.quaternion);
  }
  mesh_hind_paw_r_36.castShadow = options.castShadow ?? true;
  mesh_hind_paw_r_36.receiveShadow = options.receiveShadow ?? true;
  mesh_hind_paw_r_36.userData.sculptComponent = {"id": "hind-paw-r", "name": "Hind Paw R", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Cream hind paw peeking out under the belly.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "hip-r", "contactType": "embed", "embedDepth": 0.03, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1059, "height": 0.0605, "depth": 0.12, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.1097, -0.1661, 0.135], "rotation": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hind-paw-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cream-fur"}}, "material": "cream-fur", "materialLayers": ["cream-fur"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 251, 230, 1.0)", "secondaryAlbedo": "rgba(247, 204, 166, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hind_paw_r_36.add(mesh_hind_paw_r_36);
  meshes["hind-paw-r"] = mesh_hind_paw_r_36;
  colliders["hind-paw-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["hind-paw-r"] ??= [];
  destructionGroups["hind-paw-r"].push(node_hind_paw_r_36);

  const endpoint_hind_paw_l_37 = makeAttachmentEndpoint(null);
  const node_hind_paw_l_37 = new THREE.Group();
  node_hind_paw_l_37.name = "Hind Paw L__pivot";
  node_hind_paw_l_37.scale.set(1, 1, 1);
  if (endpoint_hind_paw_l_37) {
    node_hind_paw_l_37.position.copy(endpoint_hind_paw_l_37.start);
    node_hind_paw_l_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hind_paw_l_37.position.set(0.1097, -0.1661, 0.135);
    node_hind_paw_l_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_hind_paw_l_37.userData.sculptComponent = {"id": "hind-paw-l", "name": "Hind Paw L", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Cream hind paw peeking out under the belly.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "hip-l", "contactType": "embed", "embedDepth": 0.03, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1059, "height": 0.0605, "depth": 0.12, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1097, -0.1661, 0.135], "rotation": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hind-paw-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cream-fur"}}, "material": "cream-fur", "materialLayers": ["cream-fur"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 251, 230, 1.0)", "secondaryAlbedo": "rgba(247, 204, 166, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hind_paw_l_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hind-paw-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cream-fur"}};
  (nodes["body"] ?? root).add(node_hind_paw_l_37);
  nodes["hind-paw-l"] = node_hind_paw_l_37;
  const mesh_hind_paw_l_37Geometry = endpoint_hind_paw_l_37
    ? new THREE.CylinderGeometry(endpoint_hind_paw_l_37.endRadius, endpoint_hind_paw_l_37.baseRadius, endpoint_hind_paw_l_37.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_hind_paw_l_37) {
    mesh_hind_paw_l_37Geometry.scale(0.1059, 0.0605, 0.12);
  }
  const mesh_hind_paw_l_37 = new THREE.Mesh(
    mesh_hind_paw_l_37Geometry,
    materialMap["cream-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hind_paw_l_37.name = "Hind Paw L";
  if (endpoint_hind_paw_l_37) {
    mesh_hind_paw_l_37.position.copy(endpoint_hind_paw_l_37.midpoint);
    mesh_hind_paw_l_37.quaternion.copy(endpoint_hind_paw_l_37.quaternion);
  }
  mesh_hind_paw_l_37.castShadow = options.castShadow ?? true;
  mesh_hind_paw_l_37.receiveShadow = options.receiveShadow ?? true;
  mesh_hind_paw_l_37.userData.sculptComponent = {"id": "hind-paw-l", "name": "Hind Paw L", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Cream hind paw peeking out under the belly.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "hip-l", "contactType": "embed", "embedDepth": 0.03, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1059, "height": 0.0605, "depth": 0.12, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1097, -0.1661, 0.135], "rotation": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hind-paw-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cream-fur"}}, "material": "cream-fur", "materialLayers": ["cream-fur"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 251, 230, 1.0)", "secondaryAlbedo": "rgba(247, 204, 166, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_hind_paw_l_37.add(mesh_hind_paw_l_37);
  meshes["hind-paw-l"] = mesh_hind_paw_l_37;
  colliders["hind-paw-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.1059, 0.0605, 0.12], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["hind-paw-l"] ??= [];
  destructionGroups["hind-paw-l"].push(node_hind_paw_l_37);

  const endpoint_tail_38 = makeAttachmentEndpoint(null);
  const node_tail_38 = new THREE.Group();
  node_tail_38.name = "Tail__pivot";
  node_tail_38.scale.set(1, 1, 1);
  if (endpoint_tail_38) {
    node_tail_38.position.copy(endpoint_tail_38.start);
    node_tail_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tail_38.position.set(0.3555, -0.1722, -0.05);
    node_tail_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_tail_38.userData.sculptComponent = {"id": "tail", "name": "Tail", "level": "meso", "role": "tail", "importance": 0.85, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "assembled-solid", "topologyRationale": "Curling tail: a tapered sweep along the measured curve (radius 27 px at the root tapering to 42 % at the tip) whose node sits at its root so it wags about the rump.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0625, "rz": 0.0625, "twist": 0.0}, {"position": [0.056, 0.0107, 0.0], "rx": 0.0573, "rz": 0.0573, "twist": 0.0}, {"position": [0.1077, 0.0345, 0.0], "rx": 0.0521, "rz": 0.0521, "twist": 0.0}, {"position": [0.155, 0.0689, 0.0], "rx": 0.047, "rz": 0.047, "twist": 0.0}, {"position": [0.1896, 0.112, 0.0], "rx": 0.0418, "rz": 0.0418, "twist": 0.0}, {"position": [0.2111, 0.1594, 0.0], "rx": 0.0366, "rz": 0.0366, "twist": 0.0}, {"position": [0.1982, 0.2026, 0.0], "rx": 0.0314, "rz": 0.0314, "twist": 0.0}, {"position": [0.1659, 0.2219, 0.0], "rx": 0.0263, "rz": 0.0263, "twist": 0.0}], "radialSegments": 12, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "tail-root", "localStart": [0.3555, -0.1722, -0.05], "localEnd": [0.5214, 0.0497, -0.05], "contactType": "socket-joint", "baseRadius": 0.0625, "endRadius": 0.0263, "embedDepth": 0.03, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3555, -0.1722, -0.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "tail", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "tip", "localPosition": [0.1659, 0.2219, 0.0]}, {"id": "ring-a", "localPosition": [0.1077, 0.0345, 0.0]}, {"id": "ring-b", "localPosition": [0.1896, 0.112, 0.0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.125, 0.2771, 0.125], "isTrigger": false, "notes": "tail proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rings", "kind": "linework", "note": "two darker rings built as ring-a/ring-b"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(216, 130, 63, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_tail_38.userData.actionProfile = {"animationRole": "tail", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "tip", "localPosition": [0.1659, 0.2219, 0.0]}, {"id": "ring-a", "localPosition": [0.1077, 0.0345, 0.0]}, {"id": "ring-b", "localPosition": [0.1896, 0.112, 0.0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.125, 0.2771, 0.125], "isTrigger": false, "notes": "tail proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}};
  (nodes["body"] ?? root).add(node_tail_38);
  nodes["tail"] = node_tail_38;
  const mesh_tail_38Geometry = endpoint_tail_38
    ? new THREE.CylinderGeometry(endpoint_tail_38.endRadius, endpoint_tail_38.baseRadius, endpoint_tail_38.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0625, "rz": 0.0625, "twist": 0.0}, {"position": [0.056, 0.0107, 0.0], "rx": 0.0573, "rz": 0.0573, "twist": 0.0}, {"position": [0.1077, 0.0345, 0.0], "rx": 0.0521, "rz": 0.0521, "twist": 0.0}, {"position": [0.155, 0.0689, 0.0], "rx": 0.047, "rz": 0.047, "twist": 0.0}, {"position": [0.1896, 0.112, 0.0], "rx": 0.0418, "rz": 0.0418, "twist": 0.0}, {"position": [0.2111, 0.1594, 0.0], "rx": 0.0366, "rz": 0.0366, "twist": 0.0}, {"position": [0.1982, 0.2026, 0.0], "rx": 0.0314, "rz": 0.0314, "twist": 0.0}, {"position": [0.1659, 0.2219, 0.0], "rx": 0.0263, "rz": 0.0263, "twist": 0.0}], "radialSegments": 12, "capEnds": true});
  if (!endpoint_tail_38) {
    mesh_tail_38Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_tail_38 = new THREE.Mesh(
    mesh_tail_38Geometry,
    materialMap["cat-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_38.name = "Tail";
  if (endpoint_tail_38) {
    mesh_tail_38.position.copy(endpoint_tail_38.midpoint);
    mesh_tail_38.quaternion.copy(endpoint_tail_38.quaternion);
  }
  mesh_tail_38.castShadow = options.castShadow ?? true;
  mesh_tail_38.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_38.userData.sculptComponent = {"id": "tail", "name": "Tail", "level": "meso", "role": "tail", "importance": 0.85, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "assembled-solid", "topologyRationale": "Curling tail: a tapered sweep along the measured curve (radius 27 px at the root tapering to 42 % at the tip) whose node sits at its root so it wags about the rump.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0625, "rz": 0.0625, "twist": 0.0}, {"position": [0.056, 0.0107, 0.0], "rx": 0.0573, "rz": 0.0573, "twist": 0.0}, {"position": [0.1077, 0.0345, 0.0], "rx": 0.0521, "rz": 0.0521, "twist": 0.0}, {"position": [0.155, 0.0689, 0.0], "rx": 0.047, "rz": 0.047, "twist": 0.0}, {"position": [0.1896, 0.112, 0.0], "rx": 0.0418, "rz": 0.0418, "twist": 0.0}, {"position": [0.2111, 0.1594, 0.0], "rx": 0.0366, "rz": 0.0366, "twist": 0.0}, {"position": [0.1982, 0.2026, 0.0], "rx": 0.0314, "rz": 0.0314, "twist": 0.0}, {"position": [0.1659, 0.2219, 0.0], "rx": 0.0263, "rz": 0.0263, "twist": 0.0}], "radialSegments": 12, "capEnds": true}}, "parent": "body", "attachment": {"parentSocket": "tail-root", "localStart": [0.3555, -0.1722, -0.05], "localEnd": [0.5214, 0.0497, -0.05], "contactType": "socket-joint", "baseRadius": 0.0625, "endRadius": 0.0263, "embedDepth": 0.03, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3555, -0.1722, -0.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "tail", "pivot": {"mode": "hinge", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "tip", "localPosition": [0.1659, 0.2219, 0.0]}, {"id": "ring-a", "localPosition": [0.1077, 0.0345, 0.0]}, {"id": "ring-b", "localPosition": [0.1896, 0.112, 0.0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.125, 0.2771, 0.125], "isTrigger": false, "notes": "tail proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cat-orange"}}, "material": "cat-orange", "materialLayers": ["cat-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rings", "kind": "linework", "note": "two darker rings built as ring-a/ring-b"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 160, 64, 1.0)", "secondaryAlbedo": "rgba(216, 130, 63, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_tail_38.add(mesh_tail_38);
  meshes["tail"] = mesh_tail_38;
  colliders["tail"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.125, 0.2771, 0.125], "isTrigger": false, "notes": "tail proxy"};
  destructionGroups["tail"] ??= [];
  destructionGroups["tail"].push(node_tail_38);
  const socket_tail_tip_0 = new THREE.Object3D();
  socket_tail_tip_0.name = "tip";
  socket_tail_tip_0.position.set(0.1659, 0.2219, 0.0);
  socket_tail_tip_0.rotation.set(0, 0, 0);
  socket_tail_tip_0.userData.socket = {"id": "tip", "localPosition": [0.1659, 0.2219, 0.0]};
  node_tail_38.add(socket_tail_tip_0);
  sockets["tail:tip"] = socket_tail_tip_0;
  const socket_tail_ring_a_1 = new THREE.Object3D();
  socket_tail_ring_a_1.name = "ring-a";
  socket_tail_ring_a_1.position.set(0.1077, 0.0345, 0.0);
  socket_tail_ring_a_1.rotation.set(0, 0, 0);
  socket_tail_ring_a_1.userData.socket = {"id": "ring-a", "localPosition": [0.1077, 0.0345, 0.0]};
  node_tail_38.add(socket_tail_ring_a_1);
  sockets["tail:ring-a"] = socket_tail_ring_a_1;
  const socket_tail_ring_b_2 = new THREE.Object3D();
  socket_tail_ring_b_2.name = "ring-b";
  socket_tail_ring_b_2.position.set(0.1896, 0.112, 0.0);
  socket_tail_ring_b_2.rotation.set(0, 0, 0);
  socket_tail_ring_b_2.userData.socket = {"id": "ring-b", "localPosition": [0.1896, 0.112, 0.0]};
  node_tail_38.add(socket_tail_ring_b_2);
  sockets["tail:ring-b"] = socket_tail_ring_b_2;

  const endpoint_cream_tip_39 = makeAttachmentEndpoint(null);
  const node_cream_tip_39 = new THREE.Group();
  node_cream_tip_39.name = "Cream tip__pivot";
  node_cream_tip_39.scale.set(1, 1, 1);
  if (endpoint_cream_tip_39) {
    node_cream_tip_39.position.copy(endpoint_cream_tip_39.start);
    node_cream_tip_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cream_tip_39.position.set(0.1659, 0.2219, 0.0);
    node_cream_tip_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_cream_tip_39.userData.sculptComponent = {"id": "cream-tip", "name": "Cream tip", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Cream tip of the tail.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "tail", "attachment": {"parentSocket": "tip", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0625, "height": 0.0825, "depth": 0.0625, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1659, 0.2219, 0.0], "rotation": [0, 0, 0], "scale": [0.0625, 0.0825, 0.0625]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0625, 0.0825, 0.0625], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cream-tip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cream-fur"}}, "material": "cream-fur", "materialLayers": ["cream-fur"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 251, 230, 1.0)", "secondaryAlbedo": "rgba(247, 204, 166, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_cream_tip_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0625, 0.0825, 0.0625], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cream-tip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cream-fur"}};
  (nodes["tail"] ?? root).add(node_cream_tip_39);
  nodes["cream-tip"] = node_cream_tip_39;
  const mesh_cream_tip_39Geometry = endpoint_cream_tip_39
    ? new THREE.CylinderGeometry(endpoint_cream_tip_39.endRadius, endpoint_cream_tip_39.baseRadius, endpoint_cream_tip_39.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_cream_tip_39) {
    mesh_cream_tip_39Geometry.scale(0.0625, 0.0825, 0.0625);
  }
  const mesh_cream_tip_39 = new THREE.Mesh(
    mesh_cream_tip_39Geometry,
    materialMap["cream-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cream_tip_39.name = "Cream tip";
  if (endpoint_cream_tip_39) {
    mesh_cream_tip_39.position.copy(endpoint_cream_tip_39.midpoint);
    mesh_cream_tip_39.quaternion.copy(endpoint_cream_tip_39.quaternion);
  }
  mesh_cream_tip_39.castShadow = options.castShadow ?? true;
  mesh_cream_tip_39.receiveShadow = options.receiveShadow ?? true;
  mesh_cream_tip_39.userData.sculptComponent = {"id": "cream-tip", "name": "Cream tip", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Cream tip of the tail.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "tail", "attachment": {"parentSocket": "tip", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0625, "height": 0.0825, "depth": 0.0625, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1659, 0.2219, 0.0], "rotation": [0, 0, 0], "scale": [0.0625, 0.0825, 0.0625]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0625, 0.0825, 0.0625], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cream-tip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cream-fur"}}, "material": "cream-fur", "materialLayers": ["cream-fur"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 251, 230, 1.0)", "secondaryAlbedo": "rgba(247, 204, 166, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_cream_tip_39.add(mesh_cream_tip_39);
  meshes["cream-tip"] = mesh_cream_tip_39;
  colliders["cream-tip"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0625, 0.0825, 0.0625], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["cream-tip"] ??= [];
  destructionGroups["cream-tip"].push(node_cream_tip_39);

  const endpoint_ring_a_40 = makeAttachmentEndpoint(null);
  const node_ring_a_40 = new THREE.Group();
  node_ring_a_40.name = "Ring A__pivot";
  node_ring_a_40.scale.set(1, 1, 1);
  if (endpoint_ring_a_40) {
    node_ring_a_40.position.copy(endpoint_ring_a_40.start);
    node_ring_a_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_a_40.position.set(0.1077, 0.0345, 0.0);
    node_ring_a_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_a_40.userData.sculptComponent = {"id": "ring-a", "name": "Ring A", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Darker ring stripe around the tail.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "tail", "attachment": {"parentSocket": "ring-a", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1123, "height": 0.1123, "depth": 0.1123, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1077, 0.0345, 0.0], "rotation": [0, 0, 0], "scale": [0.1123, 0.1123, 0.1123]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1123, 0.1123, 0.1123], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 130, 63, 1.0)", "secondaryAlbedo": "rgba(255, 160, 64, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ring_a_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1123, 0.1123, 0.1123], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["tail"] ?? root).add(node_ring_a_40);
  nodes["ring-a"] = node_ring_a_40;
  const mesh_ring_a_40Geometry = endpoint_ring_a_40
    ? new THREE.CylinderGeometry(endpoint_ring_a_40.endRadius, endpoint_ring_a_40.baseRadius, endpoint_ring_a_40.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_ring_a_40) {
    mesh_ring_a_40Geometry.scale(0.1123, 0.1123, 0.1123);
  }
  const mesh_ring_a_40 = new THREE.Mesh(
    mesh_ring_a_40Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_a_40.name = "Ring A";
  if (endpoint_ring_a_40) {
    mesh_ring_a_40.position.copy(endpoint_ring_a_40.midpoint);
    mesh_ring_a_40.quaternion.copy(endpoint_ring_a_40.quaternion);
  }
  mesh_ring_a_40.castShadow = options.castShadow ?? true;
  mesh_ring_a_40.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_a_40.userData.sculptComponent = {"id": "ring-a", "name": "Ring A", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Darker ring stripe around the tail.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "tail", "attachment": {"parentSocket": "ring-a", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1123, "height": 0.1123, "depth": 0.1123, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1077, 0.0345, 0.0], "rotation": [0, 0, 0], "scale": [0.1123, 0.1123, 0.1123]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1123, 0.1123, 0.1123], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-a", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 130, 63, 1.0)", "secondaryAlbedo": "rgba(255, 160, 64, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ring_a_40.add(mesh_ring_a_40);
  meshes["ring-a"] = mesh_ring_a_40;
  colliders["ring-a"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.1123, 0.1123, 0.1123], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["ring-a"] ??= [];
  destructionGroups["ring-a"].push(node_ring_a_40);

  const endpoint_ring_b_41 = makeAttachmentEndpoint(null);
  const node_ring_b_41 = new THREE.Group();
  node_ring_b_41.name = "Ring B__pivot";
  node_ring_b_41.scale.set(1, 1, 1);
  if (endpoint_ring_b_41) {
    node_ring_b_41.position.copy(endpoint_ring_b_41.start);
    node_ring_b_41.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_b_41.position.set(0.1896, 0.112, 0.0);
    node_ring_b_41.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_b_41.userData.sculptComponent = {"id": "ring-b", "name": "Ring B", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Darker ring stripe around the tail.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "tail", "attachment": {"parentSocket": "ring-b", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0916, "height": 0.0916, "depth": 0.0916, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1896, 0.112, 0.0], "rotation": [0, 0, 0], "scale": [0.0916, 0.0916, 0.0916]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0916, 0.0916, 0.0916], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 130, 63, 1.0)", "secondaryAlbedo": "rgba(255, 160, 64, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ring_b_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0916, 0.0916, 0.0916], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}};
  (nodes["tail"] ?? root).add(node_ring_b_41);
  nodes["ring-b"] = node_ring_b_41;
  const mesh_ring_b_41Geometry = endpoint_ring_b_41
    ? new THREE.CylinderGeometry(endpoint_ring_b_41.endRadius, endpoint_ring_b_41.baseRadius, endpoint_ring_b_41.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_ring_b_41) {
    mesh_ring_b_41Geometry.scale(0.0916, 0.0916, 0.0916);
  }
  const mesh_ring_b_41 = new THREE.Mesh(
    mesh_ring_b_41Geometry,
    materialMap["stripe-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_b_41.name = "Ring B";
  if (endpoint_ring_b_41) {
    mesh_ring_b_41.position.copy(endpoint_ring_b_41.midpoint);
    mesh_ring_b_41.quaternion.copy(endpoint_ring_b_41.quaternion);
  }
  mesh_ring_b_41.castShadow = options.castShadow ?? true;
  mesh_ring_b_41.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_b_41.userData.sculptComponent = {"id": "ring-b", "name": "Ring B", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "Darker ring stripe around the tail.", "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "tail", "attachment": {"parentSocket": "ring-b", "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0916, "height": 0.0916, "depth": 0.0916, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1896, 0.112, 0.0], "rotation": [0, 0, 0], "scale": [0.0916, 0.0916, 0.0916]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.0916, 0.0916, 0.0916], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-b", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stripe-orange"}}, "material": "stripe-orange", "materialLayers": ["stripe-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement", "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 130, 63, 1.0)", "secondaryAlbedo": "rgba(255, 160, 64, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "notes": "flat sticker colour"}};
  node_ring_b_41.add(mesh_ring_b_41);
  meshes["ring-b"] = mesh_ring_b_41;
  colliders["ring-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.0916, 0.0916, 0.0916], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["ring-b"] ??= [];
  destructionGroups["ring-b"].push(node_ring_b_41);

  // repetition system: ears (InstancedMesh, radial, count=2, level=meso)
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
    cluster.name = "ears";
    parent.add(cluster);
  }

  // repetition system: eyes (InstancedMesh, radial, count=2, level=meso)
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
    cluster.name = "eyes";
    parent.add(cluster);
  }

  // repetition system: legs (InstancedMesh, radial, count=2, level=meso)
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
    cluster.name = "legs";
    parent.add(cluster);
  }

  // repetition system: stripes (InstancedMesh, radial, count=11, level=meso)
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
    const cluster = new THREE.InstancedMesh(geo, mat, 11);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 11; i++) {
      const ang = ((0.0) + (i * 360) / 11) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "stripes";
    parent.add(cluster);
  }

  // repetition system: tail-rings (InstancedMesh, radial, count=2, level=meso)
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
    cluster.name = "tail-rings";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createWigglePlayCatLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "WigglePlay cat look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "directional", "direction": [-0.35, 0.6, 1.0], "intensity": 1.5, "color": "#ffffff", "castShadow": true, "evidence": "the sticker is lit flat from the front; a frontal upper-left key lights the face fully"}, {"id": "fill", "type": "hemisphere", "skyColor": "#ffffff", "groundColor": "#f3ece4", "intensity": 1.0, "evidence": "neutral warm-white ground so the orange fur is not dimmed from below (the sticker is flat-lit)"}, {"id": "rim", "type": "directional", "direction": [0.5, 0.4, -1.0], "intensity": 0.5, "color": "#e6d6ff", "evidence": "lighter edge along the top silhouette"}, {"id": "exposure", "type": "renderer", "toneMapping": "Neutral", "exposure": 1.55, "outputColorSpace": "srgb", "evidence": "Neutral keeps the saturated orange; exposure 1.55 brings the fur to the sampled value"}, {"id": "ground", "type": "contact-shadow", "contactShadow": "soft blurred disc under the object, opacity 0.35; ambient occlusion via material AO channel disabled (textureless)", "evidence": "sticker has no cast shadow; a soft contact shadow grounds the 3D prop"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createWigglePlayCatEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameWigglePlayCatCamera(
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
export function createWigglePlayCatPresentationComposer(
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

export function configureWigglePlayCatRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createWigglePlayCatInspectControls(
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

export const GENERATED_STAMP = "gen-1788897172-31338";
