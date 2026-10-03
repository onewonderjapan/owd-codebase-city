import * as THREE from "three";
import { CELL, STREET, type CityFile, type Model } from "./repo";

/* ═══════════════════════════════════════════════════════════════════════
   三维 —— 一整座等距城，逐帧写实例矩阵、连线顶点和流动点。这一层是命令式的，
   React 只给它 canvas / 舞台 / 那块跟着鼠标走的浮标，再接住选中与缩放的变化。
   ═══════════════════════════════════════════════════════════════════════ */

export type MarkMode = "iso" | "issue" | null;

export interface City {
  setFlow: (v: boolean) => void;
  setHatch: (v: boolean) => void;
  setSpin: (v: boolean) => void;
  onSpinChange: (fn: (v: boolean) => void) => void;
  dolly: (f: number) => void;
  reset: () => void;
  setSel: (f: CityFile | null) => void;
  setRailHover: (f: CityFile | null) => void;
  setQuery: (q: string) => void;
  setMarkMode: (m: MarkMode) => void;
  dispose: () => void;
}

/* 标记模式的配色：孤立 = 砖红，问题按严重度分档 —— 蓝图纸上盖章的那一路红 */
const MARK_COLORS: Record<number, string> = {
  1: "#ffc233", // low · 琥珀
  2: "#ff7a2e", // medium · 信号橙
  3: "#ff3d5e", // high · 警报红
};
const ISO_COLOR = "#ff3d5e";

