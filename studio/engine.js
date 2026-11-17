// Seedance Studio — движок сцены. Общий для редактора (app.js) и для рендера без окна (render.html).
// ГЛАВНОЕ ПРАВИЛО: кадр зависит только от времени t. Никаких часов, случайных чисел и памяти между кадрами.
// Поэтому любой кадр выглядит одинаково, в каком бы порядке его ни рисовали.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// ---------- математика ----------
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const EASES = { linear: 'равномерно', inOut: 'плавно', in: 'разгон', out: 'торможение', hold: 'стоп (скачок)' };
const EASE = {
  linear: (k) => k, in: (k) => k * k * k, out: (k) => 1 - (1 - k) ** 3,
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2), hold: () => 0,
};
export const ease = (name, k) => (EASE[name] || EASE.linear)(clamp(k));
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const noise = (x, seed) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash(i + seed * 57), hash(i + 1 + seed * 57), u) * 2 - 1; };
const cr = (p0, p1, p2, p3, k) => { const k2 = k * k, k3 = k2 * k; return 0.5 * (2 * p1 + (-p0 + p2) * k + (2 * p0 - 5 * p1 + 4 * p2 - p3) * k2 + (-p0 + 3 * p1 - 3 * p2 + p3) * k3); };
const angLerp = (a, b, k) => { let d = ((b - a + 540) % 360) - 180; return a + d * k; };
const D2R = Math.PI / 180;

// ---------- проект по умолчанию ----------
export function newProject(name = 'Новая сцена', vertical = false) {
  return {
    version: 1, name,
    format: vertical ? { w: 720, h: 1280, fps: 24 } : { w: 1280, h: 720, fps: 24 },
    duration: 8,
    world: { sky: '#c3c6ca', ground: '#8d9094', grid: true, fog: [30, 120], sun: [14, 22, 10] },
    refs: { location: null, overlay: 0.4 },
    objects: [],
    shots: [{ id: 's1', name: 'План 1', from: 0, to: 8, ease: 'inOut', shake: 0, keys: [{ t: 0, pos: [0, 1.6, 8], target: [0, 1.2, 0], lens: 35 }] }],
  };
}

export const HERO_COLORS = ['#ff3b30', '#0a84ff', '#ffcc00', '#30d158', '#ff9f0a', '#ff2d92', '#bf5af2', '#64d2ff'];
export const DEFAULT_LOOK = { skin: '#d9a88a', hair: '#3b2a20', hairStyle: 'short', top: '#2f4f7f', bottom: '#2b2b30', shoes: '#1d1d1f', build: 1 };
export const POSES = { auto: 'авто (стоит / идёт / бежит)', sit: 'сидит', wave: 'машет рукой', point: 'показывает вперёд', armsUp: 'руки вверх', lie: 'лежит' };

// ---------- ключи объекта: позиция, поворот, поза ----------
const sortKeys = (keys) => [...keys].sort((a, b) => a.t - b.t);
export function objectState(o, t) {
  if (!o.keys || !o.keys.length) return { pos: o.pos || [0, 0, 0], rot: o.rot || [0, 0, 0], pose: o.pose || 'auto' };
  const K = sortKeys(o.keys);
  if (t <= K[0].t) return { pos: K[0].pos, rot: K[0].rot || [0, 0, 0], pose: K[0].pose || 'auto' };
  const L = K[K.length - 1];
  if (t >= L.t) return { pos: L.pos, rot: L.rot || [0, 0, 0], pose: L.pose || 'auto' };
  let i = 0; while (K[i + 1].t < t) i++;
  const a = K[i], b = K[i + 1], k = ease(b.ease || 'linear', (t - a.t) / (b.t - a.t));
  const p0 = (K[i - 1] || a).pos, p3 = (K[i + 2] || b).pos;
  const pos = a.pos.map((_, j) => cr(p0[j], a.pos[j], b.pos[j], p3[j], k));
  const ra = a.rot || [0, 0, 0], rb = b.rot || ra;
  return { pos, rot: [angLerp(ra[0], rb[0], k), angLerp(ra[1], rb[1], k), angLerp(ra[2], rb[2], k)], pose: a.pose || 'auto' };
}
// пройденный путь к моменту t: от него считается фаза шага, чтобы ноги не «скользили»
function travelled(o, t) {
  if (!o.keys || o.keys.length < 2) return 0;
  const dt = 1 / 30; let d = 0, prev = objectState(o, 0).pos;
  for (let x = dt; x <= t + 1e-6; x += dt) { const p = objectState(o, x).pos; d += Math.hypot(p[0] - prev[0], p[2] - prev[2]); prev = p; }
  return d;
}
function velocity(o, t) {
  const a = objectState(o, t - 0.06).pos, b = objectState(o, t + 0.06).pos;
  const dx = b[0] - a[0], dz = b[2] - a[2]; return { dx, dz, speed: Math.hypot(dx, dz) / 0.12 };
}

