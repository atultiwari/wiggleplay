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

// THREE.CapsuleGeometry duplicates every UV-seam vertex (measured: 194 boundary
// edges on the default radius/segments below) -- same benign pattern as box/
// cylinder/sphere/torus, all of which weld cleanly to 0 given a CORRECT weld.
// (A naive vertex-only mergeVertices() reports 64 'non-manifold' edges here, but
// that is a counting artifact, not a real defect: it double-counts a handful of
// near-pole triangles that become degenerate once two of their three corners
// coincide -- confirmed by replicating subdivideCatmullClark's own degenerate-
// triangle-aware vertex identity, which finds a perfectly ordinary 2-manifold.)
// A capsule is the primary shape for skinned limbs/torso (PLAN_1.5), and skinning
// weight computation is O(vertices x bones), so fewer, guaranteed-simple vertices
// is worth having regardless -- authored as a deterministic, closed-by-
// construction mesh instead: shared pole vertices, and
// the radial index taken `% radialSegments` so the seam is never a duplicate
// vertex in the first place, rather than something to weld away afterward.
// Adapted from forge/stage5_rig/emit_rig.py's buildWatertightCapsule (verified
// there: 0 boundary edges, 0 non-manifold edges, deterministic across repeated
// runs) -- ported here rather than imported because this factory and the rig
// emitter are separate generated-output surfaces with no shared runtime module;
// see forge/tests/test_primitive_watertightness.py for the measured proof, and
// coordinate with the rig owner before changing either copy independently.
function buildWatertightCapsule(
  radius: number,
  cylLength: number,
  capSegments: number,
  radialSegments: number,
  heightSegments: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const halfCyl = cylLength / 2;
  const totalSpan = 2 * (Math.PI / 2 * radius) + Math.max(0, cylLength);
  const vOf = (fromBottom: number) => (totalSpan > 0 ? fromBottom / totalSpan : 0);

  const bottomPoleIndex = positions.length / 3;
  positions.push(0, -halfCyl - radius, 0);
  uvs.push(0.5, vOf(0));

  const ringStarts: number[] = [];
  const ringV: number[] = [];
  for (let ring = 1; ring <= capSegments; ring += 1) {
    const phi = (Math.PI / 2) * (ring / capSegments);
    const y = -halfCyl - radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    const start = positions.length / 3;
    ringStarts.push(start);
    ringV.push(vOf(radius * phi));
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const theta = (radial / radialSegments) * Math.PI * 2;
      positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
      uvs.push(radial / radialSegments, vOf(radius * phi));
    }
  }

  const cylinderRingStarts: number[] = [];
  if (cylLength > 0) {
    for (let step = 1; step <= heightSegments; step += 1) {
      const y = -halfCyl + (cylLength * step) / heightSegments;
      const start = positions.length / 3;
      cylinderRingStarts.push(start);
      const v = vOf(radius * (Math.PI / 2) + halfCyl + y);
      for (let radial = 0; radial < radialSegments; radial += 1) {
        const theta = (radial / radialSegments) * Math.PI * 2;
        positions.push(radius * Math.cos(theta), y, radius * Math.sin(theta));
        uvs.push(radial / radialSegments, v);
      }
    }
  }

  const topRingStarts: number[] = [];
  for (let ring = capSegments - 1; ring >= 1; ring -= 1) {
    const phi = (Math.PI / 2) * (ring / capSegments);
    const y = halfCyl + radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    const start = positions.length / 3;
    topRingStarts.push(start);
    const v = vOf(radius * (Math.PI / 2) + Math.max(0, cylLength) + radius * (Math.PI / 2 - phi));
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const theta = (radial / radialSegments) * Math.PI * 2;
      positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
      uvs.push(radial / radialSegments, v);
    }
  }

  const topPoleIndex = positions.length / 3;
  positions.push(0, halfCyl + radius, 0);
  uvs.push(0.5, vOf(totalSpan));

  const firstBottomRing = ringStarts[0];
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const next = (radial + 1) % radialSegments;
    indices.push(bottomPoleIndex, firstBottomRing + radial, firstBottomRing + next);
  }

  const allRings = [...ringStarts, ...cylinderRingStarts, ...topRingStarts];
  for (let i = 0; i < allRings.length - 1; i += 1) {
    const a = allRings[i];
    const b = allRings[i + 1];
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const next = (radial + 1) % radialSegments;
      indices.push(a + radial, a + next, b + next);
      indices.push(a + radial, b + next, b + radial);
    }
  }

  const lastRing = allRings[allRings.length - 1];
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const next = (radial + 1) % radialSegments;
    indices.push(topPoleIndex, lastRing + next, lastRing + radial);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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

