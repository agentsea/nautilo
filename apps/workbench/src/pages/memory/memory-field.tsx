/**
 * D234 Phase 4 — ambient memory motes band (three.js).
 *
 * Hygiene mirrors `packages/genie-customization-ui/src/components/OrbCanvas.tsx`:
 * alpha renderer, DPR cap, rAF loop with visibility pause, full dispose on
 * unmount and on settings/data rebuild.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { AmbienceSettings } from "./memory-ambience";

const BAND_HEIGHT = 160;

const POINTS_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aBrightness;
  varying float vBrightness;

  void main() {
    vBrightness = aBrightness;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // Small discrete motes; clamp so nothing balloons into a blob.
    gl_PointSize = min(aSize * (26.0 / -mvPosition.z), 42.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const POINTS_FRAGMENT = /* glsl */ `
  varying float vBrightness;

  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float dist = length(c);
    if (dist > 0.5) discard;
    float alpha = smoothstep(0.5, 0.0, dist) * vBrightness;
    vec3 color = mix(vec3(0.45, 0.55, 0.95), vec3(0.85, 0.65, 1.0), vBrightness);
    gl_FragColor = vec4(color, alpha);
  }
`;

interface MoteData {
  baseX: number;
  baseY: number;
  baseZ: number;
  phase: number;
  speed: number;
  isHub: boolean;
  importance: number;
}

function resolveMoteCount(density: number, itemCount: number): number {
  if (itemCount <= 0) return density;
  const scale = Math.min(1.5, Math.max(0.4, itemCount / 150));
  return Math.round(density * scale);
}

function buildMotes(
  count: number,
  importances: number[],
  hubPct: number,
  hubSize: number,
): { motes: MoteData[]; positions: Float32Array; sizes: Float32Array; brightness: Float32Array } {
  const motes: MoteData[] = [];
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const brightness = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const importance =
      importances.length > 0 ? importances[i % importances.length] : 0.35 + (i % 7) * 0.08;
    const x = (Math.random() - 0.5) * 14;
    const y = (Math.random() - 0.5) * 3.2;
    const z = (Math.random() - 0.5) * 4;
    motes.push({
      baseX: x,
      baseY: y,
      baseZ: z,
      phase: Math.random() * Math.PI * 2,
      speed: 0.4 + Math.random() * 0.8,
      isHub: false,
      importance,
    });
  }

  const hubCount = Math.max(1, Math.round((count * hubPct) / 100));
  const ranked = motes
    .map((m, index) => ({ index, importance: m.importance }))
    .sort((a, b) => b.importance - a.importance);
  for (let h = 0; h < hubCount && h < ranked.length; h += 1) {
    motes[ranked[h].index].isHub = true;
  }

  for (let i = 0; i < count; i += 1) {
    const m = motes[i];
    positions[i * 3] = m.baseX;
    positions[i * 3 + 1] = m.baseY;
    positions[i * 3 + 2] = m.baseZ;
    const impBoost = 0.3 + m.importance * 0.55;
    sizes[i] = m.isHub ? hubSize * (1.0 + m.importance * 0.3) : 1.2 + m.importance * 1.6;
    // Keep normal motes below the bloom threshold; only hubs bloom.
    brightness[i] = m.isHub ? Math.min(1.3, 0.7 + m.importance * 0.6) : Math.min(0.7, impBoost);
  }

  return { motes, positions, sizes, brightness };
}

