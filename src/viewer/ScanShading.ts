import * as THREE from 'three';

export type ShadingMode = 'clay' | 'curvature' | 'height';
const MODE_INDEX: Record<ShadingMode, number> = { clay: 0, curvature: 1, height: 2 };

const vertexShader = /* glsl */ `
attribute float curv;
uniform vec3 heightAxis;
varying vec3 vNormalV;
varying float vCurv;
varying float vHeight;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vHeight = dot(world.xyz, heightAxis);
  vNormalV = normalize(normalMatrix * normal);
  vCurv = curv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D matcap;
uniform int mode;
uniform float curvGain;
uniform vec2 heightRange;
uniform float contourStep;
varying vec3 vNormalV;
varying float vCurv;
varying float vHeight;

vec3 ramp(float t) {
  vec3 c0 = vec3(0.17, 0.24, 0.52);
  vec3 c1 = vec3(0.15, 0.54, 0.68);
  vec3 c2 = vec3(0.56, 0.78, 0.54);
  vec3 c3 = vec3(0.96, 0.80, 0.42);
  vec3 c4 = vec3(0.86, 0.36, 0.26);
  t *= 4.0;
  if (t < 1.0) return mix(c0, c1, t);
  if (t < 2.0) return mix(c1, c2, t - 1.0);
  if (t < 3.0) return mix(c2, c3, t - 2.0);
  return mix(c3, c4, t - 3.0);
}

void main() {
  vec3 n = normalize(vNormalV);
  if (!gl_FrontFacing) n = -n;
  vec3 clay = texture2D(matcap, n.xy * 0.49 + 0.5).rgb;
  float light = dot(clay, vec3(0.3333));
  vec3 col = clay;

  if (mode == 1) {
    float k = clamp(vCurv * curvGain, -1.0, 1.0);
    col = mix(vec3(0.10, 0.11, 0.14), vec3(0.97, 0.97, 0.96), smoothstep(-1.0, 1.0, k));
    col *= 0.78 + 0.3 * light;
  } else if (mode == 2) {
    float span = max(heightRange.y - heightRange.x, 1e-6);
    float t = clamp((vHeight - heightRange.x) / span, 0.0, 1.0);
    col = ramp(t) * (0.55 + 0.6 * light);
    if (contourStep > 0.0) {
      float h = vHeight / contourStep;
      float d = abs(fract(h - 0.5) - 0.5) / max(fwidth(h), 1e-6);
      col *= mix(0.45, 1.0, clamp(d, 0.0, 1.0));
    }
  }

  // Back faces (the underside of an open scan) get a muted tint.
  if (!gl_FrontFacing) col *= vec3(0.78, 0.70, 0.70);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Soft studio-lit clay sphere, used as a matcap lookup. */
function makeClayMatcap(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(size, size);
  const base = [0.82, 0.8, 0.77];
  const key = new THREE.Vector3(-0.45, 0.55, 0.7).normalize();
  const fill = new THREE.Vector3(0.65, -0.25, 0.55).normalize();
  const half = new THREE.Vector3().addVectors(key, new THREE.Vector3(0, 0, 1)).normalize();
  const n = new THREE.Vector3();

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5) / size) * 2 - 1;
      const ny = 1 - ((y + 0.5) / size) * 2;
      const r2 = nx * nx + ny * ny;
      if (r2 >= 1) n.set(nx, ny, 0).normalize();
      else n.set(nx, ny, Math.sqrt(1 - r2));
      const diffuse = 0.3 + 0.08 * ny + 0.62 * Math.max(0, n.dot(key)) + 0.2 * Math.max(0, n.dot(fill));
      const spec = 0.18 * Math.pow(Math.max(0, n.dot(half)), 40);
      const rim = 0.22 * Math.pow(1 - n.z, 3);
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        img.data[o + c] = Math.min(255, (base[c] * diffuse + spec + rim * 0.95) * 255);
      }
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

export class ScanShading {
  readonly material: THREE.ShaderMaterial;
  private heightMin = 0;
  private heightMax = 1;
  private low = 0;
  private high = 1;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        matcap: { value: makeClayMatcap() },
        mode: { value: 0 },
        curvGain: { value: 0.8 },
        heightRange: { value: new THREE.Vector2(0, 1) },
        heightAxis: { value: new THREE.Vector3(0, 0, 1) },
        contourStep: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
    });
  }

  setMode(mode: ShadingMode) {
    this.material.uniforms.mode.value = MODE_INDEX[mode];
  }

  setCurvatureContrast(gain: number) {
    this.material.uniforms.curvGain.value = gain;
  }

  /** The scan's full height span along the height axis, in mm. */
  setHeightBounds(min: number, max: number) {
    this.heightMin = min;
    this.heightMax = max;
    this.applyHeightWindow();
  }

  /** The visible color window as fractions (0–1) of the full height span. */
  setHeightWindow(low: number, high: number) {
    this.low = Math.min(low, high);
    this.high = Math.max(low, high);
    this.applyHeightWindow();
  }

  setHeightAxis(axis: THREE.Vector3) {
    this.material.uniforms.heightAxis.value.copy(axis);
  }

  setContourStep(mm: number) {
    this.material.uniforms.contourStep.value = mm;
  }

  private applyHeightWindow() {
    const span = this.heightMax - this.heightMin;
    this.material.uniforms.heightRange.value.set(
      this.heightMin + span * this.low,
      this.heightMin + span * this.high,
    );
  }
}