// ---------- камера ----------
export function shotAt(project, t) {
  const S = [...project.shots].sort((a, b) => a.from - b.from);
  return S.find((s) => t >= s.from && t < s.to) || (t < (S[0]?.from ?? 0) ? S[0] : S[S.length - 1]);
}
export function cameraState(project, t) {
  const s = shotAt(project, t);
  if (!s || !s.keys.length) return { pos: [0, 1.6, 8], target: [0, 1.2, 0], lens: 35, shot: s };
  const K = sortKeys(s.keys);
  let pos, target, lens;
  if (K.length === 1) ({ pos, target, lens } = K[0]);
  else {
    const k0 = K[0].t, kN = K[K.length - 1].t;
    const u = ease(s.ease || 'inOut', (t - k0) / Math.max(1e-6, kN - k0));   // одна плавность на весь план
    const tt = k0 + u * (kN - k0);
    let i = 0; while (i < K.length - 2 && K[i + 1].t < tt) i++;
    const a = K[i], b = K[i + 1], k = clamp((tt - a.t) / Math.max(1e-6, b.t - a.t));
    const A = K[i - 1] || a, B = K[i + 2] || b;
    pos = a.pos.map((_, j) => cr(A.pos[j], a.pos[j], b.pos[j], B.pos[j], k));
    target = a.target.map((_, j) => cr(A.target[j], a.target[j], b.target[j], B.target[j], k));
    lens = lerp(a.lens || 35, b.lens || 35, k);
  }
  pos = [...pos]; target = [...target];
  const sh = s.shake || 0;
  if (sh) { pos[0] += noise(t * 1.7, 1) * sh; pos[1] += noise(t * 2.1, 2) * sh; target[0] += noise(t * 1.3, 3) * sh * 2; target[1] += noise(t * 1.9, 4) * sh * 2; }
  return { pos, target, lens, roll: s.roll || 0, shot: s };
}
export function applyCamera(cam, st) {
  cam.position.set(...st.pos); cam.up.set(0, 1, 0); cam.lookAt(...st.target);
  if (st.roll) cam.rotateZ(st.roll * D2R);
  cam.setFocalLength(st.lens); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
}

// ---------- манекен (3D-человек из простых форм) ----------
function std(color, rough = 0.7) { return new THREE.MeshStandardMaterial({ color, roughness: rough }); }
function m(geo, mat, parent, x = 0, y = 0, z = 0) { const me = new THREE.Mesh(geo, mat); me.position.set(x, y, z); me.castShadow = me.receiveShadow = true; parent.add(me); return me; }
const cap = (r, len) => new THREE.CapsuleGeometry(r, Math.max(0.001, len), 6, 14).translate(0, -len / 2 - r * 0.0, 0);