function buildLinks(
  positions: Float32Array,
  count: number,
  linksSetting: number,
): { geometry: THREE.BufferGeometry; pairs: Array<[number, number]> } {
  const maxDist = 0.55 + linksSetting / 80;
  const maxPerMote = Math.max(2, Math.round(linksSetting / 12));
  const segments: number[] = [];
  const pairs: Array<[number, number]> = [];
  const seen = new Set<string>();

  for (let i = 0; i < count; i += 1) {
    const ix = positions[i * 3];
    const iy = positions[i * 3 + 1];
    const iz = positions[i * 3 + 2];
    const neighbors: Array<{ j: number; dist: number }> = [];

    for (let j = i + 1; j < count; j += 1) {
      const dx = ix - positions[j * 3];
      const dy = iy - positions[j * 3 + 1];
      const dz = iz - positions[j * 3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist <= maxDist) neighbors.push({ j, dist });
    }

    neighbors.sort((a, b) => a.dist - b.dist);
    let added = 0;
    for (const n of neighbors) {
      if (added >= maxPerMote) break;
      const key = i < n.j ? `${i}-${n.j}` : `${n.j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([i, n.j]);
      segments.push(ix, iy, iz, positions[n.j * 3], positions[n.j * 3 + 1], positions[n.j * 3 + 2]);
      added += 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
  return { geometry, pairs };
}

export interface MemoryFieldProps {
  settings: AmbienceSettings;
  itemCount: number;
  importances: number[];
  animate: boolean;
  className?: string;
}

export function MemoryField({
  settings,
  itemCount,
  importances,
  animate,
  className,
}: MemoryFieldProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const animateRef = useRef(animate);
  const mouseRef = useRef({ x: 0, y: 0 });
  // Stable key for the importances array so the WebGL-rebuild effect can be
  // statically dependency-checked instead of joining inline in the dep list.
  const importanceKey = importances.join(",");

  useEffect(() => {
    animateRef.current = animate;
  }, [animate]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || container.offsetWidth || 800;
    const height = BAND_HEIGHT;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 100);
    camera.position.z = 8;

    const parallaxGroup = new THREE.Group();
    scene.add(parallaxGroup);

    const moteCount = resolveMoteCount(settings.density, itemCount);
    const { motes, positions, sizes, brightness } = buildMotes(
      moteCount,
      importances,
      settings.hubPct,
      settings.hubSize,
    );

    const pointsGeometry = new THREE.BufferGeometry();
    pointsGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    pointsGeometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    pointsGeometry.setAttribute("aBrightness", new THREE.BufferAttribute(brightness, 1));

    const pointsMaterial = new THREE.ShaderMaterial({
      vertexShader: POINTS_VERTEX,
      fragmentShader: POINTS_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(pointsGeometry, pointsMaterial);
    parallaxGroup.add(points);

    const { geometry: linksGeometry, pairs: linkPairs } = buildLinks(
      positions,
      moteCount,
      settings.links,
    );
    const linksMaterial = new THREE.LineBasicMaterial({
      color: 0x8899ff,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
    });
    const links = new THREE.LineSegments(linksGeometry, linksMaterial);
    parallaxGroup.add(links);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // threshold 0.55 → only bright/hub motes bloom (not the whole field);
    // strength is scaled down so glow=2.0 (Standard) reads as a soft halo.
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      settings.glow * 0.55,
      0.45,
      0.55,
    );
    composer.addPass(bloomPass);

    const posAttr = pointsGeometry.getAttribute("position") as THREE.BufferAttribute;
    const linkPosAttr = linksGeometry.getAttribute("position") as THREE.BufferAttribute;

    const clock = new THREE.Clock();
    let rafHandle = 0;
    let visible = !document.hidden;
    let disposed = false;

    const syncLinkEndpoints = () => {
      const linkArr = linkPosAttr.array as Float32Array;
      for (let p = 0; p < linkPairs.length; p += 1) {
        const [a, b] = linkPairs[p];
        const base = p * 6;
        linkArr[base] = posAttr.getX(a);
        linkArr[base + 1] = posAttr.getY(a);
        linkArr[base + 2] = posAttr.getZ(a);
        linkArr[base + 3] = posAttr.getX(b);
        linkArr[base + 4] = posAttr.getY(b);
        linkArr[base + 5] = posAttr.getZ(b);
      }
      linkPosAttr.needsUpdate = true;
    };

    const renderFrame = (time: number) => {
      const drift = settings.drift;
      const t = time * 0.001;

      parallaxGroup.rotation.x = mouseRef.current.y * 0.04;
      parallaxGroup.rotation.y = mouseRef.current.x * 0.06;
      parallaxGroup.position.x = mouseRef.current.x * 0.25;
      parallaxGroup.position.y = mouseRef.current.y * 0.12;

      for (let i = 0; i < moteCount; i += 1) {
        const m = motes[i];
        const wobble = animateRef.current ? drift : 0;
        const x = m.baseX + Math.sin(t * m.speed + m.phase) * wobble * 0.35;
        const y = m.baseY + Math.cos(t * m.speed * 0.85 + m.phase) * wobble * 0.22;
        const z = m.baseZ + Math.sin(t * m.speed * 0.6 + m.phase * 1.3) * wobble * 0.18;
        posAttr.setXYZ(i, x, y, z);
      }
      posAttr.needsUpdate = true;
      syncLinkEndpoints();

      bloomPass.strength = settings.glow * 0.55;
      composer.render();
    };

    const loop = () => {
      if (disposed) return;
      rafHandle = requestAnimationFrame(loop);
      if (!visible || !animateRef.current) return;
      renderFrame(clock.getElapsedTime() * 1000);
    };

    const onVisibility = () => {
      visible = !document.hidden;
      if (visible && animateRef.current) clock.getDelta();
    };

    const parallaxHost = container.parentElement ?? container;

    const onMouseMove = (event: MouseEvent) => {
      const rect = parallaxHost.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      mouseRef.current.x = nx;
      mouseRef.current.y = ny;
      if (!animateRef.current) renderFrame(performance.now());
    };

    const onResize = () => {
      if (disposed) return;
      const w = container.clientWidth || width;
      renderer.setSize(w, height);
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      composer.setSize(w, height);
      bloomPass.resolution.set(w, height);
      if (!animateRef.current) renderFrame(performance.now());
    };

    document.addEventListener("visibilitychange", onVisibility);
    parallaxHost.addEventListener("mousemove", onMouseMove);
    window.addEventListener("resize", onResize);

    renderFrame(0);
    loop();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafHandle);
      document.removeEventListener("visibilitychange", onVisibility);
      parallaxHost.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("resize", onResize);
      pointsGeometry.dispose();
      pointsMaterial.dispose();
      linksGeometry.dispose();
      linksMaterial.dispose();
      composer.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // Rebuild WebGL when visual inputs change — mirrors OrbCanvas size dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings.density,
    settings.drift,
    settings.links,
    settings.glow,
    settings.hubPct,
    settings.hubSize,
    itemCount,
    importanceKey,
  ]);

  return (
    <div
      ref={containerRef}
      className={className}
      aria-hidden
      style={{ width: "100%", height: BAND_HEIGHT }}
    />
  );
}