export function createCity(
  cv: HTMLCanvasElement | null,
  stage: HTMLDivElement | null,
  tip: HTMLDivElement | null,
  model: Model,
  { onSelect, onZoom }: { onSelect: (f: CityFile | null) => void; onZoom: (z: number) => void },
): City | null {
  if (!cv || !stage || !tip) return null;
  let renderer: THREE.WebGLRenderer | undefined;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, canvas: cv });
  } catch (e) {
    /* fallthrough */
  }
  if (!renderer) return null;

  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  const { files, edges, plots, shadeOf, hOf, colorOf } = model;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 600);

  const BOX_VERT = `
    attribute vec3 aColor; attribute vec2 aHi;   // x=高亮 y=淡出
    varying vec3 vN, vW, vColor, vL; varying vec2 vHi;
    void main(){
      vColor = aColor; vHi = aHi; vL = position;
      vec3 tp = position;
      #ifdef USE_INSTANCING
        tp = (instanceMatrix * vec4(position, 1.0)).xyz;
        vN = normalize(mat3(instanceMatrix) * normal);
      #else
        vN = normal;
      #endif
      vW = tp;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(tp, 1.0);
    }`;

  const BOX_FRAG = `
    precision highp float;
    varying vec3 vN, vW, vColor, vL; varying vec2 vHi;
    uniform float uHatch, uTime;
    void main(){
      vec3 n = normalize(vN);
      // 全息玻璃楼：面是近黑的深玻璃，颜色渗进去一点；顶面最亮
      float f = n.y > 0.5 ? 1.0 : (abs(n.x) > 0.5 ? 0.5 : 0.3);
      vec3 glass = vec3(0.014, 0.024, 0.045);
      vec3 c = mix(glass, vColor, n.y > 0.5 ? 0.34 : 0.22) * (0.45 + 0.55 * f);
      // 顶面自发光镶边（「晕滃」开关现在控制这个）
      if (n.y > 0.5 && uHatch > 0.5) {
        float e = max(abs(vL.x), abs(vL.z));   // 局部坐标：0.5 即楼边缘
        c += vColor * 0.9 * smoothstep(0.38, 0.5, e);
      }
      // 高亮：提亮到近白，加辉光感
      c = mix(c, vColor * 1.4 + vec3(0.55), vHi.x * 0.62);
      // 淡出：沉回背景
      c = mix(vec3(0.016, 0.028, 0.05), c, mix(0.22, 1.0, 1.0 - vHi.y));
      gl_FragColor = vec4(c, 1.0);
    }`;

  const N = files.length;
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const boxMat = new THREE.ShaderMaterial({
    uniforms: { uHatch: { value: 1 }, uTime: { value: 0 } },
    vertexShader: BOX_VERT,
    fragmentShader: BOX_FRAG,
  });
  const boxes = new THREE.InstancedMesh(boxGeo, boxMat, N);
  // 自定义实例属性必须手动声明，否则 InstancedMesh 的默认
  // instanceColor 绑定会抢先占用，aColor 根本进不了着色器。
  boxes.instanceColor = null;
  boxes.frustumCulled = false;
  const bColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  const bHi = new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2);
  boxGeo.setAttribute("aColor", bColor);
  boxGeo.setAttribute("aHi", bHi);
  scene.add(boxes);

  // 全息线框：轮廓线跟着楼色走，用顶点色
  const edgeGeo = new THREE.EdgesGeometry(boxGeo);
  const outlineMats: THREE.LineBasicMaterial[] = [];
  const outlineGroup = new THREE.Group();
  for (const f of files) {
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(colorOf(f)).multiplyScalar(0.85),
      transparent: true,
      opacity: 0.55,
    });
    outlineMats.push(mat);
    const o = new THREE.LineSegments(edgeGeo, mat);
    o.userData.f = f;
    outlineGroup.add(o);
  }
  scene.add(outlineGroup);

  const plotGroup = new THREE.Group();
  scene.add(plotGroup);
  for (const p of plots) {
    const g = new THREE.Mesh(
      new THREE.BoxGeometry(p.w - STREET * 0.45, 0.5, p.h - STREET * 0.45),
      new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: `varying vec3 vN; varying vec3 vW;
          void main(){ vN = normal; vW = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `precision mediump float; varying vec3 vN; varying vec3 vW;
          void main(){
            // 停机坪：近黑板面 + 青色细网格
            float f = vN.y > 0.5 ? 1.0 : 0.55;
            vec3 c = vec3(0.020, 0.034, 0.055) * f;
            if (vN.y > 0.5) {
              vec2 g = abs(fract(vW.xz * 0.5) - 0.5);
              c += vec3(0.05, 0.28, 0.26) * smoothstep(0.44, 0.5, max(g.x, g.y)) * 0.55;
            }
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    g.position.set(p.x + p.w / 2, -0.25, p.z + p.h / 2);
    plotGroup.add(g);
  }

  /* ── 依赖流：沿边爬行的数据点 ── */
  const FLOW_PER = 3;
  const FLOWN = Math.max(1, edges.length * FLOW_PER);
  const fPos = new Float32Array(FLOWN * 3);
  const fA = new Float32Array(FLOWN);
  const fGeo = new THREE.BufferGeometry();
  fGeo.setAttribute("position", new THREE.BufferAttribute(fPos, 3));
  fGeo.setAttribute("aA", new THREE.BufferAttribute(fA, 1));
  const flow = new THREE.Points(
    fGeo,
    new THREE.ShaderMaterial({
      uniforms: { uPx: { value: 4 } },
      vertexShader: `attribute float aA; varying float vA; uniform float uPx;
        void main(){ vA = aA;
          gl_PointSize = uPx;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `precision mediump float; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0 || vA <= 0.0) discard;
          gl_FragColor = vec4(0.30, 0.95, 0.88, (1.0 - d) * vA);
        }`,
      transparent: true,
      depthWrite: false,
    }),
  );
  flow.frustumCulled = false;
  scene.add(flow);

  const lPos = new Float32Array(Math.max(1, edges.length) * 6);
  const lA = new Float32Array(Math.max(1, edges.length) * 2);
  const lGeo = new THREE.BufferGeometry();
  lGeo.setAttribute("position", new THREE.BufferAttribute(lPos, 3));
  lGeo.setAttribute("aA", new THREE.BufferAttribute(lA, 1));
  const links = new THREE.LineSegments(
    lGeo,
    new THREE.ShaderMaterial({
      vertexShader: `attribute float aA; varying float vA;
        void main(){ vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `precision mediump float; varying float vA;
        void main(){ gl_FragColor = vec4(0.16, 0.72, 0.68, vA); }`,
      transparent: true,
      depthWrite: false,
    }),
  );
  links.frustumCulled = false;
  scene.add(links);

  const cam = { yaw: Math.PI * 0.25, tYaw: Math.PI * 0.25, zoom: 12, tZoom: 12 };
  const ISO_PITCH = Math.atan(1 / Math.SQRT2);

  let dragging = false,
    lastX = 0,
    moved = 0,
    spin = true;
  const mouse = { x: -1, y: -1, live: false };
  const ac = new AbortController();
  const opt = { signal: ac.signal } as AddEventListenerOptions;

  cv.addEventListener(
    "pointerdown",
    (e) => {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      cv.setPointerCapture(e.pointerId);
      cv.classList.add("drag");
    },
    opt,
  );
  cv.addEventListener(
    "pointerup",
    (e) => {
      dragging = false;
      cv.classList.remove("drag");
      try {
        cv.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* noop */
      }
    },
    opt,
  );
  cv.addEventListener(
    "pointermove",
    (e) => {
      const r = cv.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
      mouse.live = true;
      if (!dragging) return;
      moved += Math.abs(e.clientX - lastX);
      cam.tYaw -= (e.clientX - lastX) * 0.006;
      lastX = e.clientX;
      spin = false;
      onSpin(false);
    },
    opt,
  );
  cv.addEventListener("pointerleave", () => (mouse.live = false), opt);
  const ZOOM0 = cam.tZoom;
  const syncZoom = () => onZoom(Math.round((ZOOM0 / cam.tZoom) * 100));
  const dolly = (f: number) => {
    cam.tZoom = Math.max(4, Math.min(34, cam.tZoom * f));
    syncZoom();
  };
  cv.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      dolly(1 + Math.sign(e.deltaY) * 0.11);
    },
    { passive: false, signal: ac.signal } as AddEventListenerOptions,
  );
  syncZoom();

  let hover: CityFile | null = null,
    sel: CityFile | null = null,
    railHover: CityFile | null = null,
    query = "",
    markMode: MarkMode = null,
    onSpin: (v: boolean) => void = () => {};
  cv.addEventListener(
    "click",
    () => {
      if (moved > 5) return;
      onSelect(hover && sel !== hover ? hover : null);
    },
    opt,
  );

  const v3 = new THREE.Vector3(),
    im = new THREE.Matrix4(),
    tmpC = new THREE.Color(),
    markC = new THREE.Color();
  let showFlow = true,
    last = performance.now(),
    raf = 0,
    dead = false;

  function frame(now: number) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const w = stage!.clientWidth,
      h = stage!.clientHeight;
    if (!w || !h) return;
    if (cv!.width !== Math.round(w * renderer!.getPixelRatio())) renderer!.setSize(w, h, false);

    const k = 1 - Math.pow(0.002, dt);
    if (spin) cam.tYaw += dt * 0.12;
    cam.yaw += (cam.tYaw - cam.yaw) * k;
    cam.zoom += (cam.tZoom - cam.zoom) * k;

    const halfH = cam.zoom * 4,
      halfW = halfH * (w / h);
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
    const d = 180;
    camera.position.set(
      Math.cos(cam.yaw) * Math.cos(ISO_PITCH) * d,
      Math.sin(ISO_PITCH) * d,
      Math.sin(cam.yaw) * Math.cos(ISO_PITCH) * d,
    );
    camera.lookAt(0, 6, 0);

    const near = sel ? new Set([sel.path, ...sel.deps, ...sel.usedBy]) : null;
    const focus = sel || hover || railHover;
    const pulse = 0.5 + 0.5 * Math.sin(now / 480); // 标记模式的呼吸高亮

    files.forEach((f, i) => {
      const hh = hOf(f);
      f.h = f.h === undefined ? hh : f.h + (hh - f.h) * k * 0.6;
      im.makeScale(CELL * 0.68, f.h, CELL * 0.68);
      im.setPosition(f.x, f.h / 2, f.z);
      boxes.setMatrixAt(i, im);
      const o = outlineGroup.children[i];
      o.scale.set(CELL * 0.68, f.h, CELL * 0.68);
      o.position.set(f.x, f.h / 2, f.z);

      // 标记模式：命中的楼换成「盖章红」，其余淡出
      const marked = markMode === "iso" ? f.isolated : markMode === "issue" ? f.issueRank > 0 : false;
      if (markMode && marked) {
        markC.set(markMode === "iso" ? ISO_COLOR : MARK_COLORS[f.issueRank] || MARK_COLORS[1]);
        tmpC.copy(markC);
      } else {
        tmpC.set(colorOf(f)).offsetHSL(0, 0, (shadeOf.get(f.dir)! - 0.5) * 0.17);
      }
      bColor.array[i * 3] = tmpC.r;
      bColor.array[i * 3 + 1] = tmpC.g;
      bColor.array[i * 3 + 2] = tmpC.b;

      let hi = f === focus ? 1 : 0;
      let fade = near
        ? near.has(f.path)
          ? 0
          : 1
        : query && !f.path.toLowerCase().includes(query)
          ? 1
          : 0;
      if (markMode && !near) {
        if (marked) {
          hi = Math.max(hi, 0.15 + 0.22 * pulse);
          fade = 0;
        } else fade = 1;
      }
      bHi.array[i * 2] += (hi - bHi.array[i * 2]) * k;
      bHi.array[i * 2 + 1] += (fade - bHi.array[i * 2 + 1]) * k;
    });
    boxes.instanceMatrix.needsUpdate = true;
    bColor.needsUpdate = bHi.needsUpdate = true;

    edges.forEach((e, i) => {
      const a = e.from,
        b = e.to;
      const o = i * 6;
      lPos[o] = a.x;
      lPos[o + 1] = a.h!;
      lPos[o + 2] = a.z;
      lPos[o + 3] = b.x;
      lPos[o + 4] = b.h!;
      lPos[o + 5] = b.z;
      const on = !near || (near.has(a.path) && near.has(b.path));
      const strong = sel && (a === sel || b === sel);
      const al = strong ? 0.55 : on ? 0.1 : 0.02;
      lA[i * 2] += (al - lA[i * 2]) * k;
      lA[i * 2 + 1] = lA[i * 2];

      for (let j = 0; j < FLOW_PER; j++) {
        const idx = i * FLOW_PER + j;
        const t = (now / 2600 + (i * 0.37 + j / FLOW_PER)) % 1;
        const lift = Math.sin(t * Math.PI) * Math.hypot(b.x - a.x, b.z - a.z) * 0.22;
        fPos[idx * 3] = a.x + (b.x - a.x) * t;
        fPos[idx * 3 + 1] = a.h! + (b.h! - a.h!) * t + lift + 1.2;
        fPos[idx * 3 + 2] = a.z + (b.z - a.z) * t;
        fA[idx] = (showFlow ? 1 : 0) * (strong ? 1 : on ? 0.45 : 0.06) * Math.sin(t * Math.PI);
      }
    });
    lGeo.getAttribute("position").needsUpdate = true;
    lGeo.getAttribute("aA").needsUpdate = true;
    fGeo.getAttribute("position").needsUpdate = true;
    fGeo.getAttribute("aA").needsUpdate = true;
    (flow.material as THREE.ShaderMaterial).uniforms.uPx.value = 3.4 * renderer!.getPixelRatio();

    // 拾取：把楼顶中心投到屏幕上取最近的
    if (mouse.live && !dragging) {
      let best: CityFile | null = null,
        bd = 26 * 26;
      for (const f of files) {
        v3.set(f.x, f.h! * 0.6, f.z).project(camera);
        const sx = (v3.x * 0.5 + 0.5) * w,
          sy = (-v3.y * 0.5 + 0.5) * h;
        const d2 = (sx - mouse.x) ** 2 + (sy - mouse.y) ** 2;
        if (d2 < bd) {
          bd = d2;
          best = f;
          f.sx = sx;
          f.sy = sy;
        }
      }
      hover = best;
      cv!.style.cursor = dragging ? "grabbing" : best ? "pointer" : "grab";
    } else if (!mouse.live) hover = null;

    if (hover) {
      tip!.style.display = "block";
      tip!.style.left = hover.sx + "px";
      tip!.style.top = hover.sy + "px";
      tip!.innerHTML = `<b>${hover.name}</b> · ${hover.loc} 行<br>${hover.dir} · ${hover.usedBy.length} 箇所から参照${hover.isolated ? "<br>⚠ 孤立ファイル" : ""}`;
    } else tip!.style.display = "none";

    renderer!.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    setFlow: (v) => {
      showFlow = v;
    },
    setHatch: (v) => {
      boxMat.uniforms.uHatch.value = v ? 1 : 0;
    },
    setSpin: (v) => {
      spin = v;
    },
    onSpinChange: (fn) => {
      onSpin = fn;
    },
    dolly,
    reset: () => {
      cam.tYaw = Math.PI * 0.25;
      cam.tZoom = ZOOM0;
      syncZoom();
    },
    setSel: (f) => {
      sel = f;
    },
    setRailHover: (f) => {
      railHover = f;
    },
    setQuery: (q) => {
      query = q;
    },
    setMarkMode: (m) => {
      markMode = m;
    },
    dispose: () => {
      dead = true;
      cancelAnimationFrame(raf);
      ac.abort();
      renderer!.dispose();
      boxGeo.dispose();
      edgeGeo.dispose();
      boxMat.dispose();
      for (const m of outlineMats) m.dispose();
    },
  };
}
