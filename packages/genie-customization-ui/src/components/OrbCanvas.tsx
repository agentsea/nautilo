/**
 * D091 Phase 1 — WebGL orb, React-wrapped.
 *
 * Ported verbatim from the legacy inline `<script type="module">` in
 * `packages/server/src/setup/index.html` (lines 3020–3165). The shader
 * code, uniforms, color palette, breathe / rotate amounts, and
 * `uIntensity` lerp target semantics are unchanged — this is a
 * mechanical translation from IIFE-on-window-globals to
 * React-ref-with-useEffect-cleanup.
 *
 * The legacy version drove `setOrbState()` by writing to
 * `window._orbTargetIntensity` and `window._orbHidden`. The React
 * version replaces those globals with props; the caller passes
 * `orbState` and the useEffect loop reads the live value via a ref
 * so the animation closure doesn't stale.
 *
 * Memory + GPU hygiene: the cleanup function tears down the
 * `requestAnimationFrame` loop, disposes the renderer / geometry /
 * material, and removes the canvas element from the DOM. Without
 * this, re-mounting the wizard (e.g. via NAUTILO_FORCE_ONBOARDING
 * dev iteration) would leak a WebGL context per mount, and Electron
 * caps total contexts around 16 before the oldest dies silently.
 */

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import type { OrbState } from "../types";

// ---------------------------------------------------------------------------
// Shaders — verbatim from the legacy inline HTML, no content changes.
// ---------------------------------------------------------------------------

/**
 * Vertex shader. snoise() is Stefan Gustavson's simplex noise port
 * (public domain). Displaces the sphere's vertices along each
 * vertex's normal by a noise-driven amplitude that scales with
 * `uIntensity` (more displacement when "compiling", almost none when
 * "idle").
 */
const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  varying vec2 vUv;
  varying float vDisplacement;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    vUv = uv;
    float speed = 0.3 + uIntensity * 0.5;
    float amp = 0.08 + uIntensity * 0.15;
    float noise = snoise(normal * 2.0 + uTime * speed);
    float noise2 = snoise(normal * 4.0 - uTime * speed * 0.7) * 0.5;
    vDisplacement = (noise + noise2) * amp;
    vec3 newPos = position + normal * vDisplacement;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPos, 1.0);
  }
`;

/**
 * Fragment shader. Produces a 3-color vertical gradient (purple →
 * blue → pink) that scrolls with uTime, with a cheap fake fresnel
 * rim-glow on top. Full-alpha 0.95 so the orb reads as solid but
 * lets the body background bleed 5%.
 */
const FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  varying vec2 vUv;
  varying float vDisplacement;

  void main() {
    float t = vUv.y + vDisplacement * 2.0;
    float wave = sin(t * 3.14159 + uTime * 0.5) * 0.5 + 0.5;
    float wave2 = sin(t * 2.0 - uTime * 0.3) * 0.5 + 0.5;
    vec3 color = mix(uColorA, uColorB, wave);
    color = mix(color, uColorC, wave2 * 0.4);
    float glow = 0.6 + uIntensity * 0.4;
    color *= glow;
    float fresnel = pow(1.0 - abs(dot(vec3(0.0, 0.0, 1.0), normalize(vec3(vUv - 0.5, 0.5)))), 2.0);
    color += fresnel * 0.15 * uColorB;
    gl_FragColor = vec4(color, 0.95);
  }
`;

// ---------------------------------------------------------------------------
// Palette — matches the legacy inline HTML exactly.
// ---------------------------------------------------------------------------

const COLOR_A = new THREE.Color("#6b21a8"); // purple
const COLOR_B = new THREE.Color("#3b82f6"); // blue
const COLOR_C = new THREE.Color("#ec4899"); // pink

// ---------------------------------------------------------------------------
// uIntensity lerp targets — match the legacy inline HTML
// setOrbState() values at lines 1317–1319.
// ---------------------------------------------------------------------------

function targetIntensityFor(state: OrbState): number {
  switch (state) {
    case "idle": return 0;
    case "speaking": return 0.5;
    case "compiling": return 1.0;
    case "hidden": return 0; // irrelevant; animation paused
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface OrbCanvasProps {
  /** Current orb visual state. Transitions are smooth (0.33s lerp). */
  orbState: OrbState;
  /** Render target size. Legacy HTML was 220x220; Phase 2 Reveal
   *  screen may scale this up. Mandatory — no default so the caller
   *  thinks about window layout explicitly. */
  size: number;
}

export function OrbCanvas({ orbState, size }: OrbCanvasProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

  // The animation loop closes over these refs so live prop updates
  // are visible frame-to-frame without rebuilding the WebGL context.
  // `targetIntensityRef` drives the uIntensity lerp; `orbStateRef`
  // gates the render (hidden → pause the loop). Both are assigned
  // on every orbState change via useEffect below.
  const targetIntensityRef = useRef<number>(targetIntensityFor(orbState));
  const orbStateRef = useRef<OrbState>(orbState);

  useEffect(() => {
    targetIntensityRef.current = targetIntensityFor(orbState);
    orbStateRef.current = orbState;
  }, [orbState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Renderer — alpha:true so we can sit on the dark body bg without
    // clobbering it. antialias:false matches the legacy HTML (the
    // shader's own displacement hides aliasing artifacts anyway).
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(size, size);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 4;

    // Segments: 64 on desktop / 32 on a narrow window. Electron's
    // minimum window is 900px so we'll always hit the 64 branch
    // today, but keep the mobile fallback for when we render into
    // smaller surfaces (e.g. a future settings-screen preview).
    const isNarrow = window.innerWidth < 768;
    const segments = isNarrow ? 32 : 64;

    const uniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uColorA: { value: COLOR_A.clone() },
      uColorB: { value: COLOR_B.clone() },
      uColorC: { value: COLOR_C.clone() },
    };

    const geometry = new THREE.SphereGeometry(1.5, segments, segments);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms,
      transparent: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const clock = new THREE.Clock();
    let rafHandle = 0;

    // Animation loop. Pauses on "hidden" by checking the live ref
    // each frame — cheaper than stopping/restarting the loop around
    // state transitions.
    const animate = () => {
      rafHandle = requestAnimationFrame(animate);
      if (orbStateRef.current === "hidden") return;

      const delta = clock.getDelta();
      uniforms.uTime.value += delta;
      uniforms.uIntensity.value = THREE.MathUtils.lerp(
        uniforms.uIntensity.value,
        targetIntensityRef.current,
        delta * 3,
      );
      mesh.rotation.y += delta * 0.1;
      // Breathe: 2% scale oscillation, amplified by current intensity.
      const breathe =
        1 + Math.sin(uniforms.uTime.value * 1.5) * 0.02 * (1 + targetIntensityRef.current);
      mesh.scale.setScalar(breathe);
      renderer.render(scene, camera);
    };
    animate();

    // Teardown — critical for avoiding WebGL-context leaks when the
    // wizard window re-opens (e.g. via NAUTILO_FORCE_ONBOARDING in
    // dev). Without dispose() here, each re-mount allocates a fresh
    // GL context and Electron silently starts dropping the oldest
    // once we hit its ~16-context ceiling.
    return () => {
      cancelAnimationFrame(rafHandle);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [size]); // size is the only "rebuild-the-renderer" input;
              // orbState is handled via the refs above.

  return (
    <div
      ref={containerRef}
      className={orbState === "hidden" ? "genie-customization-orb-wrap hidden" : "genie-customization-orb-wrap"}
      aria-hidden
      style={{ width: size, height: size }}
    />
  );
}