function buildPerson(o) {
  const L = { ...DEFAULT_LOOK, ...(o.look || {}) }, H = (o.size?.[1] ?? 1.75), s = H / 1.75, b = L.build || 1;
  const skin = std(L.skin, 0.6), hair = std(L.hair, 0.8), top = std(L.top), bottom = std(L.bottom), shoes = std(L.shoes, 0.5);
  const root = new THREE.Group(); const body = new THREE.Group(); body.scale.setScalar(s); root.add(body);
  const hips = new THREE.Group(); hips.position.y = 0.95; body.add(hips);
  const torso = new THREE.Group(); hips.add(torso);
  m(new THREE.CapsuleGeometry(0.15 * b, 0.32, 6, 16).scale(1.15, 1, 0.75), top, torso, 0, 0.24, 0);
  m(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 10), skin, torso, 0, 0.55, 0);
  const head = new THREE.Group(); head.position.y = 0.69; torso.add(head);
  m(new THREE.SphereGeometry(0.105, 20, 14).scale(0.92, 1.08, 1), skin, head);
  m(new THREE.BoxGeometry(0.03, 0.04, 0.04), skin, head, 0, -0.005, 0.1);                       // нос: видно, куда смотрит
  if (L.hairStyle !== 'bald') {
    m(new THREE.SphereGeometry(0.113, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.95, 1.05, 1.05), hair, head, 0, 0.012, -0.01).rotation.x = -0.45;   // линия волос над лбом
    if (L.hairStyle === 'long') m(new THREE.BoxGeometry(0.2, 0.3, 0.07), hair, head, 0, -0.12, -0.07);
    if (L.hairStyle === 'bun') m(new THREE.SphereGeometry(0.05, 12, 10), hair, head, 0, 0.09, -0.09);
  }
  const limbs = {};
  for (const side of [-1, 1]) {
    const sh = new THREE.Group(); sh.position.set(side * 0.2 * b, 0.47, 0); torso.add(sh);
    m(cap(0.048 * b, 0.22), top, sh, 0, -0.03, 0);
    const el = new THREE.Group(); el.position.y = -0.29; sh.add(el);
    m(cap(0.04 * b, 0.2), L.sleeves === 'short' ? skin : top, el, 0, -0.02, 0);
    m(new THREE.SphereGeometry(0.045, 10, 8), skin, el, 0, -0.27, 0.01);
    const hip = new THREE.Group(); hip.position.set(side * 0.09 * b, 0, 0); hips.add(hip);
    m(cap(0.068 * b, 0.32), bottom, hip, 0, -0.04, 0);
    const kn = new THREE.Group(); kn.position.y = -0.44; hip.add(kn);
    m(cap(0.055 * b, 0.33), bottom, kn, 0, -0.02, 0);
    const foot = m(new THREE.BoxGeometry(0.1, 0.07, 0.24), shoes, kn, 0, -0.45, 0.05);
    limbs[side < 0 ? 'R' : 'L'] = { sh, el, hip, kn, foot };
  }
  root.userData = { kind: 'person', body, hips, torso, head, limbs, height: H };
  return root;
}

