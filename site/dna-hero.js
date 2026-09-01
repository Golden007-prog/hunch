import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.module.min.js";

const canvas = document.getElementById("holdline");
const hero = document.querySelector("header.hero");
const ctaCanvas = document.getElementById("cta-dna");
const ctaSection = document.querySelector("section.cta");

if (canvas && hero) {
  try {
    initParticleDna();
  } catch (error) {
    canvas.removeAttribute("data-dna-ready");
    console.warn("Hunch DNA renderer fell back to canvas.", error);
  }
}

function initParticleDna() {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = matchMedia("(pointer: coarse)").matches;
  const rtl = document.documentElement.dir === "rtl";
  const rows = coarsePointer ? 124 : 220;
  const columns = coarsePointer ? 54 : 96;
  const pointCount = rows * columns;
  const sheetHalfHeight = coarsePointer ? 5.35 : 5.65;
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const range = (from, to, value) => {
    const unit = clamp((value - from) / (to - from));
    return unit * unit * (3 - 2 * unit);
  };

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: !coarsePointer,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  canvas.dataset.dnaReady = "true";
  document.documentElement.classList.add("dna-webgl");

  const ctaRenderer = ctaCanvas && ctaSection
    ? new THREE.WebGLRenderer({
      canvas: ctaCanvas,
      alpha: true,
      antialias: !coarsePointer,
      powerPreference: "high-performance",
    })
    : null;
  if (ctaRenderer) {
    ctaRenderer.setClearColor(0x000000, 0);
    ctaRenderer.outputColorSpace = THREE.SRGBColorSpace;
    ctaRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    ctaRenderer.toneMappingExposure = 1.05;
    ctaCanvas.dataset.dnaReady = "true";
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 70);
  camera.position.set(0, 0, 11.15);
  const ctaScene = ctaRenderer ? new THREE.Scene() : null;
  const ctaCamera = ctaRenderer ? new THREE.PerspectiveCamera(35, 1, 0.1, 70) : null;
  if (ctaCamera) ctaCamera.position.set(0, 0, 11.4);

  const dotTexture = makeDotTexture();
  const sculpture = new THREE.Group();
  scene.add(sculpture);

  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(pointCount * 3);
  const colors = new Float32Array(pointCount * 3);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const coordinates = Array.from({ length: pointCount }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return {
      u: column / (columns - 1) * 2 - 1,
      v: row / (rows - 1) * 2 - 1,
      seed: seeded(index, 11),
    };
  });
  const scatterUniforms = {
    pointer: { value: new THREE.Vector2(2, 2) },
    amount: { value: 0 },
    time: { value: 0 },
  };

  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: coarsePointer ? 0.054 : 0.041,
      map: dotTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.96,
      alphaTest: 0.07,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  points.renderOrder = 2;
  addPointerScatter(points.material, 1);
  sculpture.add(points);

  const softLayer = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: coarsePointer ? 0.082 : 0.064,
      map: dotTexture,
      color: 0x5f9f80,
      transparent: true,
      opacity: 0.055,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  softLayer.renderOrder = 1;
  addPointerScatter(softLayer.material, 0.58);
  sculpture.add(softLayer);

  const dust = makeParticleField(coarsePointer ? 250 : 560, dotTexture, false);
  const floaters = makeParticleField(coarsePointer ? 28 : 54, dotTexture, true);
  scene.add(dust, floaters);

  const farColor = new THREE.Color(0xb8d6c7);
  const midColor = new THREE.Color(0x6fa58b);
  const nearColor = new THREE.Color(0x285f48);
  const locusColor = new THREE.Color(0x0c3f2c);
  const mappedColor = new THREE.Color(0x2a9765);
  const quietColor = new THREE.Color(0xcfe2d8);
  const memoryColor = new THREE.Color(0x0d563a);
  const geneLoci = [
    { center: -0.84, span: 0.052, phase: 1 },
    { center: -0.65, span: 0.036, phase: 3 },
    { center: -0.39, span: 0.068, phase: 0 },
    { center: -0.13, span: 0.042, phase: 4 },
    { center: 0.08, span: 0.03, phase: 2 },
    { center: 0.32, span: 0.072, phase: 5 },
    { center: 0.58, span: 0.044, phase: 1 },
    { center: 0.79, span: 0.058, phase: 3 },
  ];
  const mappedSamples = [];
  coordinates.forEach(({ u, v }, sourceIndex) => {
    for (let locusIndex = 0; locusIndex < geneLoci.length; locusIndex += 1) {
      const locus = geneLoci[locusIndex];
      const pairOffset = locus.span * 0.4;
      const pairWidth = Math.max(0.012, locus.span * 0.24);
      const pairA = Math.exp(-Math.pow((v - locus.center - pairOffset) / pairWidth, 2));
      const pairB = Math.exp(-Math.pow((v - locus.center + pairOffset) / pairWidth, 2));
      const lane = (Math.floor((u + 1) * 15 + locus.phase) % 5) < 3;
      if (Math.max(pairA, pairB) > 0.26 && lane) {
        mappedSamples.push({ sourceIndex, tone: locusIndex % 2, locusIndex });
        break;
      }
    }
  });
  const mappedPositions = new Float32Array(mappedSamples.length * 3);
  const mappedColors = new Float32Array(mappedSamples.length * 3);
  mappedSamples.forEach((sample, index) => {
    const mappedTone = sample.tone ? mappedColor : locusColor;
    mappedColors[index * 3] = mappedTone.r;
    mappedColors[index * 3 + 1] = mappedTone.g;
    mappedColors[index * 3 + 2] = mappedTone.b;
  });
  const mappedGeometry = new THREE.BufferGeometry();
  mappedGeometry.setAttribute("position", new THREE.BufferAttribute(mappedPositions, 3));
  mappedGeometry.setAttribute("color", new THREE.BufferAttribute(mappedColors, 3));
  const mappedLoci = new THREE.Points(
    mappedGeometry,
    new THREE.PointsMaterial({
      size: coarsePointer ? 0.071 : 0.056,
      map: dotTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      alphaTest: 0.07,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  mappedLoci.renderOrder = 3;
  addPointerScatter(mappedLoci.material, 0.78);
  sculpture.add(mappedLoci);
  const thoughtCount = coarsePointer ? 72 : 120;
  const thoughtPulseOffsets = [0, 0.31, 0.63];
  const thoughtHeadSize = coarsePointer ? 0.15 : 0.12;
  const thoughtHaloSize = coarsePointer ? 0.32 : 0.26;
  const thoughtSamples = Array.from({ length: thoughtCount }, (_, index) => {
    const t = index / (thoughtCount - 1);
    const row = Math.round(t * (rows - 1));
    const v = row / (rows - 1) * 2 - 1;
    const laneU = 0.48 + Math.sin(v * 4.8 + 1.1) * 0.13 + Math.sin(v * 11.2) * 0.025;
    const column = Math.round(clamp((laneU + 1) * 0.5) * (columns - 1));
    return { sourceIndex: row * columns + column, t, v };
  });
  const thoughtPositions = new Float32Array(thoughtCount * 3);
  const thoughtColors = new Float32Array(thoughtCount * 3);
  const thoughtGeometry = new THREE.BufferGeometry();
  thoughtGeometry.setAttribute("position", new THREE.BufferAttribute(thoughtPositions, 3));
  thoughtGeometry.setAttribute("color", new THREE.BufferAttribute(thoughtColors, 3));
  const thoughtTrace = new THREE.Points(
    thoughtGeometry,
    new THREE.PointsMaterial({
      size: coarsePointer ? 0.09 : 0.071,
      map: dotTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      alphaTest: 0.06,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  thoughtTrace.renderOrder = 4;
  addPointerScatter(thoughtTrace.material, 0.52);
  sculpture.add(thoughtTrace);
  const thoughtHeadGeometry = new THREE.BufferGeometry();
  const thoughtHeadPosition = new Float32Array(thoughtPulseOffsets.length * 3);
  thoughtHeadGeometry.setAttribute("position", new THREE.BufferAttribute(thoughtHeadPosition, 3));
  const thoughtHalo = new THREE.Points(
    thoughtHeadGeometry,
    new THREE.PointsMaterial({
      size: thoughtHaloSize,
      map: dotTexture,
      color: 0x2a9765,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  thoughtHalo.renderOrder = 5;
  sculpture.add(thoughtHalo);
  const thoughtHead = new THREE.Points(
    thoughtHeadGeometry,
    new THREE.PointsMaterial({
      size: thoughtHeadSize,
      map: dotTexture,
      color: 0x0d563a,
      transparent: true,
      opacity: 0.96,
      alphaTest: 0.05,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  thoughtHead.renderOrder = 6;
  sculpture.add(thoughtHead);

  const ctaSculpture = ctaScene ? new THREE.Group() : null;
  let ctaDust = null;
  let ctaFloaters = null;
  if (ctaSculpture) {
    for (const source of [points, softLayer, mappedLoci, thoughtTrace, thoughtHalo, thoughtHead]) {
      const layer = new THREE.Points(source.geometry, source.material);
      layer.renderOrder = source.renderOrder;
      ctaSculpture.add(layer);
    }
    ctaDust = new THREE.Points(dust.geometry, dust.material);
    ctaFloaters = new THREE.Points(floaters.geometry, floaters.material);
    ctaScene.add(ctaDust, ctaFloaters, ctaSculpture);
  }
  const color = new THREE.Color();
  const mappedPulseColor = new THREE.Color(0x42bd80);
  const mappedBaseColor = new THREE.Color();
  const thoughtColor = new THREE.Color();
  const thoughtRestColor = new THREE.Color(0xc7ddd2);
  const pointer = new THREE.Vector2();
  const pointerTarget = new THREE.Vector2();
  const scatterPointer = new THREE.Vector2(2, 2);
  let compact = false;
  let ctaCompact = false;
  let baseScale = 1.24;
  let baseX = 1.57;
  let baseY = -2.38;
  let baseZ = 1.54;
  let scrollTarget = 0;
  let scrollProgress = 0;
  let scatterEnergy = 0;
  let scatterImpulse = 0;
  let heroVisible = true;
  let ctaVisible = false;
  let active = true;
  let frameHandle = 0;

  function makeDotTexture() {
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = 48;
    textureCanvas.height = 48;
    const context = textureCanvas.getContext("2d");
    const gradient = context.createRadialGradient(24, 24, 1, 24, 24, 22);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.6, "rgba(255,255,255,.98)");
    gradient.addColorStop(0.78, "rgba(255,255,255,.58)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 48, 48);
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function seeded(index, salt = 0) {
    const value = Math.sin(index * 91.733 + salt * 37.719) * 43758.5453;
    return value - Math.floor(value);
  }

  function sampleThoughtPulse(flow, target, targetOffset) {
    const scaled = clamp(flow) * (thoughtCount - 1);
    const index1 = Math.floor(scaled);
    const index0 = Math.max(0, index1 - 1);
    const index2 = Math.min(thoughtCount - 1, index1 + 1);
    const index3 = Math.min(thoughtCount - 1, index1 + 2);
    const t = scaled - index1;
    const t2 = t * t;
    const t3 = t2 * t;
    const sources = [index0, index1, index2, index3]
      .map((index) => thoughtSamples[index].sourceIndex * 3);

    for (let axis = 0; axis < 3; axis += 1) {
      const p0 = positions[sources[0] + axis];
      const p1 = positions[sources[1] + axis];
      const p2 = positions[sources[2] + axis];
      const p3 = positions[sources[3] + axis];
      target[targetOffset + axis] = 0.5 * (
        2 * p1
        + (-p0 + p2) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
      );
    }
  }

  function addPointerScatter(material, layerStrength) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uScatterPointer = scatterUniforms.pointer;
      shader.uniforms.uScatterAmount = scatterUniforms.amount;
      shader.uniforms.uScatterTime = scatterUniforms.time;
      shader.uniforms.uScatterLayer = { value: layerStrength };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
uniform vec2 uScatterPointer;
uniform float uScatterAmount;
uniform float uScatterTime;
uniform float uScatterLayer;`,
        )
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
vec2 scatterNdc = gl_Position.xy / max(gl_Position.w, 0.0001);
vec2 scatterDelta = scatterNdc - uScatterPointer;
float scatterDistance = length(scatterDelta);
float scatterInfluence = 1.0 - smoothstep(0.0, 0.26, scatterDistance);
scatterInfluence *= scatterInfluence;
float scatterSeed = fract(sin(dot(position.xy + position.yz, vec2(12.9898, 78.233))) * 43758.5453);
float scatterWave = 0.72 + sin(uScatterTime * 0.003 + scatterSeed * 6.28318) * 0.28;
vec2 scatterRadial = scatterDistance > 0.0001 ? scatterDelta / scatterDistance : vec2(1.0, 0.0);
vec2 scatterTangent = vec2(-scatterRadial.y, scatterRadial.x) * (scatterSeed - 0.5) * 1.6;
vec2 scatterDirection = normalize(scatterRadial + scatterTangent);
gl_Position.xy += scatterDirection * scatterInfluence * scatterWave * uScatterAmount * uScatterLayer * gl_Position.w;`,
        )
        .replace(
          "gl_PointSize = size;",
          "gl_PointSize = size * (1.0 + scatterInfluence * min(uScatterAmount * 8.0, 0.22));",
        );
    };
    material.customProgramCacheKey = () => `hunch-pointer-scatter-${layerStrength}`;
  }

  function makeParticleField(count, texture, large) {
    const fieldPositions = [];
    const fieldColors = [];
    const fieldColor = new THREE.Color();
    const pale = new THREE.Color(0x92aa9e);
    const dark = new THREE.Color(0x365f4c);
    for (let index = 0; index < count; index += 1) {
      fieldPositions.push(
        (seeded(index, large ? 17 : 19) - 0.5) * 19,
        (seeded(index, large ? 23 : 29) - 0.5) * 12,
        -1.5 - seeded(index, large ? 31 : 37) * 14,
      );
      fieldColor.copy(dark).lerp(pale, seeded(index, large ? 41 : 43));
      fieldColors.push(fieldColor.r, fieldColor.g, fieldColor.b);
    }
    const fieldGeometry = new THREE.BufferGeometry();
    fieldGeometry.setAttribute("position", new THREE.Float32BufferAttribute(fieldPositions, 3));
    fieldGeometry.setAttribute("color", new THREE.Float32BufferAttribute(fieldColors, 3));
    return new THREE.Points(
      fieldGeometry,
      new THREE.PointsMaterial({
        size: large ? (coarsePointer ? 0.062 : 0.075) : (coarsePointer ? 0.017 : 0.021),
        map: texture,
        vertexColors: true,
        transparent: true,
        opacity: large ? 0.11 : 0.2,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
  }

  function updateSculpture(time, progress) {
    const direction = rtl ? -1 : 1;
    const rotation = time * 0.000018 + direction * (1.78 + progress * 1.72);

    for (let index = 0; index < pointCount; index += 1) {
      const { u, v, seed } = coordinates[index];
      const width = 3.58 * (0.94 + Math.cos(v * Math.PI) * 0.06);
      const angle = v * Math.PI * 1.34 + rotation;
      const radial = u * width;
      const offset = index * 3;
      positions[offset] = radial * Math.cos(angle);
      positions[offset + 1] = v * sheetHalfHeight;
      positions[offset + 2] = radial * Math.sin(angle);

      const depth = Math.sin(angle) * 0.5 + 0.5;
      color.copy(farColor).lerp(midColor, clamp(depth * 1.15));
      color.lerp(nearColor, clamp((depth - 0.48) * 1.4));

      let locusWeight = 0;
      let pairedWeight = 0;
      let locusTone = 0;
      for (let locusIndex = 0; locusIndex < geneLoci.length; locusIndex += 1) {
        const locus = geneLoci[locusIndex];
        const broadDistance = (v - locus.center) / locus.span;
        const broadBand = Math.exp(-Math.pow(broadDistance, 6));
        const pairOffset = locus.span * 0.4;
        const pairWidth = Math.max(0.012, locus.span * 0.24);
        const pairA = Math.exp(-Math.pow((v - locus.center - pairOffset) / pairWidth, 2));
        const pairB = Math.exp(-Math.pow((v - locus.center + pairOffset) / pairWidth, 2));
        const lane = (Math.floor((u + 1) * 15 + locus.phase) % 5) < 3 ? 1 : 0.16;
        if (broadBand > locusWeight) {
          locusWeight = broadBand;
          locusTone = locusIndex % 2;
        }
        pairedWeight = Math.max(pairedWeight, Math.max(pairA, pairB) * lane);
      }
      color.lerp(quietColor, locusWeight * 0.56);
      color.lerp(locusTone ? mappedColor : locusColor, pairedWeight * 0.96);
      color.offsetHSL(0, 0, (seed - 0.5) * 0.035);
      colors[offset] = color.r;
      colors[offset + 1] = color.g;
      colors[offset + 2] = color.b;
    }

    const thoughtFlow = (time * 0.00004 + progress * 0.08) % 1;
    const pulseFlows = thoughtPulseOffsets.map((pulseOffset) => (thoughtFlow + pulseOffset) % 1);
    const locusActivations = geneLoci.map((locus) => {
      let activation = 0;
      for (const pulseFlow of pulseFlows) {
        const pulseV = THREE.MathUtils.lerp(-1, 1, pulseFlow);
        const distance = (pulseV - locus.center) / Math.max(0.035, locus.span * 0.72);
        activation = Math.max(activation, Math.exp(-distance * distance * 1.8));
      }
      return activation;
    });
    const decisionBeat = Math.max(...locusActivations);

    mappedSamples.forEach((sample, index) => {
      const sourceOffset = sample.sourceIndex * 3;
      const targetOffset = index * 3;
      mappedPositions[targetOffset] = positions[sourceOffset];
      mappedPositions[targetOffset + 1] = positions[sourceOffset + 1];
      mappedPositions[targetOffset + 2] = positions[sourceOffset + 2];
      mappedBaseColor
        .copy(sample.tone ? mappedColor : locusColor)
        .lerp(mappedPulseColor, locusActivations[sample.locusIndex] * 0.96);
      mappedColors[targetOffset] = mappedBaseColor.r;
      mappedColors[targetOffset + 1] = mappedBaseColor.g;
      mappedColors[targetOffset + 2] = mappedBaseColor.b;
    });

    for (let index = 0; index < thoughtCount; index += 1) {
      const sample = thoughtSamples[index];
      const sourceOffset = sample.sourceIndex * 3;
      const offset = index * 3;
      thoughtPositions[offset] = positions[sourceOffset];
      thoughtPositions[offset + 1] = positions[sourceOffset + 1];
      thoughtPositions[offset + 2] = positions[sourceOffset + 2];

      let active = 0;
      let head = 0;
      for (const pulseFlow of pulseFlows) {
        const trail = (pulseFlow - sample.t + 1) % 1;
        const tailUnit = trail < 0.155 ? 1 - trail / 0.155 : 0;
        const pulseTail = tailUnit * tailUnit * (3 - 2 * tailUnit);
        active = Math.max(active, pulseTail);
        const headUnit = trail < 0.044 ? 1 - trail / 0.044 : 0;
        head = Math.max(head, headUnit * headUnit * (3 - 2 * headUnit));
      }
      thoughtColor.copy(thoughtRestColor).lerp(memoryColor, active);
      thoughtColor.lerp(mappedColor, head * 0.9);
      thoughtColors[offset] = thoughtColor.r;
      thoughtColors[offset + 1] = thoughtColor.g;
      thoughtColors[offset + 2] = thoughtColor.b;
    }
    pulseFlows.forEach((pulseFlow, pulseIndex) => {
      const offset = pulseIndex * 3;
      sampleThoughtPulse(pulseFlow, thoughtHeadPosition, offset);
    });
    const breath = Math.sin(time * 0.0022) * 0.5 + 0.5;
    thoughtTrace.material.opacity = 0.86 + breath * 0.08;
    thoughtHead.material.size = thoughtHeadSize * (1 + breath * 0.08 + decisionBeat * 0.28);
    thoughtHalo.material.size = thoughtHaloSize * (1 + breath * 0.12 + decisionBeat * 0.42);
    thoughtHalo.material.opacity = 0.1 + breath * 0.04 + decisionBeat * 0.13;

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    mappedGeometry.attributes.position.needsUpdate = true;
    mappedGeometry.attributes.color.needsUpdate = true;
    thoughtGeometry.attributes.position.needsUpdate = true;
    thoughtGeometry.attributes.color.needsUpdate = true;
    thoughtHeadGeometry.attributes.position.needsUpdate = true;
  }

  function updateLayout() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    compact = width < 720;
    baseScale = compact ? 0.9424 : 1.24;
    baseX = rtl ? (compact ? -1.01 : -1.57) : (compact ? 1.01 : 1.57);
    baseY = compact ? -1.65 : -2.38;
    baseZ = 1.54;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarsePointer ? 1.2 : 1.65));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.fov = compact ? 42 : 36;
    camera.updateProjectionMatrix();

    if (ctaRenderer && ctaCanvas && ctaCamera) {
      const ctaRect = ctaCanvas.getBoundingClientRect();
      const ctaWidth = Math.max(1, Math.round(ctaRect.width));
      const ctaHeight = Math.max(1, Math.round(ctaRect.height));
      ctaCompact = ctaWidth < 720;
      ctaRenderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarsePointer ? 1.15 : 1.55));
      ctaRenderer.setSize(ctaWidth, ctaHeight, false);
      ctaCamera.aspect = ctaWidth / ctaHeight;
      ctaCamera.fov = ctaCompact ? 43 : 35;
      ctaCamera.updateProjectionMatrix();
    }
  }

  function readScroll() {
    const rect = hero.getBoundingClientRect();
    const travel = Math.max(1, hero.offsetHeight - innerHeight);
    scrollTarget = clamp((hero.offsetTop - rect.top) / travel);
    schedule();
  }

  function readPointer(event) {
    const nextX = (event.clientX / innerWidth - 0.5) * 2;
    const nextY = (event.clientY / innerHeight - 0.5) * -2;
    if (!coarsePointer && !reduceMotion) {
      const velocity = Math.hypot(nextX - pointerTarget.x, nextY - pointerTarget.y);
      scatterImpulse = Math.min(1, scatterImpulse + velocity * 4.8);
    }
    pointerTarget.set(nextX, nextY);
    schedule();
  }

  function settlePointer() {
    scatterImpulse = 0;
    scatterPointer.set(2, 2);
  }

  function render(time = 0) {
    scrollProgress += (scrollTarget - scrollProgress) * (reduceMotion ? 1 : 0.052);
    pointer.lerp(pointerTarget, reduceMotion ? 1 : 0.035);
    scatterPointer.lerp(pointerTarget, reduceMotion ? 1 : 0.24);
    scatterEnergy += (scatterImpulse - scatterEnergy) * 0.18;
    scatterImpulse *= 0.9;
    scatterUniforms.pointer.value.copy(scatterPointer);
    scatterUniforms.amount.value = coarsePointer || reduceMotion ? 0 : scatterEnergy * 0.034;
    scatterUniforms.time.value = time;
    const quietTime = reduceMotion ? 2200 : time;
    updateSculpture(quietTime, scrollProgress);

    const journey = range(0.02, 0.98, scrollProgress);
    const direction = rtl ? -1 : 1;

    points.material.opacity = 0.96;
    softLayer.material.opacity = 0.055;
    mappedLoci.material.opacity = 0.88;
    sculpture.scale.setScalar(baseScale * (1 + journey * (compact ? 0.025 : 0.055)));
    sculpture.position.x = baseX
      + direction * journey * (compact ? 0.24 : 0.65)
      + pointer.x * (compact ? 0.045 : 0.12);
    sculpture.position.y = baseY
      + journey * (compact ? 1.0 : 1.8)
      + pointer.y * 0.06;
    sculpture.position.z = baseZ + journey * (compact ? 0.08 : 0.22);
    sculpture.rotation.x = 0.08 + journey * 0.055;
    sculpture.rotation.y = pointer.x * 0.02 + direction * (0.12 + journey * 0.08);
    sculpture.rotation.z = direction * (-0.138 + journey * 0.09);

    dust.rotation.y = quietTime * 0.000004 + pointer.x * 0.014;
    dust.rotation.x = pointer.y * 0.008;
    dust.material.opacity = 0.2;
    dust.scale.setScalar(1);
    floaters.rotation.y = -quietTime * 0.000009 + pointer.x * 0.022;
    floaters.rotation.x = quietTime * 0.000003 + pointer.y * 0.014;
    floaters.position.y = Math.sin(quietTime * 0.00015) * 0.12;
    floaters.material.opacity = 0.11;
    floaters.scale.setScalar(1);

    if (ctaSculpture && ctaCamera) {
      const ctaBreath = Math.sin(quietTime * 0.00022) * 0.035;
      ctaSculpture.scale.setScalar((ctaCompact ? 0.82 : 0.96) + ctaBreath);
      ctaSculpture.position.set(
        direction * (ctaCompact ? 1.42 : 3.2) + pointer.x * (ctaCompact ? 0.025 : 0.08),
        (ctaCompact ? -0.34 : -0.42) + pointer.y * 0.035,
        1.22,
      );
      ctaSculpture.rotation.set(
        0.13,
        direction * 0.12 + pointer.x * 0.014,
        direction * (ctaCompact ? -0.15 : -0.1),
      );
      ctaDust.rotation.y = quietTime * 0.000003;
      ctaDust.position.x = direction * 1.8;
      ctaFloaters.rotation.y = -quietTime * 0.000007;
      ctaFloaters.position.x = direction * 1.4;
      ctaFloaters.position.y = Math.sin(quietTime * 0.00018) * 0.1;
      ctaCamera.position.x += (pointer.x * 0.08 - ctaCamera.position.x) * 0.025;
      ctaCamera.position.y += (pointer.y * 0.05 - ctaCamera.position.y) * 0.025;
      ctaCamera.position.z += (11.4 - ctaCamera.position.z) * 0.04;
      ctaCamera.lookAt(0, 0, 0);
    }

    camera.position.x += (pointer.x * 0.17 - camera.position.x) * 0.035;
    camera.position.y += (pointer.y * 0.1 - camera.position.y) * 0.035;
    camera.position.z += (THREE.MathUtils.lerp(11.15, 10.9, journey) - camera.position.z) * 0.04;
    camera.lookAt(0, 0, 0);

    hero.style.setProperty("--dna-progress", scrollProgress.toFixed(3));
    canvas.dataset.dnaProgress = scrollProgress.toFixed(3);
    canvas.dataset.dnaScatter = scatterUniforms.amount.value.toFixed(4);
    if (heroVisible || reduceMotion) renderer.render(scene, camera);
    if (ctaRenderer && ctaScene && ctaCamera && (ctaVisible || reduceMotion)) {
      ctaCanvas.dataset.dnaProgress = scrollProgress.toFixed(3);
      ctaRenderer.render(ctaScene, ctaCamera);
    }
  }

  function frame(time) {
    frameHandle = 0;
    if (!active || document.hidden) return;
    render(time);
    schedule();
  }

  function schedule() {
    if (!reduceMotion && !frameHandle && active && !document.hidden) {
      frameHandle = requestAnimationFrame(frame);
    }
  }

  const resizeObserver = new ResizeObserver(() => {
    updateLayout();
    readScroll();
    if (reduceMotion) render(2200);
  });
  resizeObserver.observe(canvas);
  if (ctaCanvas) resizeObserver.observe(ctaCanvas);
  addEventListener("scroll", readScroll, { passive: true });
  addEventListener("pointermove", readPointer, { passive: true });
  addEventListener("pointerleave", settlePointer, { passive: true });
  document.addEventListener("visibilitychange", schedule);

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === hero) heroVisible = entry.isIntersecting;
        if (entry.target === ctaSection) ctaVisible = entry.isIntersecting;
      }
      active = heroVisible || ctaVisible;
      schedule();
    }, { rootMargin: "15% 0px" });
    observer.observe(hero);
    if (ctaRenderer && ctaSection) observer.observe(ctaSection);
  }

  addEventListener("pagehide", () => {
    cancelAnimationFrame(frameHandle);
    resizeObserver.disconnect();
    renderer.dispose();
    if (ctaRenderer) ctaRenderer.dispose();
  }, { once: true });

  updateLayout();
  readScroll();
  render(2200);
  schedule();
}