// Generated from ObjectSculptSpec target: WigglePlay Mascot
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createWigglePlayMascotModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "WigglePlay Mascot";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["hidden"] = createSculptMaterial(
    "hidden",
    {"id": "hidden", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000"]}, "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "roughness": {"base": 1.0, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "opacity": {"base": 0.0}, "qualityTier": "utility", "textureless": {"declared": true, "evidence": ["invisible root carrier; never rendered"]}},
    options
  );
  materialMap["body-skin"] = createSculptMaterial(
    "body-skin",
    {"id": "body-skin", "name": "Body satin skin", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#c9a6ff", "color": "#c9a6ff", "albedo": {"dominant": "#c9a6ff", "secondary": ["#dcc4ff", "#a889f2", "#f7bfe8", "#ff7aa8"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#b58cf0", "#cbaaff", "#8f6fe0", "#f0a8dc", "#f25f8f"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.5, "variation": 0.06, "localResponse": "slightly lower roughness on the belly patch and cheeks (airbrush sheen)"}, "metalness": {"base": 0.0, "variation": 0.0}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "gradient", "region": "whole body, vertical", "color": "#cbaaff -> #8f6fe0", "note": "crown-light and base-violet vertexPaint bands"}, {"id": "belly", "region": "lower front", "color": "#f0a8dc", "note": "vertexPaint soft ellipsoid"}, {"id": "outline", "region": "silhouette", "color": "#1a1330", "note": "optional inverted-hull outline pass at runtime (2D sticker convention), not geometry"}], "shaderNotes": ["Satin dielectric; no clearcoat so the eyes read glossier than the body.", "Vertex colours carry every marking; material.vertexColors must be true.", "Albedo lifted ~12% in value versus the sampled stops because ACES darkens mid-tones; verified against the reference in the material-pass sheet."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "textureless": {"declared": true, "evidence": ["refs/mascot.png: flat airbrushed sticker fill with no grain, pores or print at 512px; identity is silhouette + flat colour regions"]}},
    options
  );
  materialMap["eye-gloss"] = createSculptMaterial(
    "eye-gloss",
    {"id": "eye-gloss", "name": "Eye gloss", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#5aa0ff", "color": "#5aa0ff", "albedo": {"dominant": "#5aa0ff", "secondary": ["#a8dcff", "#1c2a4d"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#2160d6", "#5fb4ff", "#1c2a4d"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.08, "variation": 0.03}, "metalness": {"base": 0.0, "variation": 0.0}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "roughness", "region": "whole eye", "roughness": 0.08, "note": "gloss sphere"}, {"id": "iris-gradient", "region": "front cap", "color": "#5fb4ff -> #2160d6", "note": "vertexPaint iris-centre soft ellipsoid; dark outline-ring band on the sides"}], "shaderNotes": ["Clearcoat gloss so the key light forms a hotspot; vertexColors true.", "Low emissive lift so the glossy sphere reads flat-lit like the sticker iris instead of shading to navy."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "textureless": {"declared": true, "evidence": ["refs/mascot.png: flat airbrushed sticker fill with no grain, pores or print at 512px; identity is silhouette + flat colour regions"]}, "clearcoat": {"base": 1.0}, "clearcoatRoughness": {"base": 0.05}, "emissive": "#1a3a80", "emissiveIntensity": {"base": 0.35}},
    options
  );
  materialMap["catchlight"] = createSculptMaterial(
    "catchlight",
    {"id": "catchlight", "name": "Catchlight white", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ffffff", "color": "#ffffff", "albedo": {"dominant": "#ffffff", "secondary": ["#ffffff"], "samplingNotes": "sampled from the sticker; flat regions, no texture detail"}, "colorVariation": {"palette": ["#ffffff", "#ffffff"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.35, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "unlit", "region": "whole", "emissive": "#ffffff", "note": "reads pure white under any lighting"}], "shaderNotes": [], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "textureless": {"declared": true, "evidence": ["refs/mascot.png: flat airbrushed sticker fill with no grain, pores or print at 512px; identity is silhouette + flat colour regions"]}, "emissive": "#ffffff", "emissiveIntensity": {"base": 1.1}},
    options
  );
  materialMap["cheek-pink"] = createSculptMaterial(
    "cheek-pink",
    {"id": "cheek-pink", "name": "Cheek blush", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#ff7aa8", "color": "#ff7aa8", "albedo": {"dominant": "#ff7aa8", "secondary": ["#ff7aa8"], "samplingNotes": "flat sticker colour"}, "colorVariation": {"palette": ["#f25f8f"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.5, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#f25f8f", "note": "single flat colour region"}], "shaderNotes": ["flat colour marking on the face"], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "textureless": {"declared": true, "evidence": ["refs/mascot.png: flat airbrushed sticker fill with no grain, pores or print at 512px; identity is silhouette + flat colour regions"]}},
    options
  );
  materialMap["line-dark"] = createSculptMaterial(
    "line-dark",
    {"id": "line-dark", "name": "Toon line", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#1a1330", "color": "#1a1330", "albedo": {"dominant": "#1a1330", "secondary": ["#1a1330"], "samplingNotes": "flat sticker colour"}, "colorVariation": {"palette": ["#1a1330"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.65, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#1a1330", "note": "single flat colour region"}], "shaderNotes": ["flat colour marking on the face"], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "textureless": {"declared": true, "evidence": ["refs/mascot.png: flat airbrushed sticker fill with no grain, pores or print at 512px; identity is silhouette + flat colour regions"]}},
    options
  );
  materialMap["lip-blue"] = createSculptMaterial(
    "lip-blue",
    {"id": "lip-blue", "name": "Lip highlight", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#a8e0ff", "color": "#a8e0ff", "albedo": {"dominant": "#a8e0ff", "secondary": ["#a8e0ff"], "samplingNotes": "flat sticker colour"}, "colorVariation": {"palette": ["#8fd0ff"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.35, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "flat", "region": "whole", "color": "#8fd0ff", "note": "single flat colour region"}], "shaderNotes": ["flat colour marking on the face"], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "textureless": {"declared": true, "evidence": ["refs/mascot.png: flat airbrushed sticker fill with no grain, pores or print at 512px; identity is silhouette + flat colour regions"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Character (root)__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Character (root)", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Invisible root carrier with no visible geometry of its own.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "ground", "localPosition": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "ground", "localPosition": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Character (root)";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Character (root)", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Invisible root carrier with no visible geometry of its own.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "ground", "localPosition": [0, 0, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
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
  node_body_1.name = "Body (egg head-body)__pivot";
  node_body_1.scale.set(1, 1, 1);
  if (endpoint_body_1) {
    node_body_1.position.copy(endpoint_body_1.start);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_body_1.position.set(0.0, 0.552, 0.0);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_body_1.userData.sculptComponent = {"id": "body", "name": "Body (egg head-body)", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "One continuous egg volume measured row-by-row from the reference outline and revolved as a lathe profile (wider below the eyes, narrower crown); markings are vertex-painted regions.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "latheProfile": {"points": [[0.0001, -0.45], [0.1981, -0.448], [0.3302, -0.4354], [0.3319, -0.4237], [0.3338, -0.4121], [0.3373, -0.4005], [0.3412, -0.3889], [0.3453, -0.3772], [0.3492, -0.3656], [0.3528, -0.354], [0.3562, -0.3423], [0.3594, -0.3307], [0.3624, -0.3191], [0.3653, -0.3075], [0.3681, -0.2958], [0.3708, -0.2842], [0.3733, -0.2726], [0.3755, -0.261], [0.3771, -0.2493], [0.3782, -0.2377], [0.3787, -0.2261], [0.3786, -0.2144], [0.3783, -0.2028], [0.3777, -0.1912], [0.3771, -0.1796], [0.3765, -0.1679], [0.3758, -0.1563], [0.3752, -0.1447], [0.3746, -0.133], [0.374, -0.1214], [0.3733, -0.1098], [0.3727, -0.0982], [0.3721, -0.0865], [0.3715, -0.0749], [0.3708, -0.0633], [0.3702, -0.0517], [0.3696, -0.04], [0.369, -0.0284], [0.3683, -0.0168], [0.3677, -0.0051], [0.3671, 0.0065], [0.3665, 0.0181], [0.3658, 0.0297], [0.3652, 0.0414], [0.3646, 0.053], [0.364, 0.0646], [0.3633, 0.0763], [0.3627, 0.0879], [0.3621, 0.0995], [0.3614, 0.1111], [0.3608, 0.1228], [0.3602, 0.1344], [0.3596, 0.146], [0.3589, 0.1577], [0.3583, 0.1693], [0.3575, 0.1809], [0.3564, 0.1925], [0.3547, 0.2042], [0.3523, 0.2158], [0.3489, 0.2274], [0.3446, 0.239], [0.3394, 0.2507], [0.3335, 0.2623], [0.3271, 0.2739], [0.3201, 0.2856], [0.3127, 0.2972], [0.3047, 0.3088], [0.296, 0.3204], [0.2865, 0.3321], [0.2761, 0.3437], [0.2646, 0.3553], [0.2517, 0.367], [0.2372, 0.3786], [0.2206, 0.3902], [0.2012, 0.4018], [0.182, 0.4135], [0.1631, 0.4251], [0.1528, 0.4367], [0.1427, 0.4483], [0.0001, 0.45134883720930236]], "segments": 40}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.76, "height": 0.895, "depth": 0.684, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, 0.552, 0.0], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 0.9]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "shoulder-l", "localPosition": [0.35, -0.09, 0.02]}, {"id": "shoulder-r", "localPosition": [-0.35, -0.09, 0.02]}, {"id": "wrist-l", "localPosition": [0.48, 0.03, 0.02]}, {"id": "wrist-r", "localPosition": [-0.48, 0.03, 0.02]}, {"id": "hip-l", "localPosition": [0.245, -0.4, 0.0]}, {"id": "hip-r", "localPosition": [-0.245, -0.4, 0.0]}, {"id": "eye-l", "localPosition": [0.169, 0.204, 0.258]}, {"id": "eye-r", "localPosition": [-0.169, 0.204, 0.258]}, {"id": "crown", "localPosition": [0, 0.4475, 0]}, {"id": "cheek-l", "localPosition": [0.267, 0.076, 0.245]}, {"id": "cheek-r", "localPosition": [-0.267, 0.076, 0.245]}, {"id": "mouth", "localPosition": [0, 0.006, 0.342]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.76, 0.895, 0.684], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "belly", "kind": "decal", "note": "lighter pink oval on the lower front (vertexPaint belly-patch)"}, {"id": "gradient", "kind": "decal", "note": "crown-light / base-violet vertical ramp (vertexPaint bands)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "vertexPaint": {"baseColor": "#c9a6ff", "regions": [{"id": "crown-light", "kind": "axis-band", "axis": "y", "min": 0.054, "max": 0.6, "softness": 0.16, "color": "#dcc4ff"}, {"id": "base-violet", "kind": "axis-band", "axis": "y", "min": -0.6, "max": -0.098, "softness": 0.14, "color": "#a889f2"}, {"id": "belly-patch", "kind": "ellipsoid", "center": [0.0, -0.226, 0.22], "radii": [0.233, 0.174, 0.25], "softness": 0.06, "color": "#f9c4ea"}]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_body_1.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "shoulder-l", "localPosition": [0.35, -0.09, 0.02]}, {"id": "shoulder-r", "localPosition": [-0.35, -0.09, 0.02]}, {"id": "wrist-l", "localPosition": [0.48, 0.03, 0.02]}, {"id": "wrist-r", "localPosition": [-0.48, 0.03, 0.02]}, {"id": "hip-l", "localPosition": [0.245, -0.4, 0.0]}, {"id": "hip-r", "localPosition": [-0.245, -0.4, 0.0]}, {"id": "eye-l", "localPosition": [0.169, 0.204, 0.258]}, {"id": "eye-r", "localPosition": [-0.169, 0.204, 0.258]}, {"id": "crown", "localPosition": [0, 0.4475, 0]}, {"id": "cheek-l", "localPosition": [0.267, 0.076, 0.245]}, {"id": "cheek-r", "localPosition": [-0.267, 0.076, 0.245]}, {"id": "mouth", "localPosition": [0, 0.006, 0.342]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.76, 0.895, 0.684], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["root"] ?? root).add(node_body_1);
  nodes["body"] = node_body_1;
  const mesh_body_1Geometry = endpoint_body_1
    ? new THREE.CylinderGeometry(endpoint_body_1.endRadius, endpoint_body_1.baseRadius, endpoint_body_1.length, 16, 6)
    : buildLatheGeometry({"points": [[0.0001, -0.45], [0.1981, -0.448], [0.3302, -0.4354], [0.3319, -0.4237], [0.3338, -0.4121], [0.3373, -0.4005], [0.3412, -0.3889], [0.3453, -0.3772], [0.3492, -0.3656], [0.3528, -0.354], [0.3562, -0.3423], [0.3594, -0.3307], [0.3624, -0.3191], [0.3653, -0.3075], [0.3681, -0.2958], [0.3708, -0.2842], [0.3733, -0.2726], [0.3755, -0.261], [0.3771, -0.2493], [0.3782, -0.2377], [0.3787, -0.2261], [0.3786, -0.2144], [0.3783, -0.2028], [0.3777, -0.1912], [0.3771, -0.1796], [0.3765, -0.1679], [0.3758, -0.1563], [0.3752, -0.1447], [0.3746, -0.133], [0.374, -0.1214], [0.3733, -0.1098], [0.3727, -0.0982], [0.3721, -0.0865], [0.3715, -0.0749], [0.3708, -0.0633], [0.3702, -0.0517], [0.3696, -0.04], [0.369, -0.0284], [0.3683, -0.0168], [0.3677, -0.0051], [0.3671, 0.0065], [0.3665, 0.0181], [0.3658, 0.0297], [0.3652, 0.0414], [0.3646, 0.053], [0.364, 0.0646], [0.3633, 0.0763], [0.3627, 0.0879], [0.3621, 0.0995], [0.3614, 0.1111], [0.3608, 0.1228], [0.3602, 0.1344], [0.3596, 0.146], [0.3589, 0.1577], [0.3583, 0.1693], [0.3575, 0.1809], [0.3564, 0.1925], [0.3547, 0.2042], [0.3523, 0.2158], [0.3489, 0.2274], [0.3446, 0.239], [0.3394, 0.2507], [0.3335, 0.2623], [0.3271, 0.2739], [0.3201, 0.2856], [0.3127, 0.2972], [0.3047, 0.3088], [0.296, 0.3204], [0.2865, 0.3321], [0.2761, 0.3437], [0.2646, 0.3553], [0.2517, 0.367], [0.2372, 0.3786], [0.2206, 0.3902], [0.2012, 0.4018], [0.182, 0.4135], [0.1631, 0.4251], [0.1528, 0.4367], [0.1427, 0.4483], [0.0001, 0.45134883720930236]], "segments": 40});
  if (!endpoint_body_1) {
    mesh_body_1Geometry.scale(1.0, 1.0, 0.9);
  }
  applyVertexPaint(mesh_body_1Geometry, "#c9a6ff", [{"id": "crown-light", "kind": "axis-band", "color": "#dcc4ff", "softness": 0.16, "axis": "y", "min": 0.054, "max": 0.6}, {"id": "base-violet", "kind": "axis-band", "color": "#a889f2", "softness": 0.14, "axis": "y", "min": -0.6, "max": -0.098}, {"id": "belly-patch", "kind": "ellipsoid", "color": "#f9c4ea", "softness": 0.06, "center": [0.0, -0.226, 0.22], "radii": [0.233, 0.174, 0.25]}]);
  const mesh_body_1 = new THREE.SkinnedMesh(
    mesh_body_1Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_1.name = "Body (egg head-body)";
  mesh_body_1.material = mesh_body_1.material.clone();
  mesh_body_1.material.vertexColors = true;
  (mesh_body_1.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_body_1) {
    mesh_body_1.position.copy(endpoint_body_1.midpoint);
    mesh_body_1.quaternion.copy(endpoint_body_1.quaternion);
  }
  mesh_body_1.castShadow = options.castShadow ?? true;
  mesh_body_1.receiveShadow = options.receiveShadow ?? true;
  mesh_body_1.userData.sculptComponent = {"id": "body", "name": "Body (egg head-body)", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "One continuous egg volume measured row-by-row from the reference outline and revolved as a lathe profile (wider below the eyes, narrower crown); markings are vertex-painted regions.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "latheProfile": {"points": [[0.0001, -0.45], [0.1981, -0.448], [0.3302, -0.4354], [0.3319, -0.4237], [0.3338, -0.4121], [0.3373, -0.4005], [0.3412, -0.3889], [0.3453, -0.3772], [0.3492, -0.3656], [0.3528, -0.354], [0.3562, -0.3423], [0.3594, -0.3307], [0.3624, -0.3191], [0.3653, -0.3075], [0.3681, -0.2958], [0.3708, -0.2842], [0.3733, -0.2726], [0.3755, -0.261], [0.3771, -0.2493], [0.3782, -0.2377], [0.3787, -0.2261], [0.3786, -0.2144], [0.3783, -0.2028], [0.3777, -0.1912], [0.3771, -0.1796], [0.3765, -0.1679], [0.3758, -0.1563], [0.3752, -0.1447], [0.3746, -0.133], [0.374, -0.1214], [0.3733, -0.1098], [0.3727, -0.0982], [0.3721, -0.0865], [0.3715, -0.0749], [0.3708, -0.0633], [0.3702, -0.0517], [0.3696, -0.04], [0.369, -0.0284], [0.3683, -0.0168], [0.3677, -0.0051], [0.3671, 0.0065], [0.3665, 0.0181], [0.3658, 0.0297], [0.3652, 0.0414], [0.3646, 0.053], [0.364, 0.0646], [0.3633, 0.0763], [0.3627, 0.0879], [0.3621, 0.0995], [0.3614, 0.1111], [0.3608, 0.1228], [0.3602, 0.1344], [0.3596, 0.146], [0.3589, 0.1577], [0.3583, 0.1693], [0.3575, 0.1809], [0.3564, 0.1925], [0.3547, 0.2042], [0.3523, 0.2158], [0.3489, 0.2274], [0.3446, 0.239], [0.3394, 0.2507], [0.3335, 0.2623], [0.3271, 0.2739], [0.3201, 0.2856], [0.3127, 0.2972], [0.3047, 0.3088], [0.296, 0.3204], [0.2865, 0.3321], [0.2761, 0.3437], [0.2646, 0.3553], [0.2517, 0.367], [0.2372, 0.3786], [0.2206, 0.3902], [0.2012, 0.4018], [0.182, 0.4135], [0.1631, 0.4251], [0.1528, 0.4367], [0.1427, 0.4483], [0.0001, 0.45134883720930236]], "segments": 40}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.76, "height": 0.895, "depth": 0.684, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, 0.552, 0.0], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 0.9]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "shoulder-l", "localPosition": [0.35, -0.09, 0.02]}, {"id": "shoulder-r", "localPosition": [-0.35, -0.09, 0.02]}, {"id": "wrist-l", "localPosition": [0.48, 0.03, 0.02]}, {"id": "wrist-r", "localPosition": [-0.48, 0.03, 0.02]}, {"id": "hip-l", "localPosition": [0.245, -0.4, 0.0]}, {"id": "hip-r", "localPosition": [-0.245, -0.4, 0.0]}, {"id": "eye-l", "localPosition": [0.169, 0.204, 0.258]}, {"id": "eye-r", "localPosition": [-0.169, 0.204, 0.258]}, {"id": "crown", "localPosition": [0, 0.4475, 0]}, {"id": "cheek-l", "localPosition": [0.267, 0.076, 0.245]}, {"id": "cheek-r", "localPosition": [-0.267, 0.076, 0.245]}, {"id": "mouth", "localPosition": [0, 0.006, 0.342]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.76, 0.895, 0.684], "isTrigger": false, "notes": "ellipsoid proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "belly", "kind": "decal", "note": "lighter pink oval on the lower front (vertexPaint belly-patch)"}, {"id": "gradient", "kind": "decal", "note": "crown-light / base-violet vertical ramp (vertexPaint bands)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "vertexPaint": {"baseColor": "#c9a6ff", "regions": [{"id": "crown-light", "kind": "axis-band", "axis": "y", "min": 0.054, "max": 0.6, "softness": 0.16, "color": "#dcc4ff"}, {"id": "base-violet", "kind": "axis-band", "axis": "y", "min": -0.6, "max": -0.098, "softness": 0.14, "color": "#a889f2"}, {"id": "belly-patch", "kind": "ellipsoid", "center": [0.0, -0.226, 0.22], "radii": [0.233, 0.174, 0.25], "softness": 0.06, "color": "#f9c4ea"}]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_body_1.add(mesh_body_1);
  meshes["body"] = mesh_body_1;
  colliders["body"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.76, 0.895, 0.684], "isTrigger": false, "notes": "ellipsoid proxy"};
  destructionGroups["body"] ??= [];
  destructionGroups["body"].push(node_body_1);
  const socket_body_shoulder_l_0 = new THREE.Object3D();
  socket_body_shoulder_l_0.name = "shoulder-l";
  socket_body_shoulder_l_0.position.set(0.35, -0.09, 0.02);
  socket_body_shoulder_l_0.rotation.set(0, 0, 0);
  socket_body_shoulder_l_0.userData.socket = {"id": "shoulder-l", "localPosition": [0.35, -0.09, 0.02]};
  node_body_1.add(socket_body_shoulder_l_0);
  sockets["body:shoulder-l"] = socket_body_shoulder_l_0;
  const socket_body_shoulder_r_1 = new THREE.Object3D();
  socket_body_shoulder_r_1.name = "shoulder-r";
  socket_body_shoulder_r_1.position.set(-0.35, -0.09, 0.02);
  socket_body_shoulder_r_1.rotation.set(0, 0, 0);
  socket_body_shoulder_r_1.userData.socket = {"id": "shoulder-r", "localPosition": [-0.35, -0.09, 0.02]};
  node_body_1.add(socket_body_shoulder_r_1);
  sockets["body:shoulder-r"] = socket_body_shoulder_r_1;
  const socket_body_wrist_l_2 = new THREE.Object3D();
  socket_body_wrist_l_2.name = "wrist-l";
  socket_body_wrist_l_2.position.set(0.48, 0.03, 0.02);
  socket_body_wrist_l_2.rotation.set(0, 0, 0);
  socket_body_wrist_l_2.userData.socket = {"id": "wrist-l", "localPosition": [0.48, 0.03, 0.02]};
  node_body_1.add(socket_body_wrist_l_2);
  sockets["body:wrist-l"] = socket_body_wrist_l_2;
  const socket_body_wrist_r_3 = new THREE.Object3D();
  socket_body_wrist_r_3.name = "wrist-r";
  socket_body_wrist_r_3.position.set(-0.48, 0.03, 0.02);
  socket_body_wrist_r_3.rotation.set(0, 0, 0);
  socket_body_wrist_r_3.userData.socket = {"id": "wrist-r", "localPosition": [-0.48, 0.03, 0.02]};
  node_body_1.add(socket_body_wrist_r_3);
  sockets["body:wrist-r"] = socket_body_wrist_r_3;
  const socket_body_hip_l_4 = new THREE.Object3D();
  socket_body_hip_l_4.name = "hip-l";
  socket_body_hip_l_4.position.set(0.245, -0.4, 0.0);
  socket_body_hip_l_4.rotation.set(0, 0, 0);
  socket_body_hip_l_4.userData.socket = {"id": "hip-l", "localPosition": [0.245, -0.4, 0.0]};
  node_body_1.add(socket_body_hip_l_4);
  sockets["body:hip-l"] = socket_body_hip_l_4;
  const socket_body_hip_r_5 = new THREE.Object3D();
  socket_body_hip_r_5.name = "hip-r";
  socket_body_hip_r_5.position.set(-0.245, -0.4, 0.0);
  socket_body_hip_r_5.rotation.set(0, 0, 0);
  socket_body_hip_r_5.userData.socket = {"id": "hip-r", "localPosition": [-0.245, -0.4, 0.0]};
  node_body_1.add(socket_body_hip_r_5);
  sockets["body:hip-r"] = socket_body_hip_r_5;
  const socket_body_eye_l_6 = new THREE.Object3D();
  socket_body_eye_l_6.name = "eye-l";
  socket_body_eye_l_6.position.set(0.169, 0.204, 0.258);
  socket_body_eye_l_6.rotation.set(0, 0, 0);
  socket_body_eye_l_6.userData.socket = {"id": "eye-l", "localPosition": [0.169, 0.204, 0.258]};
  node_body_1.add(socket_body_eye_l_6);
  sockets["body:eye-l"] = socket_body_eye_l_6;
  const socket_body_eye_r_7 = new THREE.Object3D();
  socket_body_eye_r_7.name = "eye-r";
  socket_body_eye_r_7.position.set(-0.169, 0.204, 0.258);
  socket_body_eye_r_7.rotation.set(0, 0, 0);
  socket_body_eye_r_7.userData.socket = {"id": "eye-r", "localPosition": [-0.169, 0.204, 0.258]};
  node_body_1.add(socket_body_eye_r_7);
  sockets["body:eye-r"] = socket_body_eye_r_7;
  const socket_body_crown_8 = new THREE.Object3D();
  socket_body_crown_8.name = "crown";
  socket_body_crown_8.position.set(0.0, 0.4475, 0.0);
  socket_body_crown_8.rotation.set(0, 0, 0);
  socket_body_crown_8.userData.socket = {"id": "crown", "localPosition": [0, 0.4475, 0]};
  node_body_1.add(socket_body_crown_8);
  sockets["body:crown"] = socket_body_crown_8;
  const socket_body_cheek_l_9 = new THREE.Object3D();
  socket_body_cheek_l_9.name = "cheek-l";
  socket_body_cheek_l_9.position.set(0.267, 0.076, 0.245);
  socket_body_cheek_l_9.rotation.set(0, 0, 0);
  socket_body_cheek_l_9.userData.socket = {"id": "cheek-l", "localPosition": [0.267, 0.076, 0.245]};
  node_body_1.add(socket_body_cheek_l_9);
  sockets["body:cheek-l"] = socket_body_cheek_l_9;
  const socket_body_cheek_r_10 = new THREE.Object3D();
  socket_body_cheek_r_10.name = "cheek-r";
  socket_body_cheek_r_10.position.set(-0.267, 0.076, 0.245);
  socket_body_cheek_r_10.rotation.set(0, 0, 0);
  socket_body_cheek_r_10.userData.socket = {"id": "cheek-r", "localPosition": [-0.267, 0.076, 0.245]};
  node_body_1.add(socket_body_cheek_r_10);
  sockets["body:cheek-r"] = socket_body_cheek_r_10;
  const socket_body_mouth_11 = new THREE.Object3D();
  socket_body_mouth_11.name = "mouth";
  socket_body_mouth_11.position.set(0.0, 0.006, 0.342);
  socket_body_mouth_11.rotation.set(0, 0, 0);
  socket_body_mouth_11.userData.socket = {"id": "mouth", "localPosition": [0, 0.006, 0.342]};
  node_body_1.add(socket_body_mouth_11);
  sockets["body:mouth"] = socket_body_mouth_11;

  const endpoint_eye_l_2 = makeAttachmentEndpoint(null);
  const node_eye_l_2 = new THREE.Group();
  node_eye_l_2.name = "Eye L__pivot";
  node_eye_l_2.scale.set(1, 1, 1);
  if (endpoint_eye_l_2) {
    node_eye_l_2.position.copy(endpoint_eye_l_2.start);
    node_eye_l_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_l_2.position.set(0.169, 0.204, 0.258);
    node_eye_l_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_l_2.userData.sculptComponent = {"id": "eye-l", "name": "Eye L", "level": "meso", "role": "eye", "importance": 0.95, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "A discrete glossy sphere seated two-thirds proud of the face; the iris and dark rim are vertex-painted regions on the same sphere.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "eye-l", "contactType": "embed", "embedDepth": 0.05, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.168, "height": 0.168, "depth": 0.168, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.169, 0.204, 0.258], "rotation": [0, 0, 0], "scale": [0.168, 0.168, 0.168]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "catchlight", "localPosition": [0.03, 0.03, 0.078]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.168, 0.168, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-gloss"}}, "material": "eye-gloss", "materialLayers": ["eye-gloss"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "catchlights", "kind": "emissive", "note": "two 4-point star catchlights (built as catchlight-* components)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "vertexPaint": {"baseColor": "#5aa0ff", "regions": [{"id": "iris-centre", "kind": "ellipsoid", "center": [0.0, 0.0, 0.084], "radii": [0.055, 0.055, 0.05], "softness": 0.04, "color": "#a8dcff"}, {"id": "outline-ring", "kind": "axis-band", "axis": "z", "min": -0.2, "max": 0.015, "softness": 0.008, "color": "#1c2a4d"}]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 160, 255, 1.0)", "secondaryAlbedo": "rgba(168, 220, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.8, "colorGradient": {"type": "radial", "stops": [{"t": 0.0, "color": "rgba(95, 180, 255, 1.0)"}, {"t": 1.0, "color": "rgba(33, 96, 214, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "glossy iris sphere with dark navy rim"}};
  node_eye_l_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "catchlight", "localPosition": [0.03, 0.03, 0.078]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.168, 0.168, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-gloss"}};
  (nodes["body"] ?? root).add(node_eye_l_2);
  nodes["eye-l"] = node_eye_l_2;
  const mesh_eye_l_2Geometry = endpoint_eye_l_2
    ? new THREE.CylinderGeometry(endpoint_eye_l_2.endRadius, endpoint_eye_l_2.baseRadius, endpoint_eye_l_2.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_l_2) {
    mesh_eye_l_2Geometry.scale(0.168, 0.168, 0.168);
  }
  applyVertexPaint(mesh_eye_l_2Geometry, "#5aa0ff", [{"id": "iris-centre", "kind": "ellipsoid", "color": "#a8dcff", "softness": 0.04, "center": [0.0, 0.0, 0.084], "radii": [0.055, 0.055, 0.05]}, {"id": "outline-ring", "kind": "axis-band", "color": "#1c2a4d", "softness": 0.008, "axis": "z", "min": -0.2, "max": 0.015}]);
  const mesh_eye_l_2 = new THREE.Mesh(
    mesh_eye_l_2Geometry,
    materialMap["eye-gloss"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_l_2.name = "Eye L";
  mesh_eye_l_2.material = mesh_eye_l_2.material.clone();
  mesh_eye_l_2.material.vertexColors = true;
  (mesh_eye_l_2.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_eye_l_2) {
    mesh_eye_l_2.position.copy(endpoint_eye_l_2.midpoint);
    mesh_eye_l_2.quaternion.copy(endpoint_eye_l_2.quaternion);
  }
  mesh_eye_l_2.castShadow = options.castShadow ?? true;
  mesh_eye_l_2.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_l_2.userData.sculptComponent = {"id": "eye-l", "name": "Eye L", "level": "meso", "role": "eye", "importance": 0.95, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "A discrete glossy sphere seated two-thirds proud of the face; the iris and dark rim are vertex-painted regions on the same sphere.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "eye-l", "contactType": "embed", "embedDepth": 0.05, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.168, "height": 0.168, "depth": 0.168, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.169, 0.204, 0.258], "rotation": [0, 0, 0], "scale": [0.168, 0.168, 0.168]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "catchlight", "localPosition": [0.03, 0.03, 0.078]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.168, 0.168, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-gloss"}}, "material": "eye-gloss", "materialLayers": ["eye-gloss"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "catchlights", "kind": "emissive", "note": "two 4-point star catchlights (built as catchlight-* components)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "vertexPaint": {"baseColor": "#5aa0ff", "regions": [{"id": "iris-centre", "kind": "ellipsoid", "center": [0.0, 0.0, 0.084], "radii": [0.055, 0.055, 0.05], "softness": 0.04, "color": "#a8dcff"}, {"id": "outline-ring", "kind": "axis-band", "axis": "z", "min": -0.2, "max": 0.015, "softness": 0.008, "color": "#1c2a4d"}]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 160, 255, 1.0)", "secondaryAlbedo": "rgba(168, 220, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.8, "colorGradient": {"type": "radial", "stops": [{"t": 0.0, "color": "rgba(95, 180, 255, 1.0)"}, {"t": 1.0, "color": "rgba(33, 96, 214, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "glossy iris sphere with dark navy rim"}};
  node_eye_l_2.add(mesh_eye_l_2);
  meshes["eye-l"] = mesh_eye_l_2;
  colliders["eye-l"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.168, 0.168, 0.168], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_l_2);
  const socket_eye_l_catchlight_0 = new THREE.Object3D();
  socket_eye_l_catchlight_0.name = "catchlight";
  socket_eye_l_catchlight_0.position.set(0.03, 0.03, 0.078);
  socket_eye_l_catchlight_0.rotation.set(0, 0, 0);
  socket_eye_l_catchlight_0.userData.socket = {"id": "catchlight", "localPosition": [0.03, 0.03, 0.078]};
  node_eye_l_2.add(socket_eye_l_catchlight_0);
  sockets["eye-l:catchlight"] = socket_eye_l_catchlight_0;

  const endpoint_catchlight_l_big_3 = makeAttachmentEndpoint(null);
  const node_catchlight_l_big_3 = new THREE.Group();
  node_catchlight_l_big_3.name = "Catchlight L big__pivot";
  node_catchlight_l_big_3.scale.set(1, 1, 1);
  if (endpoint_catchlight_l_big_3) {
    node_catchlight_l_big_3.position.copy(endpoint_catchlight_l_big_3.start);
    node_catchlight_l_big_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_catchlight_l_big_3.position.set(0.03, 0.032, 0.079);
    node_catchlight_l_big_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_catchlight_l_big_3.userData.sculptComponent = {"id": "catchlight-l-big", "name": "Catchlight L big", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "sphere", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "eye-l", "attachment": null, "dimensions": {"width": 0.04, "height": 0.04, "depth": 0.022, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.03, 0.032, 0.079], "rotation": [0, 0, 0], "scale": [0.046, 0.046, 0.022]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-l-big", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_catchlight_l_big_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-l-big", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["eye-l"] ?? root).add(node_catchlight_l_big_3);
  nodes["catchlight-l-big"] = node_catchlight_l_big_3;
  const mesh_catchlight_l_big_3Geometry = endpoint_catchlight_l_big_3
    ? new THREE.CylinderGeometry(endpoint_catchlight_l_big_3.endRadius, endpoint_catchlight_l_big_3.baseRadius, endpoint_catchlight_l_big_3.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_l_big_3) {
    mesh_catchlight_l_big_3Geometry.scale(0.046, 0.046, 0.022);
  }
  const mesh_catchlight_l_big_3 = new THREE.Mesh(
    mesh_catchlight_l_big_3Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_l_big_3.name = "Catchlight L big";
  if (endpoint_catchlight_l_big_3) {
    mesh_catchlight_l_big_3.position.copy(endpoint_catchlight_l_big_3.midpoint);
    mesh_catchlight_l_big_3.quaternion.copy(endpoint_catchlight_l_big_3.quaternion);
  }
  mesh_catchlight_l_big_3.castShadow = options.castShadow ?? true;
  mesh_catchlight_l_big_3.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_l_big_3.userData.sculptComponent = {"id": "catchlight-l-big", "name": "Catchlight L big", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "sphere", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "eye-l", "attachment": null, "dimensions": {"width": 0.04, "height": 0.04, "depth": 0.022, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.03, 0.032, 0.079], "rotation": [0, 0, 0], "scale": [0.046, 0.046, 0.022]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-l-big", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_catchlight_l_big_3.add(mesh_catchlight_l_big_3);
  meshes["catchlight-l-big"] = mesh_catchlight_l_big_3;
  colliders["catchlight-l-big"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-l-big"] ??= [];
  destructionGroups["catchlight-l-big"].push(node_catchlight_l_big_3);

  const endpoint_catchlight_l_small_4 = makeAttachmentEndpoint(null);
  const node_catchlight_l_small_4 = new THREE.Group();
  node_catchlight_l_small_4.name = "Catchlight L small__pivot";
  node_catchlight_l_small_4.scale.set(1, 1, 1);
  if (endpoint_catchlight_l_small_4) {
    node_catchlight_l_small_4.position.copy(endpoint_catchlight_l_small_4.start);
    node_catchlight_l_small_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_catchlight_l_small_4.position.set(-0.026, -0.03, 0.081);
    node_catchlight_l_small_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_catchlight_l_small_4.userData.sculptComponent = {"id": "catchlight-l-small", "name": "Catchlight L small", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "eye-l", "attachment": null, "dimensions": {"width": 0.018, "height": 0.018, "depth": 0.016, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.026, -0.03, 0.081], "rotation": [0, 0, 0], "scale": [0.02, 0.02, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.018, 0.018, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-l-small", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_catchlight_l_small_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.018, 0.018, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-l-small", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["eye-l"] ?? root).add(node_catchlight_l_small_4);
  nodes["catchlight-l-small"] = node_catchlight_l_small_4;
  const mesh_catchlight_l_small_4Geometry = endpoint_catchlight_l_small_4
    ? new THREE.CylinderGeometry(endpoint_catchlight_l_small_4.endRadius, endpoint_catchlight_l_small_4.baseRadius, endpoint_catchlight_l_small_4.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_l_small_4) {
    mesh_catchlight_l_small_4Geometry.scale(0.02, 0.02, 0.016);
  }
  const mesh_catchlight_l_small_4 = new THREE.Mesh(
    mesh_catchlight_l_small_4Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_l_small_4.name = "Catchlight L small";
  if (endpoint_catchlight_l_small_4) {
    mesh_catchlight_l_small_4.position.copy(endpoint_catchlight_l_small_4.midpoint);
    mesh_catchlight_l_small_4.quaternion.copy(endpoint_catchlight_l_small_4.quaternion);
  }
  mesh_catchlight_l_small_4.castShadow = options.castShadow ?? true;
  mesh_catchlight_l_small_4.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_l_small_4.userData.sculptComponent = {"id": "catchlight-l-small", "name": "Catchlight L small", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "eye-l", "attachment": null, "dimensions": {"width": 0.018, "height": 0.018, "depth": 0.016, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.026, -0.03, 0.081], "rotation": [0, 0, 0], "scale": [0.02, 0.02, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.018, 0.018, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-l-small", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_catchlight_l_small_4.add(mesh_catchlight_l_small_4);
  meshes["catchlight-l-small"] = mesh_catchlight_l_small_4;
  colliders["catchlight-l-small"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.018, 0.018, 0.01], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-l-small"] ??= [];
  destructionGroups["catchlight-l-small"].push(node_catchlight_l_small_4);

  const endpoint_eye_r_5 = makeAttachmentEndpoint(null);
  const node_eye_r_5 = new THREE.Group();
  node_eye_r_5.name = "Eye R__pivot";
  node_eye_r_5.scale.set(1, 1, 1);
  if (endpoint_eye_r_5) {
    node_eye_r_5.position.copy(endpoint_eye_r_5.start);
    node_eye_r_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_r_5.position.set(-0.169, 0.204, 0.258);
    node_eye_r_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_r_5.userData.sculptComponent = {"id": "eye-r", "name": "Eye R", "level": "meso", "role": "eye", "importance": 0.95, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "A discrete glossy sphere seated two-thirds proud of the face; the iris and dark rim are vertex-painted regions on the same sphere.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "eye-r", "contactType": "embed", "embedDepth": 0.05, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.168, "height": 0.168, "depth": 0.168, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.169, 0.204, 0.258], "rotation": [0, 0, 0], "scale": [0.168, 0.168, 0.168]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "catchlight", "localPosition": [-0.03, 0.03, 0.078]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.168, 0.168, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-gloss"}}, "material": "eye-gloss", "materialLayers": ["eye-gloss"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "catchlights", "kind": "emissive", "note": "two 4-point star catchlights (built as catchlight-* components)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "vertexPaint": {"baseColor": "#5aa0ff", "regions": [{"id": "iris-centre", "kind": "ellipsoid", "center": [0.0, 0.0, 0.084], "radii": [0.055, 0.055, 0.05], "softness": 0.04, "color": "#a8dcff"}, {"id": "outline-ring", "kind": "axis-band", "axis": "z", "min": -0.2, "max": 0.015, "softness": 0.008, "color": "#1c2a4d"}]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 160, 255, 1.0)", "secondaryAlbedo": "rgba(168, 220, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.8, "colorGradient": {"type": "radial", "stops": [{"t": 0.0, "color": "rgba(95, 180, 255, 1.0)"}, {"t": 1.0, "color": "rgba(33, 96, 214, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "glossy iris sphere with dark navy rim"}};
  node_eye_r_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "catchlight", "localPosition": [-0.03, 0.03, 0.078]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.168, 0.168, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-gloss"}};
  (nodes["body"] ?? root).add(node_eye_r_5);
  nodes["eye-r"] = node_eye_r_5;
  const mesh_eye_r_5Geometry = endpoint_eye_r_5
    ? new THREE.CylinderGeometry(endpoint_eye_r_5.endRadius, endpoint_eye_r_5.baseRadius, endpoint_eye_r_5.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_r_5) {
    mesh_eye_r_5Geometry.scale(0.168, 0.168, 0.168);
  }
  applyVertexPaint(mesh_eye_r_5Geometry, "#5aa0ff", [{"id": "iris-centre", "kind": "ellipsoid", "color": "#a8dcff", "softness": 0.04, "center": [0.0, 0.0, 0.084], "radii": [0.055, 0.055, 0.05]}, {"id": "outline-ring", "kind": "axis-band", "color": "#1c2a4d", "softness": 0.008, "axis": "z", "min": -0.2, "max": 0.015}]);
  const mesh_eye_r_5 = new THREE.Mesh(
    mesh_eye_r_5Geometry,
    materialMap["eye-gloss"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_r_5.name = "Eye R";
  mesh_eye_r_5.material = mesh_eye_r_5.material.clone();
  mesh_eye_r_5.material.vertexColors = true;
  (mesh_eye_r_5.material as THREE.MeshPhysicalMaterial).color.setRGB(1, 1, 1);
  if (endpoint_eye_r_5) {
    mesh_eye_r_5.position.copy(endpoint_eye_r_5.midpoint);
    mesh_eye_r_5.quaternion.copy(endpoint_eye_r_5.quaternion);
  }
  mesh_eye_r_5.castShadow = options.castShadow ?? true;
  mesh_eye_r_5.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_r_5.userData.sculptComponent = {"id": "eye-r", "name": "Eye R", "level": "meso", "role": "eye", "importance": 0.95, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "A discrete glossy sphere seated two-thirds proud of the face; the iris and dark rim are vertex-painted regions on the same sphere.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "eye-r", "contactType": "embed", "embedDepth": 0.05, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.168, "height": 0.168, "depth": 0.168, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.169, 0.204, 0.258], "rotation": [0, 0, 0], "scale": [0.168, 0.168, 0.168]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "catchlight", "localPosition": [-0.03, 0.03, 0.078]}], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.168, 0.168, 0.168], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye-gloss"}}, "material": "eye-gloss", "materialLayers": ["eye-gloss"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "catchlights", "kind": "emissive", "note": "two 4-point star catchlights (built as catchlight-* components)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "vertexPaint": {"baseColor": "#5aa0ff", "regions": [{"id": "iris-centre", "kind": "ellipsoid", "center": [0.0, 0.0, 0.084], "radii": [0.055, 0.055, 0.05], "softness": 0.04, "color": "#a8dcff"}, {"id": "outline-ring", "kind": "axis-band", "axis": "z", "min": -0.2, "max": 0.015, "softness": 0.008, "color": "#1c2a4d"}]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 160, 255, 1.0)", "secondaryAlbedo": "rgba(168, 220, 255, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.8, "colorGradient": {"type": "radial", "stops": [{"t": 0.0, "color": "rgba(95, 180, 255, 1.0)"}, {"t": 1.0, "color": "rgba(33, 96, 214, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "glossy iris sphere with dark navy rim"}};
  node_eye_r_5.add(mesh_eye_r_5);
  meshes["eye-r"] = mesh_eye_r_5;
  colliders["eye-r"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.168, 0.168, 0.168], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["eye-r"] ??= [];
  destructionGroups["eye-r"].push(node_eye_r_5);
  const socket_eye_r_catchlight_0 = new THREE.Object3D();
  socket_eye_r_catchlight_0.name = "catchlight";
  socket_eye_r_catchlight_0.position.set(-0.03, 0.03, 0.078);
  socket_eye_r_catchlight_0.rotation.set(0, 0, 0);
  socket_eye_r_catchlight_0.userData.socket = {"id": "catchlight", "localPosition": [-0.03, 0.03, 0.078]};
  node_eye_r_5.add(socket_eye_r_catchlight_0);
  sockets["eye-r:catchlight"] = socket_eye_r_catchlight_0;

  const endpoint_catchlight_r_big_6 = makeAttachmentEndpoint(null);
  const node_catchlight_r_big_6 = new THREE.Group();
  node_catchlight_r_big_6.name = "Catchlight R big__pivot";
  node_catchlight_r_big_6.scale.set(1, 1, 1);
  if (endpoint_catchlight_r_big_6) {
    node_catchlight_r_big_6.position.copy(endpoint_catchlight_r_big_6.start);
    node_catchlight_r_big_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_catchlight_r_big_6.position.set(-0.03, 0.032, 0.079);
    node_catchlight_r_big_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_catchlight_r_big_6.userData.sculptComponent = {"id": "catchlight-r-big", "name": "Catchlight R big", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "sphere", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "eye-r", "attachment": null, "dimensions": {"width": 0.04, "height": 0.04, "depth": 0.022, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.03, 0.032, 0.079], "rotation": [0, 0, 0], "scale": [0.046, 0.046, 0.022]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-r-big", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_catchlight_r_big_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-r-big", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["eye-r"] ?? root).add(node_catchlight_r_big_6);
  nodes["catchlight-r-big"] = node_catchlight_r_big_6;
  const mesh_catchlight_r_big_6Geometry = endpoint_catchlight_r_big_6
    ? new THREE.CylinderGeometry(endpoint_catchlight_r_big_6.endRadius, endpoint_catchlight_r_big_6.baseRadius, endpoint_catchlight_r_big_6.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_r_big_6) {
    mesh_catchlight_r_big_6Geometry.scale(0.046, 0.046, 0.022);
  }
  const mesh_catchlight_r_big_6 = new THREE.Mesh(
    mesh_catchlight_r_big_6Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_r_big_6.name = "Catchlight R big";
  if (endpoint_catchlight_r_big_6) {
    mesh_catchlight_r_big_6.position.copy(endpoint_catchlight_r_big_6.midpoint);
    mesh_catchlight_r_big_6.quaternion.copy(endpoint_catchlight_r_big_6.quaternion);
  }
  mesh_catchlight_r_big_6.castShadow = options.castShadow ?? true;
  mesh_catchlight_r_big_6.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_r_big_6.userData.sculptComponent = {"id": "catchlight-r-big", "name": "Catchlight R big", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.85, "primitive": "sphere", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "eye-r", "attachment": null, "dimensions": {"width": 0.04, "height": 0.04, "depth": 0.022, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.03, 0.032, 0.079], "rotation": [0, 0, 0], "scale": [0.046, 0.046, 0.022]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.012], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-r-big", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_catchlight_r_big_6.add(mesh_catchlight_r_big_6);
  meshes["catchlight-r-big"] = mesh_catchlight_r_big_6;
  colliders["catchlight-r-big"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.012], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-r-big"] ??= [];
  destructionGroups["catchlight-r-big"].push(node_catchlight_r_big_6);

  const endpoint_catchlight_r_small_7 = makeAttachmentEndpoint(null);
  const node_catchlight_r_small_7 = new THREE.Group();
  node_catchlight_r_small_7.name = "Catchlight R small__pivot";
  node_catchlight_r_small_7.scale.set(1, 1, 1);
  if (endpoint_catchlight_r_small_7) {
    node_catchlight_r_small_7.position.copy(endpoint_catchlight_r_small_7.start);
    node_catchlight_r_small_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_catchlight_r_small_7.position.set(0.026, -0.03, 0.081);
    node_catchlight_r_small_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_catchlight_r_small_7.userData.sculptComponent = {"id": "catchlight-r-small", "name": "Catchlight R small", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "eye-r", "attachment": null, "dimensions": {"width": 0.018, "height": 0.018, "depth": 0.016, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.026, -0.03, 0.081], "rotation": [0, 0, 0], "scale": [0.02, 0.02, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.018, 0.018, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-r-small", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_catchlight_r_small_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.018, 0.018, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-r-small", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}};
  (nodes["eye-r"] ?? root).add(node_catchlight_r_small_7);
  nodes["catchlight-r-small"] = node_catchlight_r_small_7;
  const mesh_catchlight_r_small_7Geometry = endpoint_catchlight_r_small_7
    ? new THREE.CylinderGeometry(endpoint_catchlight_r_small_7.endRadius, endpoint_catchlight_r_small_7.baseRadius, endpoint_catchlight_r_small_7.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_catchlight_r_small_7) {
    mesh_catchlight_r_small_7Geometry.scale(0.02, 0.02, 0.016);
  }
  const mesh_catchlight_r_small_7 = new THREE.Mesh(
    mesh_catchlight_r_small_7Geometry,
    materialMap["catchlight"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_r_small_7.name = "Catchlight R small";
  if (endpoint_catchlight_r_small_7) {
    mesh_catchlight_r_small_7.position.copy(endpoint_catchlight_r_small_7.midpoint);
    mesh_catchlight_r_small_7.quaternion.copy(endpoint_catchlight_r_small_7.quaternion);
  }
  mesh_catchlight_r_small_7.castShadow = options.castShadow ?? true;
  mesh_catchlight_r_small_7.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_r_small_7.userData.sculptComponent = {"id": "catchlight-r-small", "name": "Catchlight R small", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "eye-r", "attachment": null, "dimensions": {"width": 0.018, "height": 0.018, "depth": 0.016, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.026, -0.03, 0.081], "rotation": [0, 0, 0], "scale": [0.02, 0.02, 0.016]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.018, 0.018, 0.01], "isTrigger": false, "notes": "primitive proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-r-small", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "catchlight"}}, "material": "catchlight", "materialLayers": ["catchlight"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_catchlight_r_small_7.add(mesh_catchlight_r_small_7);
  meshes["catchlight-r-small"] = mesh_catchlight_r_small_7;
  colliders["catchlight-r-small"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.018, 0.018, 0.01], "isTrigger": false, "notes": "primitive proxy"};
  destructionGroups["catchlight-r-small"] ??= [];
  destructionGroups["catchlight-r-small"].push(node_catchlight_r_small_7);

  const attachment_arm_l_8 = {"parentSocket": "shoulder-l", "localStart": [0.35, -0.09, 0.02], "localEnd": [0.48, 0.03, 0.02], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.07, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_arm_l_8 = makeAttachmentEndpoint(attachment_arm_l_8);
  const node_arm_l_8 = new THREE.Group();
  node_arm_l_8.name = "Arm L__pivot";
  node_arm_l_8.scale.set(1, 1, 1);
  if (endpoint_arm_l_8) {
    node_arm_l_8.position.copy(endpoint_arm_l_8.start);
    node_arm_l_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_arm_l_8.position.set(0.35, -0.09, 0.02);
    node_arm_l_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_arm_l_8.userData.sculptComponent = {"id": "arm-l", "name": "Arm L", "level": "macro", "role": "arm", "importance": 0.85, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A stub capsule limb raised up-and-outward; built from its shoulder socket to the wrist.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "shoulder-l", "localStart": [0.35, -0.09, 0.02], "localEnd": [0.48, 0.03, 0.02], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.07, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.2, "depth": 0.19, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.35, -0.09, 0.02], "rotation": [0, 0, 0], "scale": [0.19, 0.2, 0.19]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "wrist", "localPosition": [0.13, 0.12, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.2, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_arm_l_8.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "wrist", "localPosition": [0.13, 0.12, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.2, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["body"] ?? root).add(node_arm_l_8);
  nodes["arm-l"] = node_arm_l_8;
  const mesh_arm_l_8Geometry = endpoint_arm_l_8
    ? new THREE.CylinderGeometry(endpoint_arm_l_8.endRadius, endpoint_arm_l_8.baseRadius, endpoint_arm_l_8.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_arm_l_8) {
    mesh_arm_l_8Geometry.scale(0.19, 0.2, 0.19);
  }
  const mesh_arm_l_8 = new THREE.SkinnedMesh(
    mesh_arm_l_8Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arm_l_8.name = "Arm L";
  if (endpoint_arm_l_8) {
    mesh_arm_l_8.position.copy(endpoint_arm_l_8.midpoint);
    mesh_arm_l_8.quaternion.copy(endpoint_arm_l_8.quaternion);
  }
  mesh_arm_l_8.castShadow = options.castShadow ?? true;
  mesh_arm_l_8.receiveShadow = options.receiveShadow ?? true;
  mesh_arm_l_8.userData.sculptComponent = {"id": "arm-l", "name": "Arm L", "level": "macro", "role": "arm", "importance": 0.85, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A stub capsule limb raised up-and-outward; built from its shoulder socket to the wrist.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "shoulder-l", "localStart": [0.35, -0.09, 0.02], "localEnd": [0.48, 0.03, 0.02], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.07, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.2, "depth": 0.19, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.35, -0.09, 0.02], "rotation": [0, 0, 0], "scale": [0.19, 0.2, 0.19]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "wrist", "localPosition": [0.13, 0.12, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.2, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_arm_l_8.add(mesh_arm_l_8);
  meshes["arm-l"] = mesh_arm_l_8;
  colliders["arm-l"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.2, 0.19], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["arm-l"] ??= [];
  destructionGroups["arm-l"].push(node_arm_l_8);
  const socket_arm_l_wrist_0 = new THREE.Object3D();
  socket_arm_l_wrist_0.name = "wrist";
  socket_arm_l_wrist_0.position.set(0.13, 0.12, 0.0);
  socket_arm_l_wrist_0.rotation.set(0, 0, 0);
  socket_arm_l_wrist_0.userData.socket = {"id": "wrist", "localPosition": [0.13, 0.12, 0]};
  node_arm_l_8.add(socket_arm_l_wrist_0);
  sockets["arm-l:wrist"] = socket_arm_l_wrist_0;

  const attachment_hand_l_9 = {"parentSocket": "wrist-l", "localStart": [0.48, 0.03, 0.02], "localEnd": [0.5, 0.12, 0.02], "contactType": "socket-joint", "baseRadius": 0.1, "endRadius": 0.08, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_hand_l_9 = makeAttachmentEndpoint(attachment_hand_l_9);
  const node_hand_l_9 = new THREE.Group();
  node_hand_l_9.name = "Hand L (mitten)__pivot";
  node_hand_l_9.scale.set(1, 1, 1);
  if (endpoint_hand_l_9) {
    node_hand_l_9.position.copy(endpoint_hand_l_9.start);
    node_hand_l_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_l_9.position.set(0.48, 0.03, 0.02);
    node_hand_l_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_l_9.userData.sculptComponent = {"id": "hand-l", "name": "Hand L (mitten)", "level": "meso", "role": "hand", "importance": 0.8, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short wide capsule mitten from the wrist to the fingertip line; the three nubs are separate micro capsules.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "wrist-l", "localStart": [0.48, 0.03, 0.02], "localEnd": [0.5, 0.12, 0.02], "contactType": "socket-joint", "baseRadius": 0.1, "endRadius": 0.08, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.1, "depth": 0.16, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.48, 0.03, 0.02], "rotation": [0, 0, 0], "scale": [0.2, 0.1, 0.16]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "nub-1", "localPosition": [0.0, 0.11, 0.0]}, {"id": "nub-2", "localPosition": [0.045, 0.1, 0.0]}, {"id": "nub-3", "localPosition": [0.08, 0.07, 0.0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.2, 0.1, 0.16], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "fingerNubs", "kind": "ridge", "note": "three rounded finger nubs pointing up/outward (components nub-*)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_hand_l_9.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "nub-1", "localPosition": [0.0, 0.11, 0.0]}, {"id": "nub-2", "localPosition": [0.045, 0.1, 0.0]}, {"id": "nub-3", "localPosition": [0.08, 0.07, 0.0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.2, 0.1, 0.16], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["body"] ?? root).add(node_hand_l_9);
  nodes["hand-l"] = node_hand_l_9;
  const mesh_hand_l_9Geometry = endpoint_hand_l_9
    ? new THREE.CylinderGeometry(endpoint_hand_l_9.endRadius, endpoint_hand_l_9.baseRadius, endpoint_hand_l_9.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_hand_l_9) {
    mesh_hand_l_9Geometry.scale(0.2, 0.1, 0.16);
  }
  const mesh_hand_l_9 = new THREE.SkinnedMesh(
    mesh_hand_l_9Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_l_9.name = "Hand L (mitten)";
  if (endpoint_hand_l_9) {
    mesh_hand_l_9.position.copy(endpoint_hand_l_9.midpoint);
    mesh_hand_l_9.quaternion.copy(endpoint_hand_l_9.quaternion);
  }
  mesh_hand_l_9.castShadow = options.castShadow ?? true;
  mesh_hand_l_9.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_l_9.userData.sculptComponent = {"id": "hand-l", "name": "Hand L (mitten)", "level": "meso", "role": "hand", "importance": 0.8, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short wide capsule mitten from the wrist to the fingertip line; the three nubs are separate micro capsules.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "wrist-l", "localStart": [0.48, 0.03, 0.02], "localEnd": [0.5, 0.12, 0.02], "contactType": "socket-joint", "baseRadius": 0.1, "endRadius": 0.08, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.1, "depth": 0.16, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.48, 0.03, 0.02], "rotation": [0, 0, 0], "scale": [0.2, 0.1, 0.16]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "nub-1", "localPosition": [0.0, 0.11, 0.0]}, {"id": "nub-2", "localPosition": [0.045, 0.1, 0.0]}, {"id": "nub-3", "localPosition": [0.08, 0.07, 0.0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.2, 0.1, 0.16], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "fingerNubs", "kind": "ridge", "note": "three rounded finger nubs pointing up/outward (components nub-*)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_hand_l_9.add(mesh_hand_l_9);
  meshes["hand-l"] = mesh_hand_l_9;
  colliders["hand-l"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.2, 0.1, 0.16], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["hand-l"] ??= [];
  destructionGroups["hand-l"].push(node_hand_l_9);
  const socket_hand_l_nub_1_0 = new THREE.Object3D();
  socket_hand_l_nub_1_0.name = "nub-1";
  socket_hand_l_nub_1_0.position.set(0.0, 0.11, 0.0);
  socket_hand_l_nub_1_0.rotation.set(0, 0, 0);
  socket_hand_l_nub_1_0.userData.socket = {"id": "nub-1", "localPosition": [0.0, 0.11, 0.0]};
  node_hand_l_9.add(socket_hand_l_nub_1_0);
  sockets["hand-l:nub-1"] = socket_hand_l_nub_1_0;
  const socket_hand_l_nub_2_1 = new THREE.Object3D();
  socket_hand_l_nub_2_1.name = "nub-2";
  socket_hand_l_nub_2_1.position.set(0.045, 0.1, 0.0);
  socket_hand_l_nub_2_1.rotation.set(0, 0, 0);
  socket_hand_l_nub_2_1.userData.socket = {"id": "nub-2", "localPosition": [0.045, 0.1, 0.0]};
  node_hand_l_9.add(socket_hand_l_nub_2_1);
  sockets["hand-l:nub-2"] = socket_hand_l_nub_2_1;
  const socket_hand_l_nub_3_2 = new THREE.Object3D();
  socket_hand_l_nub_3_2.name = "nub-3";
  socket_hand_l_nub_3_2.position.set(0.08, 0.07, 0.0);
  socket_hand_l_nub_3_2.rotation.set(0, 0, 0);
  socket_hand_l_nub_3_2.userData.socket = {"id": "nub-3", "localPosition": [0.08, 0.07, 0.0]};
  node_hand_l_9.add(socket_hand_l_nub_3_2);
  sockets["hand-l:nub-3"] = socket_hand_l_nub_3_2;

  const attachment_nub_l_1_10 = {"parentSocket": "nub-1", "localStart": [0.0, 0.11, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_nub_l_1_10 = makeAttachmentEndpoint(attachment_nub_l_1_10);
  const node_nub_l_1_10 = new THREE.Group();
  node_nub_l_1_10.name = "Finger nub L 1__pivot";
  node_nub_l_1_10.scale.set(1, 1, 1);
  if (endpoint_nub_l_1_10) {
    node_nub_l_1_10.position.copy(endpoint_nub_l_1_10.start);
    node_nub_l_1_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nub_l_1_10.position.set(0.0, 0.11, 0.0);
    node_nub_l_1_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_nub_l_1_10.userData.sculptComponent = {"id": "nub-l-1", "name": "Finger nub L 1", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "nub-1", "localStart": [0.0, 0.11, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.11, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_l_1_10.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["hand-l"] ?? root).add(node_nub_l_1_10);
  nodes["nub-l-1"] = node_nub_l_1_10;
  const mesh_nub_l_1_10Geometry = endpoint_nub_l_1_10
    ? new THREE.CylinderGeometry(endpoint_nub_l_1_10.endRadius, endpoint_nub_l_1_10.baseRadius, endpoint_nub_l_1_10.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_nub_l_1_10) {
    mesh_nub_l_1_10Geometry.scale(0.048, 0.06, 0.048);
  }
  const mesh_nub_l_1_10 = new THREE.SkinnedMesh(
    mesh_nub_l_1_10Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nub_l_1_10.name = "Finger nub L 1";
  if (endpoint_nub_l_1_10) {
    mesh_nub_l_1_10.position.copy(endpoint_nub_l_1_10.midpoint);
    mesh_nub_l_1_10.quaternion.copy(endpoint_nub_l_1_10.quaternion);
  }
  mesh_nub_l_1_10.castShadow = options.castShadow ?? true;
  mesh_nub_l_1_10.receiveShadow = options.receiveShadow ?? true;
  mesh_nub_l_1_10.userData.sculptComponent = {"id": "nub-l-1", "name": "Finger nub L 1", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "nub-1", "localStart": [0.0, 0.11, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.11, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_l_1_10.add(mesh_nub_l_1_10);
  meshes["nub-l-1"] = mesh_nub_l_1_10;
  colliders["nub-l-1"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["nub-l-1"] ??= [];
  destructionGroups["nub-l-1"].push(node_nub_l_1_10);

  const attachment_nub_l_2_11 = {"parentSocket": "nub-2", "localStart": [0.045, 0.1, 0.0], "localEnd": [0.07, 0.145, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_nub_l_2_11 = makeAttachmentEndpoint(attachment_nub_l_2_11);
  const node_nub_l_2_11 = new THREE.Group();
  node_nub_l_2_11.name = "Finger nub L 2__pivot";
  node_nub_l_2_11.scale.set(1, 1, 1);
  if (endpoint_nub_l_2_11) {
    node_nub_l_2_11.position.copy(endpoint_nub_l_2_11.start);
    node_nub_l_2_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nub_l_2_11.position.set(0.045, 0.1, 0.0);
    node_nub_l_2_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_nub_l_2_11.userData.sculptComponent = {"id": "nub-l-2", "name": "Finger nub L 2", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "nub-2", "localStart": [0.045, 0.1, 0.0], "localEnd": [0.07, 0.145, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.045, 0.1, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_l_2_11.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["hand-l"] ?? root).add(node_nub_l_2_11);
  nodes["nub-l-2"] = node_nub_l_2_11;
  const mesh_nub_l_2_11Geometry = endpoint_nub_l_2_11
    ? new THREE.CylinderGeometry(endpoint_nub_l_2_11.endRadius, endpoint_nub_l_2_11.baseRadius, endpoint_nub_l_2_11.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_nub_l_2_11) {
    mesh_nub_l_2_11Geometry.scale(0.048, 0.06, 0.048);
  }
  const mesh_nub_l_2_11 = new THREE.SkinnedMesh(
    mesh_nub_l_2_11Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nub_l_2_11.name = "Finger nub L 2";
  if (endpoint_nub_l_2_11) {
    mesh_nub_l_2_11.position.copy(endpoint_nub_l_2_11.midpoint);
    mesh_nub_l_2_11.quaternion.copy(endpoint_nub_l_2_11.quaternion);
  }
  mesh_nub_l_2_11.castShadow = options.castShadow ?? true;
  mesh_nub_l_2_11.receiveShadow = options.receiveShadow ?? true;
  mesh_nub_l_2_11.userData.sculptComponent = {"id": "nub-l-2", "name": "Finger nub L 2", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "nub-2", "localStart": [0.045, 0.1, 0.0], "localEnd": [0.07, 0.145, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.045, 0.1, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_l_2_11.add(mesh_nub_l_2_11);
  meshes["nub-l-2"] = mesh_nub_l_2_11;
  colliders["nub-l-2"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["nub-l-2"] ??= [];
  destructionGroups["nub-l-2"].push(node_nub_l_2_11);

  const attachment_nub_l_3_12 = {"parentSocket": "nub-3", "localStart": [0.08, 0.07, 0.0], "localEnd": [0.12, 0.095, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_nub_l_3_12 = makeAttachmentEndpoint(attachment_nub_l_3_12);
  const node_nub_l_3_12 = new THREE.Group();
  node_nub_l_3_12.name = "Finger nub L 3__pivot";
  node_nub_l_3_12.scale.set(1, 1, 1);
  if (endpoint_nub_l_3_12) {
    node_nub_l_3_12.position.copy(endpoint_nub_l_3_12.start);
    node_nub_l_3_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nub_l_3_12.position.set(0.08, 0.07, 0.0);
    node_nub_l_3_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_nub_l_3_12.userData.sculptComponent = {"id": "nub-l-3", "name": "Finger nub L 3", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "nub-3", "localStart": [0.08, 0.07, 0.0], "localEnd": [0.12, 0.095, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.08, 0.07, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_l_3_12.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["hand-l"] ?? root).add(node_nub_l_3_12);
  nodes["nub-l-3"] = node_nub_l_3_12;
  const mesh_nub_l_3_12Geometry = endpoint_nub_l_3_12
    ? new THREE.CylinderGeometry(endpoint_nub_l_3_12.endRadius, endpoint_nub_l_3_12.baseRadius, endpoint_nub_l_3_12.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_nub_l_3_12) {
    mesh_nub_l_3_12Geometry.scale(0.048, 0.06, 0.048);
  }
  const mesh_nub_l_3_12 = new THREE.SkinnedMesh(
    mesh_nub_l_3_12Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nub_l_3_12.name = "Finger nub L 3";
  if (endpoint_nub_l_3_12) {
    mesh_nub_l_3_12.position.copy(endpoint_nub_l_3_12.midpoint);
    mesh_nub_l_3_12.quaternion.copy(endpoint_nub_l_3_12.quaternion);
  }
  mesh_nub_l_3_12.castShadow = options.castShadow ?? true;
  mesh_nub_l_3_12.receiveShadow = options.receiveShadow ?? true;
  mesh_nub_l_3_12.userData.sculptComponent = {"id": "nub-l-3", "name": "Finger nub L 3", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "nub-3", "localStart": [0.08, 0.07, 0.0], "localEnd": [0.12, 0.095, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.08, 0.07, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_l_3_12.add(mesh_nub_l_3_12);
  meshes["nub-l-3"] = mesh_nub_l_3_12;
  colliders["nub-l-3"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["nub-l-3"] ??= [];
  destructionGroups["nub-l-3"].push(node_nub_l_3_12);

  const attachment_arm_r_13 = {"parentSocket": "shoulder-r", "localStart": [-0.35, -0.09, 0.02], "localEnd": [-0.48, 0.03, 0.02], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.07, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_arm_r_13 = makeAttachmentEndpoint(attachment_arm_r_13);
  const node_arm_r_13 = new THREE.Group();
  node_arm_r_13.name = "Arm R__pivot";
  node_arm_r_13.scale.set(1, 1, 1);
  if (endpoint_arm_r_13) {
    node_arm_r_13.position.copy(endpoint_arm_r_13.start);
    node_arm_r_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_arm_r_13.position.set(-0.35, -0.09, 0.02);
    node_arm_r_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_arm_r_13.userData.sculptComponent = {"id": "arm-r", "name": "Arm R", "level": "macro", "role": "arm", "importance": 0.85, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A stub capsule limb raised up-and-outward; built from its shoulder socket to the wrist.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "shoulder-r", "localStart": [-0.35, -0.09, 0.02], "localEnd": [-0.48, 0.03, 0.02], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.07, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.2, "depth": 0.19, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.35, -0.09, 0.02], "rotation": [0, 0, 0], "scale": [0.19, 0.2, 0.19]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "wrist", "localPosition": [-0.13, 0.12, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.2, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_arm_r_13.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "wrist", "localPosition": [-0.13, 0.12, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.2, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["body"] ?? root).add(node_arm_r_13);
  nodes["arm-r"] = node_arm_r_13;
  const mesh_arm_r_13Geometry = endpoint_arm_r_13
    ? new THREE.CylinderGeometry(endpoint_arm_r_13.endRadius, endpoint_arm_r_13.baseRadius, endpoint_arm_r_13.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_arm_r_13) {
    mesh_arm_r_13Geometry.scale(0.19, 0.2, 0.19);
  }
  const mesh_arm_r_13 = new THREE.SkinnedMesh(
    mesh_arm_r_13Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arm_r_13.name = "Arm R";
  if (endpoint_arm_r_13) {
    mesh_arm_r_13.position.copy(endpoint_arm_r_13.midpoint);
    mesh_arm_r_13.quaternion.copy(endpoint_arm_r_13.quaternion);
  }
  mesh_arm_r_13.castShadow = options.castShadow ?? true;
  mesh_arm_r_13.receiveShadow = options.receiveShadow ?? true;
  mesh_arm_r_13.userData.sculptComponent = {"id": "arm-r", "name": "Arm R", "level": "macro", "role": "arm", "importance": 0.85, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A stub capsule limb raised up-and-outward; built from its shoulder socket to the wrist.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "shoulder-r", "localStart": [-0.35, -0.09, 0.02], "localEnd": [-0.48, 0.03, 0.02], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.07, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.2, "depth": 0.19, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.35, -0.09, 0.02], "rotation": [0, 0, 0], "scale": [0.19, 0.2, 0.19]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "wrist", "localPosition": [-0.13, 0.12, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.2, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_arm_r_13.add(mesh_arm_r_13);
  meshes["arm-r"] = mesh_arm_r_13;
  colliders["arm-r"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.2, 0.19], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["arm-r"] ??= [];
  destructionGroups["arm-r"].push(node_arm_r_13);
  const socket_arm_r_wrist_0 = new THREE.Object3D();
  socket_arm_r_wrist_0.name = "wrist";
  socket_arm_r_wrist_0.position.set(-0.13, 0.12, 0.0);
  socket_arm_r_wrist_0.rotation.set(0, 0, 0);
  socket_arm_r_wrist_0.userData.socket = {"id": "wrist", "localPosition": [-0.13, 0.12, 0]};
  node_arm_r_13.add(socket_arm_r_wrist_0);
  sockets["arm-r:wrist"] = socket_arm_r_wrist_0;

  const attachment_hand_r_14 = {"parentSocket": "wrist-r", "localStart": [-0.48, 0.03, 0.02], "localEnd": [-0.5, 0.12, 0.02], "contactType": "socket-joint", "baseRadius": 0.1, "endRadius": 0.08, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_hand_r_14 = makeAttachmentEndpoint(attachment_hand_r_14);
  const node_hand_r_14 = new THREE.Group();
  node_hand_r_14.name = "Hand R (mitten)__pivot";
  node_hand_r_14.scale.set(1, 1, 1);
  if (endpoint_hand_r_14) {
    node_hand_r_14.position.copy(endpoint_hand_r_14.start);
    node_hand_r_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_r_14.position.set(-0.48, 0.03, 0.02);
    node_hand_r_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_r_14.userData.sculptComponent = {"id": "hand-r", "name": "Hand R (mitten)", "level": "meso", "role": "hand", "importance": 0.8, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short wide capsule mitten from the wrist to the fingertip line; the three nubs are separate micro capsules.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "wrist-r", "localStart": [-0.48, 0.03, 0.02], "localEnd": [-0.5, 0.12, 0.02], "contactType": "socket-joint", "baseRadius": 0.1, "endRadius": 0.08, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.1, "depth": 0.16, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.48, 0.03, 0.02], "rotation": [0, 0, 0], "scale": [0.2, 0.1, 0.16]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "nub-1", "localPosition": [-0.0, 0.11, 0.0]}, {"id": "nub-2", "localPosition": [-0.045, 0.1, 0.0]}, {"id": "nub-3", "localPosition": [-0.08, 0.07, 0.0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.2, 0.1, 0.16], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "fingerNubs", "kind": "ridge", "note": "three rounded finger nubs pointing up/outward (components nub-*)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_hand_r_14.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "nub-1", "localPosition": [-0.0, 0.11, 0.0]}, {"id": "nub-2", "localPosition": [-0.045, 0.1, 0.0]}, {"id": "nub-3", "localPosition": [-0.08, 0.07, 0.0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.2, 0.1, 0.16], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["body"] ?? root).add(node_hand_r_14);
  nodes["hand-r"] = node_hand_r_14;
  const mesh_hand_r_14Geometry = endpoint_hand_r_14
    ? new THREE.CylinderGeometry(endpoint_hand_r_14.endRadius, endpoint_hand_r_14.baseRadius, endpoint_hand_r_14.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_hand_r_14) {
    mesh_hand_r_14Geometry.scale(0.2, 0.1, 0.16);
  }
  const mesh_hand_r_14 = new THREE.SkinnedMesh(
    mesh_hand_r_14Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_r_14.name = "Hand R (mitten)";
  if (endpoint_hand_r_14) {
    mesh_hand_r_14.position.copy(endpoint_hand_r_14.midpoint);
    mesh_hand_r_14.quaternion.copy(endpoint_hand_r_14.quaternion);
  }
  mesh_hand_r_14.castShadow = options.castShadow ?? true;
  mesh_hand_r_14.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_r_14.userData.sculptComponent = {"id": "hand-r", "name": "Hand R (mitten)", "level": "meso", "role": "hand", "importance": 0.8, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short wide capsule mitten from the wrist to the fingertip line; the three nubs are separate micro capsules.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "wrist-r", "localStart": [-0.48, 0.03, 0.02], "localEnd": [-0.5, 0.12, 0.02], "contactType": "socket-joint", "baseRadius": 0.1, "endRadius": 0.08, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.1, "depth": 0.16, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.48, 0.03, 0.02], "rotation": [0, 0, 0], "scale": [0.2, 0.1, 0.16]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "nub-1", "localPosition": [-0.0, 0.11, 0.0]}, {"id": "nub-2", "localPosition": [-0.045, 0.1, 0.0]}, {"id": "nub-3", "localPosition": [-0.08, 0.07, 0.0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.2, 0.1, 0.16], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "fingerNubs", "kind": "ridge", "note": "three rounded finger nubs pointing up/outward (components nub-*)"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_hand_r_14.add(mesh_hand_r_14);
  meshes["hand-r"] = mesh_hand_r_14;
  colliders["hand-r"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.2, 0.1, 0.16], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["hand-r"] ??= [];
  destructionGroups["hand-r"].push(node_hand_r_14);
  const socket_hand_r_nub_1_0 = new THREE.Object3D();
  socket_hand_r_nub_1_0.name = "nub-1";
  socket_hand_r_nub_1_0.position.set(-0.0, 0.11, 0.0);
  socket_hand_r_nub_1_0.rotation.set(0, 0, 0);
  socket_hand_r_nub_1_0.userData.socket = {"id": "nub-1", "localPosition": [-0.0, 0.11, 0.0]};
  node_hand_r_14.add(socket_hand_r_nub_1_0);
  sockets["hand-r:nub-1"] = socket_hand_r_nub_1_0;
  const socket_hand_r_nub_2_1 = new THREE.Object3D();
  socket_hand_r_nub_2_1.name = "nub-2";
  socket_hand_r_nub_2_1.position.set(-0.045, 0.1, 0.0);
  socket_hand_r_nub_2_1.rotation.set(0, 0, 0);
  socket_hand_r_nub_2_1.userData.socket = {"id": "nub-2", "localPosition": [-0.045, 0.1, 0.0]};
  node_hand_r_14.add(socket_hand_r_nub_2_1);
  sockets["hand-r:nub-2"] = socket_hand_r_nub_2_1;
  const socket_hand_r_nub_3_2 = new THREE.Object3D();
  socket_hand_r_nub_3_2.name = "nub-3";
  socket_hand_r_nub_3_2.position.set(-0.08, 0.07, 0.0);
  socket_hand_r_nub_3_2.rotation.set(0, 0, 0);
  socket_hand_r_nub_3_2.userData.socket = {"id": "nub-3", "localPosition": [-0.08, 0.07, 0.0]};
  node_hand_r_14.add(socket_hand_r_nub_3_2);
  sockets["hand-r:nub-3"] = socket_hand_r_nub_3_2;

  const attachment_nub_r_1_15 = {"parentSocket": "nub-1", "localStart": [-0.0, 0.11, 0.0], "localEnd": [-0.0, 0.16, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_nub_r_1_15 = makeAttachmentEndpoint(attachment_nub_r_1_15);
  const node_nub_r_1_15 = new THREE.Group();
  node_nub_r_1_15.name = "Finger nub R 1__pivot";
  node_nub_r_1_15.scale.set(1, 1, 1);
  if (endpoint_nub_r_1_15) {
    node_nub_r_1_15.position.copy(endpoint_nub_r_1_15.start);
    node_nub_r_1_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nub_r_1_15.position.set(-0.0, 0.11, 0.0);
    node_nub_r_1_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_nub_r_1_15.userData.sculptComponent = {"id": "nub-r-1", "name": "Finger nub R 1", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "nub-1", "localStart": [-0.0, 0.11, 0.0], "localEnd": [-0.0, 0.16, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0, 0.11, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_r_1_15.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["hand-r"] ?? root).add(node_nub_r_1_15);
  nodes["nub-r-1"] = node_nub_r_1_15;
  const mesh_nub_r_1_15Geometry = endpoint_nub_r_1_15
    ? new THREE.CylinderGeometry(endpoint_nub_r_1_15.endRadius, endpoint_nub_r_1_15.baseRadius, endpoint_nub_r_1_15.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_nub_r_1_15) {
    mesh_nub_r_1_15Geometry.scale(0.048, 0.06, 0.048);
  }
  const mesh_nub_r_1_15 = new THREE.SkinnedMesh(
    mesh_nub_r_1_15Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nub_r_1_15.name = "Finger nub R 1";
  if (endpoint_nub_r_1_15) {
    mesh_nub_r_1_15.position.copy(endpoint_nub_r_1_15.midpoint);
    mesh_nub_r_1_15.quaternion.copy(endpoint_nub_r_1_15.quaternion);
  }
  mesh_nub_r_1_15.castShadow = options.castShadow ?? true;
  mesh_nub_r_1_15.receiveShadow = options.receiveShadow ?? true;
  mesh_nub_r_1_15.userData.sculptComponent = {"id": "nub-r-1", "name": "Finger nub R 1", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "nub-1", "localStart": [-0.0, 0.11, 0.0], "localEnd": [-0.0, 0.16, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0, 0.11, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_r_1_15.add(mesh_nub_r_1_15);
  meshes["nub-r-1"] = mesh_nub_r_1_15;
  colliders["nub-r-1"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["nub-r-1"] ??= [];
  destructionGroups["nub-r-1"].push(node_nub_r_1_15);

  const attachment_nub_r_2_16 = {"parentSocket": "nub-2", "localStart": [-0.045, 0.1, 0.0], "localEnd": [-0.07, 0.145, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_nub_r_2_16 = makeAttachmentEndpoint(attachment_nub_r_2_16);
  const node_nub_r_2_16 = new THREE.Group();
  node_nub_r_2_16.name = "Finger nub R 2__pivot";
  node_nub_r_2_16.scale.set(1, 1, 1);
  if (endpoint_nub_r_2_16) {
    node_nub_r_2_16.position.copy(endpoint_nub_r_2_16.start);
    node_nub_r_2_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nub_r_2_16.position.set(-0.045, 0.1, 0.0);
    node_nub_r_2_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_nub_r_2_16.userData.sculptComponent = {"id": "nub-r-2", "name": "Finger nub R 2", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "nub-2", "localStart": [-0.045, 0.1, 0.0], "localEnd": [-0.07, 0.145, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.045, 0.1, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_r_2_16.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["hand-r"] ?? root).add(node_nub_r_2_16);
  nodes["nub-r-2"] = node_nub_r_2_16;
  const mesh_nub_r_2_16Geometry = endpoint_nub_r_2_16
    ? new THREE.CylinderGeometry(endpoint_nub_r_2_16.endRadius, endpoint_nub_r_2_16.baseRadius, endpoint_nub_r_2_16.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_nub_r_2_16) {
    mesh_nub_r_2_16Geometry.scale(0.048, 0.06, 0.048);
  }
  const mesh_nub_r_2_16 = new THREE.SkinnedMesh(
    mesh_nub_r_2_16Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nub_r_2_16.name = "Finger nub R 2";
  if (endpoint_nub_r_2_16) {
    mesh_nub_r_2_16.position.copy(endpoint_nub_r_2_16.midpoint);
    mesh_nub_r_2_16.quaternion.copy(endpoint_nub_r_2_16.quaternion);
  }
  mesh_nub_r_2_16.castShadow = options.castShadow ?? true;
  mesh_nub_r_2_16.receiveShadow = options.receiveShadow ?? true;
  mesh_nub_r_2_16.userData.sculptComponent = {"id": "nub-r-2", "name": "Finger nub R 2", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "nub-2", "localStart": [-0.045, 0.1, 0.0], "localEnd": [-0.07, 0.145, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.045, 0.1, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_r_2_16.add(mesh_nub_r_2_16);
  meshes["nub-r-2"] = mesh_nub_r_2_16;
  colliders["nub-r-2"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["nub-r-2"] ??= [];
  destructionGroups["nub-r-2"].push(node_nub_r_2_16);

  const attachment_nub_r_3_17 = {"parentSocket": "nub-3", "localStart": [-0.08, 0.07, 0.0], "localEnd": [-0.12, 0.095, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_nub_r_3_17 = makeAttachmentEndpoint(attachment_nub_r_3_17);
  const node_nub_r_3_17 = new THREE.Group();
  node_nub_r_3_17.name = "Finger nub R 3__pivot";
  node_nub_r_3_17.scale.set(1, 1, 1);
  if (endpoint_nub_r_3_17) {
    node_nub_r_3_17.position.copy(endpoint_nub_r_3_17.start);
    node_nub_r_3_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nub_r_3_17.position.set(-0.08, 0.07, 0.0);
    node_nub_r_3_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_nub_r_3_17.userData.sculptComponent = {"id": "nub-r-3", "name": "Finger nub R 3", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "nub-3", "localStart": [-0.08, 0.07, 0.0], "localEnd": [-0.12, 0.095, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.08, 0.07, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_r_3_17.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["hand-r"] ?? root).add(node_nub_r_3_17);
  nodes["nub-r-3"] = node_nub_r_3_17;
  const mesh_nub_r_3_17Geometry = endpoint_nub_r_3_17
    ? new THREE.CylinderGeometry(endpoint_nub_r_3_17.endRadius, endpoint_nub_r_3_17.baseRadius, endpoint_nub_r_3_17.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_nub_r_3_17) {
    mesh_nub_r_3_17Geometry.scale(0.048, 0.06, 0.048);
  }
  const mesh_nub_r_3_17 = new THREE.SkinnedMesh(
    mesh_nub_r_3_17Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nub_r_3_17.name = "Finger nub R 3";
  if (endpoint_nub_r_3_17) {
    mesh_nub_r_3_17.position.copy(endpoint_nub_r_3_17.midpoint);
    mesh_nub_r_3_17.quaternion.copy(endpoint_nub_r_3_17.quaternion);
  }
  mesh_nub_r_3_17.castShadow = options.castShadow ?? true;
  mesh_nub_r_3_17.receiveShadow = options.receiveShadow ?? true;
  mesh_nub_r_3_17.userData.sculptComponent = {"id": "nub-r-3", "name": "Finger nub R 3", "level": "micro", "role": "finger", "importance": 0.45, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A short rounded capsule nub on the mitten edge.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "nub-3", "localStart": [-0.08, 0.07, 0.0], "localEnd": [-0.12, 0.095, 0.0], "contactType": "socket-joint", "baseRadius": 0.024, "endRadius": 0.02, "embedDepth": 0.015, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.048, "height": 0.06, "depth": 0.048, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.08, 0.07, 0.0], "rotation": [0, 0, 0], "scale": [0.048, 0.06, 0.048]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nub-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_nub_r_3_17.add(mesh_nub_r_3_17);
  meshes["nub-r-3"] = mesh_nub_r_3_17;
  colliders["nub-r-3"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.036, 0.05, 0.036], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["nub-r-3"] ??= [];
  destructionGroups["nub-r-3"].push(node_nub_r_3_17);

  const attachment_foot_l_18 = {"parentSocket": "hip-l", "localStart": [0.245, -0.4, 0.0], "localEnd": [0.26, -0.475, 0.0], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_foot_l_18 = makeAttachmentEndpoint(attachment_foot_l_18);
  const node_foot_l_18 = new THREE.Group();
  node_foot_l_18.name = "Foot L__pivot";
  node_foot_l_18.scale.set(1, 1, 1);
  if (endpoint_foot_l_18) {
    node_foot_l_18.position.copy(endpoint_foot_l_18.start);
    node_foot_l_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foot_l_18.position.set(0.245, -0.4, 0.0);
    node_foot_l_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_foot_l_18.userData.sculptComponent = {"id": "foot-l", "name": "Foot L", "level": "macro", "role": "leg", "importance": 0.75, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A stub capsule foot emerging under the body base and splayed slightly outward; its rounded end is the sole.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "hip-l", "localStart": [0.245, -0.4, 0.0], "localEnd": [0.26, -0.475, 0.0], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.17, "depth": 0.19, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.245, -0.4, 0.0], "rotation": [0, 0, 0], "scale": [0.19, 0.17, 0.19]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "sole", "localPosition": [0.017000000000000015, -0.15299999999999997, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.17, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_foot_l_18.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "sole", "localPosition": [0.017000000000000015, -0.15299999999999997, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.17, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["body"] ?? root).add(node_foot_l_18);
  nodes["foot-l"] = node_foot_l_18;
  const mesh_foot_l_18Geometry = endpoint_foot_l_18
    ? new THREE.CylinderGeometry(endpoint_foot_l_18.endRadius, endpoint_foot_l_18.baseRadius, endpoint_foot_l_18.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_foot_l_18) {
    mesh_foot_l_18Geometry.scale(0.19, 0.17, 0.19);
  }
  const mesh_foot_l_18 = new THREE.SkinnedMesh(
    mesh_foot_l_18Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_l_18.name = "Foot L";
  if (endpoint_foot_l_18) {
    mesh_foot_l_18.position.copy(endpoint_foot_l_18.midpoint);
    mesh_foot_l_18.quaternion.copy(endpoint_foot_l_18.quaternion);
  }
  mesh_foot_l_18.castShadow = options.castShadow ?? true;
  mesh_foot_l_18.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_l_18.userData.sculptComponent = {"id": "foot-l", "name": "Foot L", "level": "macro", "role": "leg", "importance": 0.75, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A stub capsule foot emerging under the body base and splayed slightly outward; its rounded end is the sole.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "hip-l", "localStart": [0.245, -0.4, 0.0], "localEnd": [0.26, -0.475, 0.0], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.17, "depth": 0.19, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.245, -0.4, 0.0], "rotation": [0, 0, 0], "scale": [0.19, 0.17, 0.19]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "sole", "localPosition": [0.017000000000000015, -0.15299999999999997, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.17, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_foot_l_18.add(mesh_foot_l_18);
  meshes["foot-l"] = mesh_foot_l_18;
  colliders["foot-l"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.17, 0.19], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["foot-l"] ??= [];
  destructionGroups["foot-l"].push(node_foot_l_18);
  const socket_foot_l_sole_0 = new THREE.Object3D();
  socket_foot_l_sole_0.name = "sole";
  socket_foot_l_sole_0.position.set(0.017000000000000015, -0.15299999999999997, 0.0);
  socket_foot_l_sole_0.rotation.set(0, 0, 0);
  socket_foot_l_sole_0.userData.socket = {"id": "sole", "localPosition": [0.017000000000000015, -0.15299999999999997, 0]};
  node_foot_l_18.add(socket_foot_l_sole_0);
  sockets["foot-l:sole"] = socket_foot_l_sole_0;

  const attachment_foot_r_19 = {"parentSocket": "hip-r", "localStart": [-0.245, -0.4, 0.0], "localEnd": [-0.26, -0.475, 0.0], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]};
  const endpoint_foot_r_19 = makeAttachmentEndpoint(attachment_foot_r_19);
  const node_foot_r_19 = new THREE.Group();
  node_foot_r_19.name = "Foot R__pivot";
  node_foot_r_19.scale.set(1, 1, 1);
  if (endpoint_foot_r_19) {
    node_foot_r_19.position.copy(endpoint_foot_r_19.start);
    node_foot_r_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foot_r_19.position.set(-0.245, -0.4, 0.0);
    node_foot_r_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_foot_r_19.userData.sculptComponent = {"id": "foot-r", "name": "Foot R", "level": "macro", "role": "leg", "importance": 0.75, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A stub capsule foot emerging under the body base and splayed slightly outward; its rounded end is the sole.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "hip-r", "localStart": [-0.245, -0.4, 0.0], "localEnd": [-0.26, -0.475, 0.0], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.17, "depth": 0.19, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.245, -0.4, 0.0], "rotation": [0, 0, 0], "scale": [0.19, 0.17, 0.19]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "sole", "localPosition": [-0.017000000000000015, -0.15299999999999997, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.17, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_foot_r_19.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "sole", "localPosition": [-0.017000000000000015, -0.15299999999999997, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.17, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}};
  (nodes["body"] ?? root).add(node_foot_r_19);
  nodes["foot-r"] = node_foot_r_19;
  const mesh_foot_r_19Geometry = endpoint_foot_r_19
    ? new THREE.CylinderGeometry(endpoint_foot_r_19.endRadius, endpoint_foot_r_19.baseRadius, endpoint_foot_r_19.length, 16, 6)
    : buildWatertightCapsule(0.35, 0.7, 8, 16, 1);
  if (!endpoint_foot_r_19) {
    mesh_foot_r_19Geometry.scale(0.19, 0.17, 0.19);
  }
  const mesh_foot_r_19 = new THREE.SkinnedMesh(
    mesh_foot_r_19Geometry,
    materialMap["body-skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_r_19.name = "Foot R";
  if (endpoint_foot_r_19) {
    mesh_foot_r_19.position.copy(endpoint_foot_r_19.midpoint);
    mesh_foot_r_19.quaternion.copy(endpoint_foot_r_19.quaternion);
  }
  mesh_foot_r_19.castShadow = options.castShadow ?? true;
  mesh_foot_r_19.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_r_19.userData.sculptComponent = {"id": "foot-r", "name": "Foot R", "level": "macro", "role": "leg", "importance": 0.75, "confidence": 0.75, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "A stub capsule foot emerging under the body base and splayed slightly outward; its rounded end is the sole.", "geometryDescriptor": {"topologyIntent": "stylized chibi character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "hip-r", "localStart": [-0.245, -0.4, 0.0], "localEnd": [-0.26, -0.475, 0.0], "contactType": "socket-joint", "baseRadius": 0.095, "endRadius": 0.085, "embedDepth": 0.06, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.17, "depth": 0.19, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.245, -0.4, 0.0], "rotation": [0, 0, 0], "scale": [0.19, 0.17, 0.19]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "branch-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [{"id": "sole", "localPosition": [-0.017000000000000015, -0.15299999999999997, 0]}], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.17, 0.19], "isTrigger": false, "notes": "capsule proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "body-skin"}}, "material": "body-skin", "materialLayers": ["body-skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 166, 255, 1.0)", "secondaryAlbedo": "rgba(168, 137, 242, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(143, 111, 224, 1.0)"}, {"t": 0.5, "color": "rgba(181, 140, 240, 1.0)"}, {"t": 1.0, "color": "rgba(203, 170, 255, 1.0)"}]}, "evidenceRefs": ["full-object"], "notes": "satin airbrushed sticker fill; cheeks/belly/mouth are vertex-painted regions"}};
  node_foot_r_19.add(mesh_foot_r_19);
  meshes["foot-r"] = mesh_foot_r_19;
  colliders["foot-r"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [0.19, 0.17, 0.19], "isTrigger": false, "notes": "capsule proxy"};
  destructionGroups["foot-r"] ??= [];
  destructionGroups["foot-r"].push(node_foot_r_19);
  const socket_foot_r_sole_0 = new THREE.Object3D();
  socket_foot_r_sole_0.name = "sole";
  socket_foot_r_sole_0.position.set(-0.017000000000000015, -0.15299999999999997, 0.0);
  socket_foot_r_sole_0.rotation.set(0, 0, 0);
  socket_foot_r_sole_0.userData.socket = {"id": "sole", "localPosition": [-0.017000000000000015, -0.15299999999999997, 0]};
  node_foot_r_19.add(socket_foot_r_sole_0);
  sockets["foot-r:sole"] = socket_foot_r_sole_0;

  const endpoint_cheek_l_20 = makeAttachmentEndpoint(null);
  const node_cheek_l_20 = new THREE.Group();
  node_cheek_l_20.name = "Cheek blush L__pivot";
  node_cheek_l_20.scale.set(1, 1, 1);
  if (endpoint_cheek_l_20) {
    node_cheek_l_20.position.copy(endpoint_cheek_l_20.start);
    node_cheek_l_20.rotation.set(-0.12, 0.72, 0.0);
  } else {
    node_cheek_l_20.position.set(0.268, 0.076, 0.25);
    node_cheek_l_20.rotation.set(-0.12, 0.72, 0.0);
  }
  node_cheek_l_20.userData.sculptComponent = {"id": "cheek-l", "name": "Cheek blush L", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "surface marking", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "cheek-l", "contactType": "embed", "embedDepth": 0.015, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.15, "height": 0.085, "depth": 0.04, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.268, 0.076, 0.25], "rotation": [-0.12, 0.72, 0.0], "scale": [0.15, 0.085, 0.04]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.14, 0.08, 0.035], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "feature-placement"};
  node_cheek_l_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.14, 0.08, 0.035], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}};
  (nodes["body"] ?? root).add(node_cheek_l_20);
  nodes["cheek-l"] = node_cheek_l_20;
  const mesh_cheek_l_20Geometry = endpoint_cheek_l_20
    ? new THREE.CylinderGeometry(endpoint_cheek_l_20.endRadius, endpoint_cheek_l_20.baseRadius, endpoint_cheek_l_20.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_cheek_l_20) {
    mesh_cheek_l_20Geometry.scale(0.15, 0.085, 0.04);
  }
  const mesh_cheek_l_20 = new THREE.Mesh(
    mesh_cheek_l_20Geometry,
    materialMap["cheek-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cheek_l_20.name = "Cheek blush L";
  if (endpoint_cheek_l_20) {
    mesh_cheek_l_20.position.copy(endpoint_cheek_l_20.midpoint);
    mesh_cheek_l_20.quaternion.copy(endpoint_cheek_l_20.quaternion);
  }
  mesh_cheek_l_20.castShadow = options.castShadow ?? true;
  mesh_cheek_l_20.receiveShadow = options.receiveShadow ?? true;
  mesh_cheek_l_20.userData.sculptComponent = {"id": "cheek-l", "name": "Cheek blush L", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "surface marking", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "cheek-l", "contactType": "embed", "embedDepth": 0.015, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.15, "height": 0.085, "depth": 0.04, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.268, 0.076, 0.25], "rotation": [-0.12, 0.72, 0.0], "scale": [0.15, 0.085, 0.04]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.14, 0.08, 0.035], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "feature-placement"};
  node_cheek_l_20.add(mesh_cheek_l_20);
  meshes["cheek-l"] = mesh_cheek_l_20;
  colliders["cheek-l"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.14, 0.08, 0.035], "isTrigger": false, "notes": "marking proxy"};
  destructionGroups["cheek-l"] ??= [];
  destructionGroups["cheek-l"].push(node_cheek_l_20);

  const endpoint_cheek_r_21 = makeAttachmentEndpoint(null);
  const node_cheek_r_21 = new THREE.Group();
  node_cheek_r_21.name = "Cheek blush R__pivot";
  node_cheek_r_21.scale.set(1, 1, 1);
  if (endpoint_cheek_r_21) {
    node_cheek_r_21.position.copy(endpoint_cheek_r_21.start);
    node_cheek_r_21.rotation.set(-0.12, -0.72, 0.0);
  } else {
    node_cheek_r_21.position.set(-0.268, 0.076, 0.25);
    node_cheek_r_21.rotation.set(-0.12, -0.72, 0.0);
  }
  node_cheek_r_21.userData.sculptComponent = {"id": "cheek-r", "name": "Cheek blush R", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "surface marking", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "cheek-r", "contactType": "embed", "embedDepth": 0.015, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.15, "height": 0.085, "depth": 0.04, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.268, 0.076, 0.25], "rotation": [-0.12, -0.72, 0.0], "scale": [0.15, 0.085, 0.04]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.14, 0.08, 0.035], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "feature-placement"};
  node_cheek_r_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.14, 0.08, 0.035], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}};
  (nodes["body"] ?? root).add(node_cheek_r_21);
  nodes["cheek-r"] = node_cheek_r_21;
  const mesh_cheek_r_21Geometry = endpoint_cheek_r_21
    ? new THREE.CylinderGeometry(endpoint_cheek_r_21.endRadius, endpoint_cheek_r_21.baseRadius, endpoint_cheek_r_21.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_cheek_r_21) {
    mesh_cheek_r_21Geometry.scale(0.15, 0.085, 0.04);
  }
  const mesh_cheek_r_21 = new THREE.Mesh(
    mesh_cheek_r_21Geometry,
    materialMap["cheek-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cheek_r_21.name = "Cheek blush R";
  if (endpoint_cheek_r_21) {
    mesh_cheek_r_21.position.copy(endpoint_cheek_r_21.midpoint);
    mesh_cheek_r_21.quaternion.copy(endpoint_cheek_r_21.quaternion);
  }
  mesh_cheek_r_21.castShadow = options.castShadow ?? true;
  mesh_cheek_r_21.receiveShadow = options.receiveShadow ?? true;
  mesh_cheek_r_21.userData.sculptComponent = {"id": "cheek-r", "name": "Cheek blush R", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "surface marking", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "cheek-r", "contactType": "embed", "embedDepth": 0.015, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.15, "height": 0.085, "depth": 0.04, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.268, 0.076, 0.25], "rotation": [-0.12, -0.72, 0.0], "scale": [0.15, 0.085, 0.04]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.14, 0.08, 0.035], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cheek-pink"}}, "material": "cheek-pink", "materialLayers": ["cheek-pink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "feature-placement"};
  node_cheek_r_21.add(mesh_cheek_r_21);
  meshes["cheek-r"] = mesh_cheek_r_21;
  colliders["cheek-r"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.14, 0.08, 0.035], "isTrigger": false, "notes": "marking proxy"};
  destructionGroups["cheek-r"] ??= [];
  destructionGroups["cheek-r"].push(node_cheek_r_21);

  const endpoint_mouth_22 = makeAttachmentEndpoint(null);
  const node_mouth_22 = new THREE.Group();
  node_mouth_22.name = "Smile arc__pivot";
  node_mouth_22.scale.set(1, 1, 1);
  if (endpoint_mouth_22) {
    node_mouth_22.position.copy(endpoint_mouth_22.start);
    node_mouth_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mouth_22.position.set(0.0, 0.0, 0.0);
    node_mouth_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_mouth_22.userData.sculptComponent = {"id": "mouth", "name": "Smile arc", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin tapered sweep so the line stays crisp.", "geometryDescriptor": {"topologyIntent": "surface marking", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.19, 0.085, 0.2958], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.18, 0.072, 0.301], "rx": 0.006, "rz": 0.0045, "twist": 0.0}, {"position": [-0.15, 0.045, 0.3144], "rx": 0.0085, "rz": 0.0064, "twist": 0.0}, {"position": [-0.09, 0.016, 0.3329], "rx": 0.009, "rz": 0.0067, "twist": 0.0}, {"position": [0.0, 0.004, 0.3428], "rx": 0.009, "rz": 0.0067, "twist": 0.0}, {"position": [0.09, 0.016, 0.3329], "rx": 0.009, "rz": 0.0067, "twist": 0.0}, {"position": [0.15, 0.045, 0.3144], "rx": 0.0085, "rz": 0.0064, "twist": 0.0}, {"position": [0.18, 0.072, 0.301], "rx": 0.006, "rz": 0.0045, "twist": 0.0}, {"position": [0.19, 0.085, 0.2958], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": null, "dimensions": {"width": 0.38, "height": 0.09, "depth": 0.05, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "line-dark"}}, "material": "line-dark", "materialLayers": ["line-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "feature-placement"};
  node_mouth_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "line-dark"}};
  (nodes["body"] ?? root).add(node_mouth_22);
  nodes["mouth"] = node_mouth_22;
  const mesh_mouth_22Geometry = endpoint_mouth_22
    ? new THREE.CylinderGeometry(endpoint_mouth_22.endRadius, endpoint_mouth_22.baseRadius, endpoint_mouth_22.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.19, 0.085, 0.2958], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.18, 0.072, 0.301], "rx": 0.006, "rz": 0.0045, "twist": 0.0}, {"position": [-0.15, 0.045, 0.3144], "rx": 0.0085, "rz": 0.0064, "twist": 0.0}, {"position": [-0.09, 0.016, 0.3329], "rx": 0.009, "rz": 0.0067, "twist": 0.0}, {"position": [0.0, 0.004, 0.3428], "rx": 0.009, "rz": 0.0067, "twist": 0.0}, {"position": [0.09, 0.016, 0.3329], "rx": 0.009, "rz": 0.0067, "twist": 0.0}, {"position": [0.15, 0.045, 0.3144], "rx": 0.0085, "rz": 0.0064, "twist": 0.0}, {"position": [0.18, 0.072, 0.301], "rx": 0.006, "rz": 0.0045, "twist": 0.0}, {"position": [0.19, 0.085, 0.2958], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true});
  if (!endpoint_mouth_22) {
    mesh_mouth_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_mouth_22 = new THREE.Mesh(
    mesh_mouth_22Geometry,
    materialMap["line-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mouth_22.name = "Smile arc";
  if (endpoint_mouth_22) {
    mesh_mouth_22.position.copy(endpoint_mouth_22.midpoint);
    mesh_mouth_22.quaternion.copy(endpoint_mouth_22.quaternion);
  }
  mesh_mouth_22.castShadow = options.castShadow ?? true;
  mesh_mouth_22.receiveShadow = options.receiveShadow ?? true;
  mesh_mouth_22.userData.sculptComponent = {"id": "mouth", "name": "Smile arc", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin tapered sweep so the line stays crisp.", "geometryDescriptor": {"topologyIntent": "surface marking", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.19, 0.085, 0.2958], "rx": 0.0, "rz": 0.0, "twist": 0.0}, {"position": [-0.18, 0.072, 0.301], "rx": 0.006, "rz": 0.0045, "twist": 0.0}, {"position": [-0.15, 0.045, 0.3144], "rx": 0.0085, "rz": 0.0064, "twist": 0.0}, {"position": [-0.09, 0.016, 0.3329], "rx": 0.009, "rz": 0.0067, "twist": 0.0}, {"position": [0.0, 0.004, 0.3428], "rx": 0.009, "rz": 0.0067, "twist": 0.0}, {"position": [0.09, 0.016, 0.3329], "rx": 0.009, "rz": 0.0067, "twist": 0.0}, {"position": [0.15, 0.045, 0.3144], "rx": 0.0085, "rz": 0.0064, "twist": 0.0}, {"position": [0.18, 0.072, 0.301], "rx": 0.006, "rz": 0.0045, "twist": 0.0}, {"position": [0.19, 0.085, 0.2958], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 8, "capEnds": true}}, "parent": "body", "attachment": null, "dimensions": {"width": 0.38, "height": 0.09, "depth": 0.05, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "line-dark"}}, "material": "line-dark", "materialLayers": ["line-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "feature-placement"};
  node_mouth_22.add(mesh_mouth_22);
  meshes["mouth"] = mesh_mouth_22;
  colliders["mouth"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "marking proxy"};
  destructionGroups["mouth"] ??= [];
  destructionGroups["mouth"].push(node_mouth_22);

  const endpoint_lip_highlight_23 = makeAttachmentEndpoint(null);
  const node_lip_highlight_23 = new THREE.Group();
  node_lip_highlight_23.name = "Lower-lip highlight__pivot";
  node_lip_highlight_23.scale.set(1, 1, 1);
  if (endpoint_lip_highlight_23) {
    node_lip_highlight_23.position.copy(endpoint_lip_highlight_23.start);
    node_lip_highlight_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lip_highlight_23.position.set(0.0, -0.032, 0.3388);
    node_lip_highlight_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_lip_highlight_23.userData.sculptComponent = {"id": "lip-highlight", "name": "Lower-lip highlight", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "surface marking", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "mouth", "contactType": "embed", "embedDepth": 0.015, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.075, "height": 0.022, "depth": 0.02, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, -0.032, 0.3388], "rotation": [0, 0, 0], "scale": [0.08, 0.024, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.075, 0.022, 0.02], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lip-highlight", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lip-blue"}}, "material": "lip-blue", "materialLayers": ["lip-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "feature-placement"};
  node_lip_highlight_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.075, 0.022, 0.02], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lip-highlight", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lip-blue"}};
  (nodes["body"] ?? root).add(node_lip_highlight_23);
  nodes["lip-highlight"] = node_lip_highlight_23;
  const mesh_lip_highlight_23Geometry = endpoint_lip_highlight_23
    ? new THREE.CylinderGeometry(endpoint_lip_highlight_23.endRadius, endpoint_lip_highlight_23.baseRadius, endpoint_lip_highlight_23.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_lip_highlight_23) {
    mesh_lip_highlight_23Geometry.scale(0.08, 0.024, 0.02);
  }
  const mesh_lip_highlight_23 = new THREE.Mesh(
    mesh_lip_highlight_23Geometry,
    materialMap["lip-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lip_highlight_23.name = "Lower-lip highlight";
  if (endpoint_lip_highlight_23) {
    mesh_lip_highlight_23.position.copy(endpoint_lip_highlight_23.midpoint);
    mesh_lip_highlight_23.quaternion.copy(endpoint_lip_highlight_23.quaternion);
  }
  mesh_lip_highlight_23.castShadow = options.castShadow ?? true;
  mesh_lip_highlight_23.receiveShadow = options.receiveShadow ?? true;
  mesh_lip_highlight_23.userData.sculptComponent = {"id": "lip-highlight", "name": "Lower-lip highlight", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "material-only", "topologyRationale": "A flat colour marking riding on the face surface: identity is its colour and placement, not volume. Built as a thin ellipsoid on the surface.", "geometryDescriptor": {"topologyIntent": "surface marking", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "body", "attachment": {"parentSocket": "mouth", "contactType": "embed", "embedDepth": 0.015, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.075, "height": 0.022, "depth": 0.02, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.0, -0.032, 0.3388], "rotation": [0, 0, 0], "scale": [0.08, 0.024, 0.02]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.075, 0.022, 0.02], "isTrigger": false, "notes": "marking proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lip-highlight", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lip-blue"}}, "material": "lip-blue", "materialLayers": ["lip-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "feature-placement"};
  node_lip_highlight_23.add(mesh_lip_highlight_23);
  meshes["lip-highlight"] = mesh_lip_highlight_23;
  colliders["lip-highlight"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.075, 0.022, 0.02], "isTrigger": false, "notes": "marking proxy"};
  destructionGroups["lip-highlight"] ??= [];
  destructionGroups["lip-highlight"].push(node_lip_highlight_23);

  // repetition system: finger-nubs (InstancedMesh, radial, count=6, level=meso)
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
    const cluster = new THREE.InstancedMesh(geo, mat, 6);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 6; i++) {
      const ang = ((0.0) + (i * 360) / 6) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "finger-nubs";
    parent.add(cluster);
  }

  // repetition system: catchlights (InstancedMesh, radial, count=4, level=meso)
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
    cluster.name = "catchlights";
    parent.add(cluster);
  }

  // PLAN_1.5 WS-C slice 1: bone hierarchy from spec.rig. Model-space joints are
  // converted to parent-local offsets here. Nothing is bound yet (rig.bound === false).
  const bones: Record<string, THREE.Bone> = {};
  const boneOrder: string[] = [];
  const bone_body = new THREE.Bone();
  bone_body.name = "body";
  bone_body.position.set(0.0, 0.45, 0.0);
  root.add(bone_body);
  bones["body"] = bone_body;
  boneOrder.push("body");
  const bone_arm_l = new THREE.Bone();
  bone_arm_l.name = "arm-l";
  bone_arm_l.position.set(0.35, 0.012000000000000066, 0.02);
  bone_body.add(bone_arm_l);
  bones["arm-l"] = bone_arm_l;
  boneOrder.push("arm-l");
  const bone_hand_l = new THREE.Bone();
  bone_hand_l.name = "hand-l";
  bone_hand_l.position.set(0.13, 0.12, 0.0);
  bone_arm_l.add(bone_hand_l);
  bones["hand-l"] = bone_hand_l;
  boneOrder.push("hand-l");
  const bone_nub_l_1 = new THREE.Bone();
  bone_nub_l_1.name = "nub-l-1";
  bone_nub_l_1.position.set(0.0, 0.10999999999999999, 0.0);
  bone_hand_l.add(bone_nub_l_1);
  bones["nub-l-1"] = bone_nub_l_1;
  boneOrder.push("nub-l-1");
  const bone_nub_l_2 = new THREE.Bone();
  bone_nub_l_2.name = "nub-l-2";
  bone_nub_l_2.position.set(0.04500000000000004, 0.09999999999999998, 0.0);
  bone_hand_l.add(bone_nub_l_2);
  bones["nub-l-2"] = bone_nub_l_2;
  boneOrder.push("nub-l-2");
  const bone_nub_l_3 = new THREE.Bone();
  bone_nub_l_3.name = "nub-l-3";
  bone_nub_l_3.position.set(0.07999999999999996, 0.06999999999999995, 0.0);
  bone_hand_l.add(bone_nub_l_3);
  bones["nub-l-3"] = bone_nub_l_3;
  boneOrder.push("nub-l-3");
  const bone_foot_l = new THREE.Bone();
  bone_foot_l.name = "foot-l";
  bone_foot_l.position.set(0.245, -0.298, 0.0);
  bone_body.add(bone_foot_l);
  bones["foot-l"] = bone_foot_l;
  boneOrder.push("foot-l");
  const bone_arm_r = new THREE.Bone();
  bone_arm_r.name = "arm-r";
  bone_arm_r.position.set(-0.35, 0.012000000000000066, 0.02);
  bone_body.add(bone_arm_r);
  bones["arm-r"] = bone_arm_r;
  boneOrder.push("arm-r");
  const bone_hand_r = new THREE.Bone();
  bone_hand_r.name = "hand-r";
  bone_hand_r.position.set(-0.13, 0.12, 0.0);
  bone_arm_r.add(bone_hand_r);
  bones["hand-r"] = bone_hand_r;
  boneOrder.push("hand-r");
  const bone_nub_r_1 = new THREE.Bone();
  bone_nub_r_1.name = "nub-r-1";
  bone_nub_r_1.position.set(0.0, 0.10999999999999999, 0.0);
  bone_hand_r.add(bone_nub_r_1);
  bones["nub-r-1"] = bone_nub_r_1;
  boneOrder.push("nub-r-1");
  const bone_nub_r_2 = new THREE.Bone();
  bone_nub_r_2.name = "nub-r-2";
  bone_nub_r_2.position.set(-0.04500000000000004, 0.09999999999999998, 0.0);
  bone_hand_r.add(bone_nub_r_2);
  bones["nub-r-2"] = bone_nub_r_2;
  boneOrder.push("nub-r-2");
  const bone_nub_r_3 = new THREE.Bone();
  bone_nub_r_3.name = "nub-r-3";
  bone_nub_r_3.position.set(-0.07999999999999996, 0.06999999999999995, 0.0);
  bone_hand_r.add(bone_nub_r_3);
  bones["nub-r-3"] = bone_nub_r_3;
  boneOrder.push("nub-r-3");
  const bone_foot_r = new THREE.Bone();
  bone_foot_r.name = "foot-r";
  bone_foot_r.position.set(-0.245, -0.298, 0.0);
  bone_body.add(bone_foot_r);
  bones["foot-r"] = bone_foot_r;
  boneOrder.push("foot-r");
  // The bones are now in REST position. updateMatrixWorld() before constructing the
  // Skeleton is load-bearing: calculateInverses() reads each bone's CURRENT world matrix,
  // and those inverses are what cancel the rest pose during skinning. Constructed before
  // this call it captures identity matrices, the rest pose never cancels, and every
  // vertex is displaced by its bone's offset at rest. Measured, not assumed --
  // scratchpad/bind_experiment.mjs read (0, 3, 0) for a vertex authored at (0, 2, 0).
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneOrder.map((id) => bones[id]));
  const boneIndexOf = new Map<string, number>(boneOrder.map((id, i) => [id, i]));

  // ---- PLAN_1.5 §4 weight function: ONE function over the complete bone set. No
  // mesh-id or vertex-index branching -- only positions, segment endpoints and the
  // envelope radius derived per §4.3. Ported from forge/stage5_rig/emit_rig.py, which
  // measured max |sum(w) - 1| = 2.98e-8 on executed geometry.
  const BONE_JOINT: Record<string, number[]> = {"body": [0.0, 0.45, 0.0], "arm-l": [0.35, 0.4620000000000001, 0.02], "hand-l": [0.48, 0.5820000000000001, 0.02], "nub-l-1": [0.48, 0.6920000000000001, 0.02], "nub-l-2": [0.525, 0.682, 0.02], "nub-l-3": [0.5599999999999999, 0.652, 0.02], "foot-l": [0.245, 0.15200000000000002, 0.0], "arm-r": [-0.35, 0.4620000000000001, 0.02], "hand-r": [-0.48, 0.5820000000000001, 0.02], "nub-r-1": [-0.48, 0.6920000000000001, 0.02], "nub-r-2": [-0.525, 0.682, 0.02], "nub-r-3": [-0.5599999999999999, 0.652, 0.02], "foot-r": [-0.245, 0.15200000000000002, 0.0]};
  const BONE_TIP: Record<string, number[]> = {"body": [0.0, 0.7, 0.0], "arm-l": [0.48, 0.5820000000000001, 0.02], "hand-l": [0.5, 0.672, 0.02], "nub-l-1": [0.48, 0.742, 0.02], "nub-l-2": [0.55, 0.7270000000000001, 0.02], "nub-l-3": [0.6, 0.677, 0.02], "foot-l": [0.26, 0.07700000000000007, 0.0], "arm-r": [-0.48, 0.5820000000000001, 0.02], "hand-r": [-0.5, 0.672, 0.02], "nub-r-1": [-0.48, 0.742, 0.02], "nub-r-2": [-0.55, 0.7270000000000001, 0.02], "nub-r-3": [-0.6, 0.677, 0.02], "foot-r": [-0.26, 0.07700000000000007, 0.0]};
  const BONE_ENVELOPE: Record<string, number> = {"body": 0.6, "arm-l": 0.114, "hand-l": 0.12, "nub-l-1": 0.0288, "nub-l-2": 0.0288, "nub-l-3": 0.0288, "foot-l": 0.114, "arm-r": 0.114, "hand-r": 0.12, "nub-r-1": 0.0288, "nub-r-2": 0.0288, "nub-r-3": 0.0288, "foot-r": 0.114};
  const _closest = new THREE.Vector3();
  const distanceToSegment = (p: THREE.Vector3, s: number[], e: number[]): number => {
    const ab = [e[0] - s[0], e[1] - s[1], e[2] - s[2]];
    const ap = [p.x - s[0], p.y - s[1], p.z - s[2]];
    const abLenSq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = abLenSq > 1e-12
      ? THREE.MathUtils.clamp((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / abLenSq, 0, 1)
      : 0;
    _closest.set(s[0] + ab[0] * t, s[1] + ab[1] * t, s[2] + ab[2] * t);
    return p.distanceTo(_closest);
  };
  const computeVertexWeights = (p: THREE.Vector3) => {
    const scored = boneOrder.map((id) => {
      const d = distanceToSegment(p, BONE_JOINT[id], BONE_TIP[id]);
      const u = d / BONE_ENVELOPE[id];
      const falloff = Math.max(0, 1 - u * u);
      return { id, d, w: falloff * falloff };
    });
    scored.sort((a, b) => b.w - a.w);
    const kept = scored.slice(0, 4);
    const total = kept.reduce((sum, c) => sum + c.w, 0);
    const indices = [0, 0, 0, 0];
    const weights = [0, 0, 0, 0];
    if (total > 0) {
      for (let slot = 0; slot < kept.length; slot++) {
        indices[slot] = boneIndexOf.get(kept[slot].id) ?? 0;
        weights[slot] = kept[slot].w / total;
      }
      return { indices, weights, fallback: false };
    }
    // Mandatory zero-sum fallback (PLAN_1.5 §4 / ADR-8). Without it three.js's own
    // normalizeSkinWeights() rewrites an all-zero vertex to (1,0,0,0) against bone 0
    // regardless of distance, which spikes stray vertices toward the hips. Instead:
    // ignore the envelope and pin weight 1.0 to the absolutely nearest bone.
    let nearest = boneOrder[0];
    let nearestDistance = Infinity;
    for (const id of boneOrder) {
      const d = distanceToSegment(p, BONE_JOINT[id], BONE_TIP[id]);
      if (d < nearestDistance) { nearestDistance = d; nearest = id; }
    }
    indices[0] = boneIndexOf.get(nearest) ?? 0;
    weights[0] = 1;
    return { indices, weights, fallback: true };
  };

  // ---- Bake to model space, weight, and bind.
  //
  // The arrangement below was chosen by measurement, not derivation, because the same
  // geometry can be skinned four plausible ways and three of them are wrong. With a
  // vertex authored at model-space (0, 2, 0) fully weighted to a bone at (0, 1, 0) and
  // that bone rotated +90 degrees about X (correct answer: (0, 1, 1)):
  //
  //   pivot transform kept, bind identity     -> rest pose already wrong, no deformation
  //   pivot transform kept, bind matrixWorld  -> (0, 1.5, 0.5): HALF the correct swing,
  //                                              because the pivot applies on top of skinning
  //   geometry baked, pivot bypassed          -> (0, 1, 1): correct
  //   no pivot at all                         -> (0, 1, 1): correct, and identical
  //
  // The last two agreeing is the finding: what matters is that the mesh's own world
  // transform is identity and its geometry lives in the skeleton's space. So each skinned
  // mesh gets its world matrix folded into its vertex data and is reparented to `root`
  // with an identity transform. Meshes are leaves -- components are added to their pivot
  // Group, never to another mesh -- so reparenting one moves nothing else.
  // No component carries an authored pose, so there is nothing to rest.
  root.updateMatrixWorld(true);
  const skinnedMeshNames: string[] = [];
  let boundCount = 0;
  for (const boneId of boneOrder) {
    const mesh = meshes[boneId];
    if (!mesh) continue;
    const position = mesh.geometry.getAttribute('position');
    if (!position) continue;
    mesh.updateWorldMatrix(true, false);
    // applyMatrix4 mutates the vertex buffer in place and is NOT idempotent: running it
    // twice on one geometry applies the world matrix squared, and every component lands
    // somewhere it has no reason to be -- the model reads as blown apart rather than
    // wrong. Throw rather than skip, because a silent skip would leave a mesh in the
    // wrong space and the failure would resurface later as a subtler misplacement.
    if (mesh.geometry.userData.worldBaked) {
      throw new Error(
        `geometry for '${boneId}' is already world-baked; baking twice squares the ` +
        'world matrix and scatters the parts. Build a fresh factory instead of re-binding.'
      );
    }
    mesh.geometry.applyMatrix4(mesh.matrixWorld);
    mesh.geometry.userData.worldBaked = true;
    root.add(mesh);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrixWorld(true);
    // Vertices are model-space now, which is the space the weight function measures in,
    // so no per-vertex matrix multiply is needed any more.
    const count = position.count;
    const skinIndices = new Uint16Array(count * 4);
    const skinWeights = new Float32Array(count * 4);
    const vertex = new THREE.Vector3();
    for (let v = 0; v < count; v++) {
      vertex.fromBufferAttribute(position, v);
      const { indices, weights } = computeVertexWeights(vertex);
      for (let slot = 0; slot < 4; slot++) {
        skinIndices[v * 4 + slot] = indices[slot];
        skinWeights[v * 4 + slot] = weights[slot];
      }
    }
    mesh.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    mesh.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    skinnedMeshNames.push(boneId);
    const skinned = mesh as THREE.SkinnedMesh;
    if (!skinned.isSkinnedMesh) continue;
    // bindMode is left at its default (AttachedBindMode). The bones live under `root`
    // rather than under any one mesh because a single Skeleton is shared by every skinned
    // mesh and cannot be parented under all of them; with root and each mesh at identity
    // the bone world matrices are the same either way.
    skinned.bind(skeleton, new THREE.Matrix4());
    // A SkinnedMesh's boundingSphere is computed from its REST vertex data and is not
    // recomputed when bones move, so a posed limb that swings outside its rest bounds gets
    // culled and vanishes -- worse, it vanishes only from certain camera angles, which
    // reads as a geometry bug rather than a culling one. Disabling the test outright is
    // chosen over recomputing bounds every frame because these are small, always-onscreen
    // character parts where the test saves nothing. Recorded in userData.rig so a consumer
    // that DOES need culling knows it has to supply its own bounds.
    skinned.frustumCulled = false;
    boundCount += 1;
  }
  root.userData.rig = { bones, skeleton, boneOrder, boneIndexOf, skinAttributes: skinnedMeshNames, bound: skinnedMeshNames.length > 0 && boundCount === skinnedMeshNames.length, frustumCulled: false, cullingNote: 'skinned meshes set frustumCulled = false; bone motion does not update a SkinnedMesh boundingSphere, so a consumer that needs culling must recompute bounds per frame' };

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createWigglePlayMascotLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "WigglePlay Mascot look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "directional", "direction": [-0.6, 0.9, 0.8], "intensity": 1.4, "color": "#ffffff", "castShadow": true, "evidence": "brighter crown-left rim and upper-lateral catchlights in the reference"}, {"id": "fill", "type": "hemisphere", "skyColor": "#f4f0ff", "groundColor": "#6a4fb8", "intensity": 1.0, "evidence": "shadow side stays lavender, never black"}, {"id": "rim", "type": "directional", "direction": [0.5, 0.4, -1.0], "intensity": 0.5, "color": "#e6d6ff", "evidence": "thin lighter edge along the crown silhouette"}, {"id": "exposure", "type": "renderer", "toneMapping": "ACESFilmic", "exposure": 1.25, "outputColorSpace": "srgb", "evidence": "saturated pastel palette must survive tone mapping; verify the sampled stops after ACES; exposure raised to 1.25 after the material-pass render measured mid-tones 24 dE below the sampled albedo"}, {"id": "ground", "type": "contact-shadow", "contactShadow": "soft blurred disc under the feet, radius 0.55, opacity 0.35; ambient occlusion baked per material AO channel disabled (textureless)", "evidence": "sticker has no cast shadow; a soft contact shadow grounds the 3D puppet"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createWigglePlayMascotEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameWigglePlayMascotCamera(
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
export function createWigglePlayMascotPresentationComposer(
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

export function configureWigglePlayMascotRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createWigglePlayMascotInspectControls(
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