function posePerson(g, o, t, pose) {
  const P = g.userData, { hips, torso, head, limbs } = P;
  const { speed } = velocity(o, t);
  const dist = travelled(o, t);
  const running = speed > 2.6;
  const amp = pose === 'auto' ? (running ? 0.85 : 0.42) * clamp(speed / (running ? 3.5 : 1.3)) : 0;
  const ph = (dist / (running ? 1.1 : 0.72)) * Math.PI;   // фаза шага из пройденного пути
  // сброс
  hips.position.set(0, 0.95, 0); hips.rotation.set(0, 0, 0); torso.rotation.set(0, 0, 0); head.rotation.set(0, 0, 0);
  for (const k of ['L', 'R']) { const l = limbs[k]; l.sh.rotation.set(0, 0, k === 'L' ? -0.08 : 0.08); l.el.rotation.set(0, 0, 0); l.hip.rotation.set(0, 0, 0); l.kn.rotation.set(0, 0, 0); }
  if (pose === 'auto') {
    const sL = Math.sin(ph), sR = -sL;
    limbs.L.hip.rotation.x = -amp * sL; limbs.R.hip.rotation.x = -amp * sR;
    limbs.L.kn.rotation.x = amp * 1.1 * Math.max(0, Math.sin(ph + 1.9)); limbs.R.kn.rotation.x = amp * 1.1 * Math.max(0, Math.sin(ph + 1.9 + Math.PI));
    limbs.L.sh.rotation.x = amp * 0.8 * sL; limbs.R.sh.rotation.x = amp * 0.8 * sR;
    limbs.L.el.rotation.x = -amp * (running ? 1.4 : 0.4); limbs.R.el.rotation.x = -amp * (running ? 1.4 : 0.4);
    hips.position.y = 0.95 - amp * 0.03 + Math.abs(Math.cos(ph)) * amp * 0.05;
    torso.rotation.x = running ? 0.18 * amp : 0.03 * amp; torso.rotation.y = 0.12 * amp * sL;
    if (amp < 0.05) { const br = Math.sin(t * 1.6) * 0.012; torso.rotation.x = br; head.rotation.x = -br; }   // дыхание на месте
  } else if (pose === 'sit') {
    hips.position.y = 0.48;
    for (const k of ['L', 'R']) { limbs[k].hip.rotation.x = -1.5; limbs[k].kn.rotation.x = 1.5; limbs[k].sh.rotation.x = -0.35; limbs[k].el.rotation.x = -0.6; }
  } else if (pose === 'lie') {
    hips.position.y = 0.13; hips.rotation.x = -Math.PI / 2;
    for (const k of ['L', 'R']) limbs[k].sh.rotation.z = k === 'L' ? -0.25 : 0.25;
  } else if (pose === 'wave') {
    limbs.R.sh.rotation.z = 2.5; limbs.R.el.rotation.z = 0.3 + Math.sin(t * 9) * 0.45;
  } else if (pose === 'point') {
    limbs.R.sh.rotation.x = -1.5; limbs.R.sh.rotation.z = 0.1;
  } else if (pose === 'armsUp') {
    limbs.L.sh.rotation.z = -2.8; limbs.R.sh.rotation.z = 2.8;
  }
  return speed;
}

// ---------- машина и простые формы ----------
function buildCar(o, mat) {
  const [w, h, d] = [o.size?.[0] ?? 1.8, o.size?.[1] ?? 1.45, o.size?.[2] ?? 4.3], g = new THREE.Group();
  m(new THREE.BoxGeometry(w, h * 0.42, d), mat, g, 0, h * 0.42 / 2 + h * 0.15, 0);
  m(new THREE.BoxGeometry(w * 0.88, h * 0.4, d * 0.5), mat, g, 0, h * 0.57 + h * 0.2, -d * 0.04);
  const glass = std('#2a3138', 0.2);
  m(new THREE.BoxGeometry(w * 0.9, h * 0.3, 0.02), glass, g, 0, h * 0.78, d * 0.21);
  const wheel = std('#1b1b1d', 0.8);
  for (const x of [-1, 1]) for (const z of [-1, 1]) m(new THREE.CylinderGeometry(h * 0.23, h * 0.23, 0.22, 20).rotateZ(Math.PI / 2), wheel, g, x * (w / 2 - 0.08), h * 0.23, z * d * 0.32);
  g.userData = { kind: 'car', height: h }; return g;
}
function shape(o) {
  const s = o.size || [1, 1, 1], col = o.color || '#9a9da1', hero = !!o.hero;
  const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.78, emissive: hero ? col : '#000000', emissiveIntensity: hero ? 0.15 : 0 });
  const up = (geo, h) => geo.translate(0, h / 2, 0);
  let geo;
  switch (o.type) {
    case 'car': return buildCar(o, mat);
    case 'cyl': geo = up(new THREE.CylinderGeometry(s[0] / 2, s[0] / 2, s[1], 32), s[1]); break;
    case 'cone': geo = up(new THREE.ConeGeometry(s[0] / 2, s[1], 32), s[1]); break;
    case 'sphere': geo = up(new THREE.SphereGeometry(s[0] / 2, 32, 16), s[0]); break;
    case 'plane': geo = new THREE.BoxGeometry(s[0], 0.02, s[2] ?? s[0]).translate(0, 0.01, 0); break;
    case 'capsule': { const r = s[0] / 2; geo = up(new THREE.CapsuleGeometry(r, Math.max(0.01, s[1] - 2 * r), 8, 20), s[1]); break; }
    default: geo = up(new THREE.BoxGeometry(s[0], s[1], s[2] ?? s[0]), s[1]);
  }
  const g = new THREE.Group(); m(geo, mat, g); g.userData = { kind: 'shape', height: o.type === 'sphere' ? s[0] : s[1] }; return g;
}

// ---------- GLB (готовая 3D-модель из Meshy / Tripo / Higgsfield и т.п.) ----------
const gltfCache = new Map(); const loader = new GLTFLoader();
function loadGLTF(src, stage) {
  if (!gltfCache.has(src)) gltfCache.set(src, stage.fetchGLB ? stage.fetchGLB(src).then((buf) => loader.parseAsync(buf, '')) : loader.loadAsync(stage.assetURL(src)));
  return gltfCache.get(src);
}
async function buildGLB(o, stage) {
  const g = new THREE.Group();
  try {
    const gl = await loadGLTF(o.glb.src, stage);
    const model = SkeletonUtils.clone(gl.scene);
    model.traverse((c) => { if (c.isMesh) { c.castShadow = c.receiveShadow = true; } });
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
    const H = o.size?.[1] ?? 1.75, k = size.y > 0 ? H / size.y : 1;
    model.scale.setScalar(k * (o.glb.scale || 1));
    const c = box.getCenter(new THREE.Vector3());
    model.position.set(-c.x * k, -box.min.y * k, -c.z * k);
    if (o.glb.rotY) model.rotation.y = o.glb.rotY * D2R;
    g.add(model);
    const clips = gl.animations || [];
    const mixer = clips.length ? new THREE.AnimationMixer(model) : null;
    const clip = clips.find((c) => c.name === o.glb.clip) || null;
    let action = null; if (mixer && clip) { action = mixer.clipAction(clip); action.play(); }
    g.userData = { kind: 'glb', height: H, mixer, action, clips: clips.map((c) => c.name) };
  } catch (e) {
    console.error('GLB не загрузился', o.glb?.src, e);
    m(new THREE.BoxGeometry(0.5, H_ERR, 0.5).translate(0, H_ERR / 2, 0), std('#ff00ff'), g); g.userData = { kind: 'glb', height: H_ERR, error: true };
  }
  return g;
}
const H_ERR = 1;

// ---------- сцена ----------
export class Stage {
  constructor(assetURL = (p) => p, fetchGLB = null) {
    this.assetURL = assetURL; this.fetchGLB = fetchGLB;
    this.scene = new THREE.Scene();
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x5a5d61, 1.6); this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 160 });
    this.sun = sun; this.scene.add(sun, sun.target);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshStandardMaterial({ roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2; this.ground.receiveShadow = true; this.ground.name = '__ground'; this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(300, 150, 0x6c6f73, 0x7b7e82); this.grid.position.y = 0.003; this.scene.add(this.grid);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.nodes = new Map();      // id объекта -> THREE.Group
    this.project = null;
  }
  applyWorld() {
    const w = this.project.world || {};
    const bg = new THREE.Color(w.sky || '#c3c6ca');
    this.scene.background = bg; this.scene.fog = new THREE.Fog(bg, ...(w.fog || [30, 120]));
    this.ground.material.color.set(w.ground || '#8d9094');
    this.grid.visible = w.grid !== false;
    this.sun.position.set(...(w.sun || [14, 22, 10]));
  }
  async load(project) { this.project = project; this.applyWorld(); await this.rebuild(); }
  async rebuild(onlyId) {
    const list = onlyId ? this.project.objects.filter((o) => o.id === onlyId) : this.project.objects;
    if (!onlyId) { for (const n of this.nodes.values()) this.root.remove(n); this.nodes.clear(); }
    for (const o of list) {
      const old = this.nodes.get(o.id); if (old) this.root.remove(old);
      const n = o.type === 'person' ? buildPerson(o) : o.type === 'glb' ? await buildGLB(o, this) : shape(o);
      n.userData.id = o.id; n.traverse((c) => { c.userData.ownerId = o.id; });
      this.nodes.set(o.id, n); this.root.add(n);
    }
    // удалить узлы объектов, которых больше нет
    for (const [id, n] of this.nodes) if (!this.project.objects.find((o) => o.id === id)) { this.root.remove(n); this.nodes.delete(id); }
  }
  // расставить всё на момент t
  evaluate(t) {
    for (const o of this.project.objects) {
      const g = this.nodes.get(o.id); if (!g) continue;
      const st = objectState(o, t);
      g.position.set(...st.pos);
      let yaw = (st.rot[1] || 0) * D2R;
      const animated = o.keys && o.keys.length > 1;
      if (animated && o.face !== 'none' && (o.type === 'person' || o.type === 'glb' || o.type === 'car' || o.face === 'travel')) {
        const { dx, dz, speed } = velocity(o, t), w = clamp((speed - 0.1) / 0.5);
        if (w > 0) { let dy = Math.atan2(dx, dz) - yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); yaw += dy * w; }
      }
      g.rotation.set((st.rot[0] || 0) * D2R, yaw, (st.rot[2] || 0) * D2R);
      if (g.userData.kind === 'person') posePerson(g, o, t, st.pose || 'auto');
      if (g.userData.mixer) g.userData.mixer.setTime(Math.max(0, t - (o.glb?.offset || 0)));
    }
  }
  // подписи героев в экранных координатах
  labels(camera, W, H) {
    const out = [], v = new THREE.Vector3();
    for (const o of this.project.objects) if (o.hero) {
      const g = this.nodes.get(o.id); if (!g) continue;
      v.copy(g.position); v.y += (g.userData.height || 1) * (o.type === 'person' && objectState(o, 0).pose === 'lie' ? 0.3 : 1) + 0.3; v.project(camera);
      if (v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1) out.push({ name: o.name, color: o.labelColor || o.color || '#ffffff', x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H });
    }
    return out;
  }
}

// подписи и таймкод поверх кадра (версия «на проверку»)
export function drawOverlay(ctx, W, H, t, labels, shot, lens, shotIndex) {
  const u = Math.max(W, H) / 1280;
  ctx.font = `700 ${Math.round(18 * u)}px -apple-system, Helvetica, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  for (const l of labels) {
    const w = ctx.measureText(l.name).width + 14 * u;
    ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(l.x - w / 2, l.y - 26 * u, w, 26 * u);
    ctx.fillStyle = l.color; ctx.fillText(l.name, l.x, l.y - 4 * u);
  }
  const line = `[${t.toFixed(1)}s]  ${shotIndex}. ${shot?.name || ''}  ·  ${Math.round(lens)} мм`;
  ctx.font = `600 ${Math.round(17 * u)}px -apple-system, Helvetica, Arial, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(0, H - 36 * u, W, 36 * u);
  ctx.fillStyle = '#fff'; ctx.fillText(line, 14 * u, H - 18 * u);
}

// Отдельный «чистовой» рендерер нужного размера: для записи и для render.html.
export class FrameRenderer {
  constructor(stage) {
    this.stage = stage; this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 600);
    this.out = document.createElement('canvas'); this.ctx = this.out.getContext('2d');
  }
  frame(t, labels = false) {
    const p = this.stage.project, { w: W, h: H } = p.format;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.renderer.setSize(W, H, false); this.out.width = W; this.out.height = H; }
    this.camera.aspect = W / H;
    this.stage.evaluate(t);
    const st = cameraState(p, t); applyCamera(this.camera, st);
    this.renderer.render(this.stage.scene, this.camera);
    this.ctx.drawImage(this.canvas, 0, 0);
    if (labels) {
      const S = [...p.shots].sort((a, b) => a.from - b.from);
      drawOverlay(this.ctx, W, H, t, this.stage.labels(this.camera, W, H), st.shot, st.lens, S.indexOf(st.shot) + 1);
    }
    return this.out;
  }
}
