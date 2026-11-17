// Seedance Studio — редактор. Сцена хранится в project.json; всё, что делает интерфейс, — правит этот объект.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { localBackend } from './backend-local.js';
import { Stage, FrameRenderer, newProject, objectState, cameraState, applyCamera, shotAt, EASES, POSES, HERO_COLORS, DEFAULT_LOOK,
  worldTransform, attachments, wouldCycle, followFrame, hingeOf, PIVOTS, objById } from './engine.js';

const $ = (s) => document.querySelector(s);
const R3 = (v) => Math.round(v * 1000) / 1000;
const R1 = (v) => Math.round(v * 10) / 10;
const uid = (p) => p + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- состояние ----------
const B = window.__backend || localBackend();
let P = null, projName = null, dirty = false, saveTimer = null, unwatch = null;
let T = 0, playing = false, playT0 = 0, playFrom = 0;
let sel = null;            // { kind: 'obj', id } | { kind: 'shot', id } | null
let selKeyT = null;        // время выделенного ключа (подсветка)
let mode = 'director';     // director | camera
let autoKey = true;
const undoStack = [], redoStack = [];
const assetURL = (p) => B.assetURL(p);
const fps = () => P.format.fps || 24;
const snapT = (t) => Math.round(Math.max(0, Math.min(P.duration, t)) * fps()) / fps();

// ---------- рендер вьюпорта ----------
const canvas = $('#vp'), viewEl = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const stage = new Stage(assetURL, B.fetchGLB ? (r) => B.fetchGLB(r) : null);
const helpers = new THREE.Scene();
const dirCam = new THREE.PerspectiveCamera(40, 1, 0.05, 2000); dirCam.position.set(14, 11, 16);
const shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 600);
const orbit = new OrbitControls(dirCam, canvas); orbit.target.set(0, 1, 0); orbit.enableDamping = true; orbit.dampingFactor = 0.12;
orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
const tc = new TransformControls(dirCam, canvas); tc.setSize(0.9); helpers.add(tc.getHelper());
let tcDragging = false;
tc.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; tcDragging = e.value; if (!e.value) commitTransform(); });
dirCam.setFocalLength(24);

// вспомогательные линии: камера, путь камеры, путь объекта, рамка выделения
const camProxy = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 1.6);
const camHelper = new THREE.CameraHelper(camProxy); helpers.add(camHelper);
const camBody = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.3), new THREE.MeshBasicMaterial({ color: 0x4da3ff })); helpers.add(camBody);
const mkLine = (color) => { const l = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 })); l.renderOrder = 10; helpers.add(l); return l; };
const camPath = mkLine(0x4da3ff), objPath = mkLine(0xffcc00);
const keyDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffcc00, size: 9, sizeAttenuation: false, depthTest: false })); keyDots.renderOrder = 11; helpers.add(keyDots);
const selBox = new THREE.BoxHelper(undefined, 0xff6a3d); selBox.visible = false; helpers.add(selBox);
let pathsDirty = true;

function rebuildPaths() {
  pathsDirty = false;
  const pts = []; const shots = [...P.shots].sort((a, b) => a.from - b.from);
  for (const s of shots) for (let t = s.from; t <= s.to - 1e-3; t += 1 / 12) pts.push(new THREE.Vector3(...cameraState(P, t).pos));
  camPath.geometry.dispose(); camPath.geometry = new THREE.BufferGeometry().setFromPoints(pts.length > 1 ? pts : [new THREE.Vector3(), new THREE.Vector3()]);
  const o = selObj();
  if (o && ((o.keys && o.keys.length > 1) || o.attach?.length)) {
    const op = []; for (let t = 0; t <= P.duration + 1e-6; t += 1 / 12) { const p = worldTransform(o, t, P).pos; op.push(new THREE.Vector3(p[0], p[1] + 0.05, p[2])); }
    objPath.geometry.dispose(); objPath.geometry = new THREE.BufferGeometry().setFromPoints(op); objPath.visible = true;
    keyDots.geometry.dispose(); keyDots.geometry = new THREE.BufferGeometry().setFromPoints((o.keys || []).map((k) => { const p = worldTransform(o, k.t, P).pos; return new THREE.Vector3(p[0], p[1] + 0.05, p[2]); })); keyDots.visible = !!o.keys?.length;
  } else { objPath.visible = false; keyDots.visible = false; }
}

function resize() {
  const w = viewEl.clientWidth, h = viewEl.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false); dirCam.aspect = w / h; dirCam.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewEl);

// прямоугольник кадра камеры внутри вьюпорта (CSS-пиксели)
function frameRect(big) {
  const w = viewEl.clientWidth, h = viewEl.clientHeight, a = P.format.w / P.format.h;
  if (big) { let fw = w - 40, fh = fw / a; if (fh > h - 40) { fh = h - 40; fw = fh * a; } return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh }; }
  let pw = a >= 1 ? w * 0.3 : h * 0.42 * a, ph = pw / a; return { x: w - pw - 14, y: h - ph - 14, w: pw, h: ph };
}

function draw() {
  if (!P) return;
  if (!tcDragging) stage.evaluate(T);
  const cs = cameraState(P, T); applyCamera(shotCam, cs);
  // прокси-камера для схемы
  camProxy.position.copy(shotCam.position); camProxy.quaternion.copy(shotCam.quaternion); camProxy.fov = shotCam.fov; camProxy.aspect = P.format.w / P.format.h; camProxy.updateProjectionMatrix(); camProxy.updateMatrixWorld(); camHelper.update();
  camBody.position.copy(shotCam.position); camBody.quaternion.copy(shotCam.quaternion);
  if (pathsDirty) rebuildPaths();
  const node = sel?.kind === 'obj' ? stage.nodes.get(sel.id) : null;
  if (node) { selBox.setFromObject(node); selBox.visible = true; } else selBox.visible = false;

  const W = viewEl.clientWidth, H = viewEl.clientHeight, dpr = renderer.getPixelRatio();
  renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H);
  const ov = $('#overlay'), pf = $('#pipframe');
  if (mode === 'director') {
    const fog = stage.scene.fog, fn = fog?.near, ff = fog?.far; if (fog) { fog.near = 400; fog.far = 3000; }   // в рабочем виде без тумана
    renderer.render(stage.scene, dirCam);
    if (fog) { fog.near = fn; fog.far = ff; }
    renderer.autoClear = false; renderer.clearDepth(); renderer.render(helpers, dirCam); renderer.autoClear = true;
    const r = frameRect(false);
    renderer.setScissorTest(true); renderer.setScissor(r.x, H - r.y - r.h, r.w, r.h); renderer.setViewport(r.x, H - r.y - r.h, r.w, r.h);
    shotCam.aspect = P.format.w / P.format.h; shotCam.updateProjectionMatrix(); renderer.render(stage.scene, shotCam); renderer.setScissorTest(false);
    Object.assign(pf.style, { display: 'block', left: r.x - 2 + 'px', top: r.y - 2 + 'px', width: r.w + 4 + 'px', height: r.h + 4 + 'px' });
    pf.querySelector('span').textContent = `Камера · ${cs.shot?.name || ''} · ${Math.round(cs.lens)} мм`;
    ov.style.display = 'none';
  } else {
    renderer.setClearColor(0x0d0e10, 1); renderer.clear();
    const r = frameRect(true);
    renderer.setScissorTest(true); renderer.setScissor(r.x, H - r.y - r.h, r.w, r.h); renderer.setViewport(r.x, H - r.y - r.h, r.w, r.h);
    shotCam.aspect = P.format.w / P.format.h; shotCam.updateProjectionMatrix(); renderer.render(stage.scene, shotCam); renderer.setScissorTest(false);
    pf.style.display = 'none';
    if (P.refs?.location && P.refs.showOverlay !== false) {
      if (ov.dataset.src !== P.refs.location) { ov.src = assetURL(P.refs.location); ov.dataset.src = P.refs.location; }
      Object.assign(ov.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', opacity: P.refs.overlay ?? 0.4 });
    } else ov.style.display = 'none';
  }
  void dpr;
}

function loop() {
  if (playing) { T = (playFrom + (performance.now() - playT0) / 1000) % P.duration; updateTimeUI(); }
  orbit.update(); draw(); requestAnimationFrame(loop);
}

// ---------- изменения, отмена, сохранение ----------
function snapshot() { undoStack.push(JSON.stringify(P)); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; }
async function change(fn, rebuild = false) {
  snapshot(); fn(); pathsDirty = true;
  if (rebuild === 'world') stage.applyWorld();
  else if (rebuild === true) await stage.rebuild(); else if (rebuild) await stage.rebuild(rebuild);
  if (rebuild && rebuild !== 'world') attachTC();
  markDirty(); refreshAll();
}
async function restore(json) { P = JSON.parse(json); await stage.load(P); pathsDirty = true; if (sel?.kind === 'obj' && !selObj()) sel = null; attachTC(); markDirty(); refreshAll(); }
async function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(P)); await restore(undoStack.pop()); }
async function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(P)); await restore(redoStack.pop()); }
function markDirty() { dirty = true; status('изменено…'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }
async function save() {
  if (!dirty || !projName) return;
  try { const snap = JSON.stringify(P); await B.save(projName, JSON.parse(snap)); if (JSON.stringify(P) === snap) dirty = false; status(B.offline ? 'не сохраняется' : 'сохранено ✓'); }
  catch (e) { status('ошибка сохранения'); toast('Не удалось сохранить: ' + e.message); }
}
function status(s) { $('#status').textContent = s; }
let toastTimer; function toast(s, ms = 2600) { const t = $('#toast'); t.textContent = s; t.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.style.display = 'none'), ms); }


// ---------- проекты ----------
async function listProjects() {
  const list = await B.list(); const s = $('#projSel');
  s.innerHTML = list.map((p) => `<option value="${esc(p.id)}" ${p.id === projName ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return list;
}
function normalize(p) { p.refs ||= { location: null, overlay: 0.4 }; p.world ||= {}; p.objects ||= []; p.shots ||= newProject().shots; return p; }
async function applyRemote(data) {
  if (dirty || tcDragging) return;
  P = normalize(data); await stage.load(P); pathsDirty = true; if (sel?.kind === 'obj' && !selObj()) sel = null; attachTC(); refreshAll(); toast('Сцена обновлена');
}
async function openProject(name, keepView = false) {
  const data = await B.load(name);
  projName = name; P = data; dirty = false;
  P.refs ||= { location: null, overlay: 0.4 }; P.world ||= {}; P.objects ||= []; P.shots ||= newProject().shots;
  await stage.load(P);
  if (!keepView) { undoStack.length = redoStack.length = 0; sel = null; T = Math.min(T, P.duration); frameAll(); }
  else if (sel?.kind === 'obj' && !selObj()) sel = null;
  if (B.kind === 'local') history.replaceState(null, '', '?p=' + encodeURIComponent(name));
  unwatch?.(); unwatch = B.watch(name, applyRemote);
  pathsDirty = true; attachTC(); refreshAll(); await listProjects(); status('открыт');
}
function modal(html) { $('#mbox').innerHTML = html; $('#modal').style.display = 'flex'; }
function closeModal() { $('#modal').style.display = 'none'; }
function createProject() {
  modal(`<h3>Новая сцена</h3>
    <div class="row" style="display:grid;grid-template-columns:90px 1fr;gap:8px;align-items:center;margin:10px 0">
      <label class="muted">Название</label><input type="text" id="npName" value="Сцена ${new Date().toLocaleDateString('ru')}">
      <label class="muted">Формат</label><select id="npFmt"><option value="v">9:16 · Reels</option><option value="h">16:9 · горизонталь</option></select>
    </div><div class="btns"><button class="primary" id="npOk">Создать</button><button id="npNo">Отмена</button></div>`);
  $('#npName').focus(); $('#npName').select();
  $('#npNo').onclick = closeModal;
  $('#npOk').onclick = async () => {
    const name = $('#npName').value.trim() || 'Сцена'; closeModal();
    await save(); const id = await B.create(name, newProject(name, $('#npFmt').value === 'v')); await openProject(id); await listProjects();
  };
}

// показать всю сцену в рабочем виде
function frameAll() {
  stage.evaluate(T); stage.scene.updateMatrixWorld(true);
  const box = new THREE.Box3(); for (const n of stage.nodes.values()) box.expandByObject(n);
  if (box.isEmpty()) { dirCam.position.set(10, 8, 14); orbit.target.set(0, 1, 0); orbit.update(); return; }
  const c = box.getCenter(new THREE.Vector3()), r = Math.max(4, box.getSize(new THREE.Vector3()).length() / 2);
  orbit.target.set(c.x, Math.min(c.y, 1.5), c.z);
  dirCam.setFocalLength(24); dirCam.updateProjectionMatrix();
  const d = r / Math.tan(THREE.MathUtils.degToRad(dirCam.fov / 2)) * 0.9;
  dirCam.position.copy(orbit.target).add(new THREE.Vector3(0.55, 0.62, 0.56).normalize().multiplyScalar(d)); orbit.update(); refreshLens();
}

// ---------- объекты ----------
const selObj = () => (sel?.kind === 'obj' ? P.objects.find((o) => o.id === sel.id) : null);
const selShot = () => (sel?.kind === 'shot' ? P.shots.find((s) => s.id === sel.id) : null);
function select(s) { sel = s; selKeyT = null; pathsDirty = true; attachTC(); refreshAll(); }
function attachTC() {
  const n = sel?.kind === 'obj' ? stage.nodes.get(sel.id) : null;
  if (n && mode === 'director') { tc.attach(n); const o = selObj(); const yawOnly = ['person', 'car', 'glb'].includes(o?.type); tc.showX = tc.showZ = tc.mode === 'rotate' ? !yawOnly : true; tc.showY = true; }
  else tc.detach();
}
function placeAt() { const p = orbit.target; return [R1(p.x), 0, R1(p.z)]; }
const heroCount = () => P.objects.filter((o) => o.hero).length;
async function addObject(type) {
  if (type === 'glb') return pickFile('.glb,.gltf', (f) => addGLB(f));
  const pos = placeAt(); let o;
  const n = P.objects.filter((x) => x.type === type).length + 1;
  switch (type) {
    case 'person': { const i = heroCount(); o = { id: uid('o'), name: `Герой ${i + 1}`, type, hero: true, labelColor: HERO_COLORS[i % HERO_COLORS.length], size: [0.5, 1.75], look: { ...DEFAULT_LOOK, top: HERO_COLORS[i % HERO_COLORS.length] }, pos, rot: [0, 0, 0] }; break; }
    case 'car': o = { id: uid('o'), name: `Машина ${n}`, type, size: [1.8, 1.45, 4.3], color: '#7e8185', pos, rot: [0, 0, 0] }; break;
    case 'boat': o = { id: uid('o'), name: `Катер ${n}`, type, size: [3, 1.2, 9], color: '#9a9da1', pos, rot: [0, 0, 0] }; break;
    case 'wall': o = { id: uid('o'), name: `Стена ${n}`, type: 'box', size: [6, 3, 0.2], color: '#b4b7ba', pos, rot: [0, 0, 0] }; break;
    case 'plane': o = { id: uid('o'), name: `Плита ${n}`, type: 'plane', size: [6, 0.02, 6], color: '#a3a6aa', pos, rot: [0, 0, 0] }; break;
    case 'cyl': o = { id: uid('o'), name: `Цилиндр ${n}`, type, size: [0.6, 1.2], color: '#9a9da1', pos, rot: [0, 0, 0] }; break;
    case 'sphere': o = { id: uid('o'), name: `Шар ${n}`, type, size: [1, 1], color: '#9a9da1', pos, rot: [0, 0, 0] }; break;
    case 'cone': o = { id: uid('o'), name: `Конус ${n}`, type, size: [1, 1.5], color: '#9a9da1', pos, rot: [0, 0, 0] }; break;
    case 'capsule': { const i = heroCount(); o = { id: uid('o'), name: `Фигура ${i + 1}`, type, hero: true, size: [0.5, 1.75], color: HERO_COLORS[i % HERO_COLORS.length], pos, rot: [0, 0, 0] }; break; }
    default: o = { id: uid('o'), name: `Куб ${n}`, type: 'box', size: [1, 1, 1], color: '#9a9da1', pos, rot: [0, 0, 0] };
  }
  await change(() => P.objects.push(o), o.id); select({ kind: 'obj', id: o.id });
}
async function upload(file) { status('загрузка…'); try { const r = await B.upload(file); status('загружено'); return r; } catch (e) { status('ошибка'); toast(e.message, 5000); throw e; } }
async function addGLB(file) {
  status('загрузка модели…'); const src = await upload(file); const i = heroCount();
  const o = { id: uid('o'), name: file.name.replace(/\.(glb|gltf)$/i, ''), type: 'glb', hero: true, labelColor: HERO_COLORS[i % HERO_COLORS.length], glb: { src, scale: 1, clip: '' }, size: [0.6, 1.75], pos: placeAt(), rot: [0, 0, 0] };
  await change(() => P.objects.push(o), o.id);
  const clips = stage.nodes.get(o.id)?.userData.clips || [];
  if (clips.length) { o.glb.clip = clips.find((c) => /walk|ходьб|idle/i.test(c)) || clips[0]; await stage.rebuild(o.id); markDirty(); }
  select({ kind: 'obj', id: o.id }); status('модель добавлена');
}
function pickFile(accept, cb) { const f = $('#filePick'); f.accept = accept; f.value = ''; f.onchange = () => f.files[0] && cb(f.files[0]); f.click(); }

// позиция/поворот из гизмо -> в данные (ключ или статично)
function upsertKey(o, t, patch) {
  o.keys ||= []; const eps = 0.5 / fps();
  let k = o.keys.find((x) => Math.abs(x.t - t) < eps);
  if (!k) { const st = worldTransform(o, t, P); k = { t, pos: st.pos.map(R3), rot: st.rot.map(R1), ease: 'linear' }; o.keys.push(k); o.keys.sort((a, b) => a.t - b.t); }
  Object.assign(k, patch); selKeyT = k.t; return k;
}
function commitTransform() {
  const o = selObj(), n = o && stage.nodes.get(o.id); if (!n) return;
  const h = n.userData.hinge || [0, 0, 0];   // узел с петлёй стоит на петле, а в данных — центр основания
  const pos = [R3(n.position.x - h[0] * n.scale.x), R3(n.position.y - h[1] * n.scale.y), R3(n.position.z - h[2] * n.scale.z)];
  const rot = [R1(THREE.MathUtils.radToDeg(n.rotation.x)), R1(THREE.MathUtils.radToDeg(n.rotation.y)), R1(THREE.MathUtils.radToDeg(n.rotation.z))];
  setTransform(o, pos, rot);
}
// привязка, действующая в момент t (или null)
const attachAt = (o, t) => attachments(o, P).find((a) => t >= a.from && t < a.to) || null;
// мировая поза -> смещение относительно родителя
function toOffset(a, t, pos, rot) {
  const W = worldTransform(objById(P, a.parent), t, P);
  const v = new THREE.Vector3(pos[0] - W.pos[0], pos[1] - W.pos[1], pos[2] - W.pos[2]).applyQuaternion(W.quat.clone().invert());
  const q = W.quat.clone().invert().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot.map((x) => x * Math.PI / 180), 'XYZ')));
  const yaw = new THREE.Euler().setFromQuaternion(q, 'YXZ').y * 180 / Math.PI;
  return { offset: [R3(v.x / W.scale[0]), R3(v.y / W.scale[1]), R3(v.z / W.scale[2])], rotY: R1(yaw) };
}
function setTransform(o, pos, rot) {
  const a = attachAt(o, T);
  if (a) return change(() => Object.assign(a, toOffset(a, T, pos, rot)));   // на привязанном объекте гизмо меняет смещение
  change(() => {
    if (o.keys && o.keys.length) upsertKey(o, snapT(T), { pos, rot });
    else if (autoKey && T > 0.001) { o.keys = [{ t: 0, pos: (o.pos || [0, 0, 0]).slice(), rot: (o.rot || [0, 0, 0]).slice(), ease: 'linear' }, { t: snapT(T), pos, rot, ease: 'linear' }]; selKeyT = snapT(T); delete o.pos; delete o.rot; }
    else { o.pos = pos; o.rot = rot; }
  });
}
async function deleteObject() { const o = selObj(); if (!o) return; await change(() => { P.objects = P.objects.filter((x) => x !== o); }, true); select(null); }
async function duplicateObject() {
  const o = selObj(); if (!o) return; const c = JSON.parse(JSON.stringify(o)); c.id = uid('o'); c.name = o.name + ' копия';
  const sh = (p) => [p[0] + 1, p[1], p[2] + 1]; if (c.keys) c.keys.forEach((k) => (k.pos = sh(k.pos))); else c.pos = sh(c.pos || [0, 0, 0]);
  await change(() => P.objects.push(c), c.id); select({ kind: 'obj', id: c.id });
}

// ---------- камера и планы ----------
function camKeyFromView() {
  let s = selShot(); if (!s || T < s.from || T > s.to) { s = shotAt(P, T); }
  const t = Math.min(s.to, Math.max(s.from, snapT(T)));
  change(() => {
    const F = followFrame(P, s, t);   // у плана «за объектом» ключи хранятся в координатах объекта
    const k = { t, pos: F.toLocal(dirCam.position.toArray()).map(R3), target: F.toLocal(orbit.target.toArray()).map(R3), lens: Math.round(dirCam.getFocalLength()) };
    const eps = 0.5 / fps(); const ex = s.keys.find((x) => Math.abs(x.t - t) < eps);
    if (ex) Object.assign(ex, k); else { s.keys.push(k); s.keys.sort((a, b) => a.t - b.t); }
    selKeyT = t;
  });
  sel = { kind: 'shot', id: s.id }; attachTC(); refreshAll(); toast(`Ключ камеры: ${s.name}, ${t.toFixed(2)} с`);
}
function grabCamView() {
  const cs = cameraState(P, T);
  dirCam.position.set(...cs.pos); orbit.target.set(...cs.target); dirCam.setFocalLength(cs.lens); dirCam.updateProjectionMatrix(); orbit.update();
  setMode('director'); refreshLens(); toast('Вид камеры перенесён в рабочий вид — подвинь и нажми «Ключ камеры»');
}
function splitShot() {
  const s = shotAt(P, T), t = snapT(T);
  if (t <= s.from + 0.1 || t >= s.to - 0.1) return toast('Встань внутри плана, не у края');
  const cs = cameraState(P, t);
  const F = followFrame(P, s, t);
  const ns = { id: uid('s'), name: `План ${P.shots.length + 1}`, from: t, to: s.to, ease: s.ease, shake: s.shake || 0, ...(s.follow ? { follow: s.follow, followYaw: s.followYaw } : {}),
    keys: [{ t, pos: F.toLocal(cs.pos).map(R3), target: F.toLocal(cs.target).map(R3), lens: Math.round(cs.lens) }, ...s.keys.filter((k) => k.t > t)] };
  change(() => { s.to = t; s.keys = s.keys.filter((k) => k.t <= t); if (!s.keys.length) s.keys.push({ ...ns.keys[0] }); P.shots.push(ns); P.shots.sort((a, b) => a.from - b.from); });
  sel = { kind: 'shot', id: ns.id }; refreshAll();
}
function deleteShot(s) {
  if (P.shots.length < 2) return toast('Последний план удалить нельзя');
  const S = [...P.shots].sort((a, b) => a.from - b.from), i = S.indexOf(s), prev = S[i - 1], next = S[i + 1];
  change(() => { if (prev) prev.to = s.to; else next.from = s.from; P.shots = P.shots.filter((x) => x !== s); });
  select(null);
}
function setDuration(d) {
  d = Math.max(1, Math.min(30, d));
  change(() => {
    P.duration = d; const S = [...P.shots].sort((a, b) => a.from - b.from);
    P.shots = S.filter((s, i) => i === 0 || s.from < d - 0.1); const last = P.shots[P.shots.length - 1]; last.to = d;
    for (const s of P.shots) s.keys = s.keys.filter((k, i) => i === 0 || k.t <= d);
  });
  T = Math.min(T, d);
}

// ---------- режимы вида ----------
function setMode(m) { mode = m; $('#vmode').classList.toggle('on', m === 'camera'); $('#vmode').textContent = m === 'camera' ? '🛠 Рабочий вид' : '🎥 Смотреть через камеру'; attachTC(); }
function refreshLens() { const l = Math.round(dirCam.getFocalLength()); $('#dlens').value = l; $('#dlensv').textContent = l + ' мм'; }

// ---------- выбор кликом во вьюпорте ----------
const ray = new THREE.Raycaster(); let downXY = null;
canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) downXY = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !downXY || mode !== 'director') return;
  const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]); downXY = null;
  if (moved > 4 || tc.axis) return;
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const pr = frameRect(false); if (x > pr.x && x < pr.x + pr.w && y > pr.y && y < pr.y + pr.h) { setMode('camera'); return; }
  ray.setFromCamera(new THREE.Vector2(x / r.width * 2 - 1, -(y / r.height) * 2 + 1), dirCam);
  const hit = ray.intersectObjects(stage.root.children, true).find((h) => h.object.userData.ownerId);
  if (hit) select({ kind: 'obj', id: hit.object.userData.ownerId }); else if (sel?.kind === 'obj') select(null);
});
// левая кнопка по пустому месту — тоже вращение вида (удобно на тачпаде)
canvas.addEventListener('pointerdown', (e) => { orbit.mouseButtons.LEFT = e.button === 0 && mode === 'director' && !tc.axis ? THREE.MOUSE.ROTATE : null; }, { capture: true });
window.addEventListener('pointerup', () => { orbit.mouseButtons.LEFT = null; });

// перетаскивание файлов: .glb -> модель, картинка -> фото героя (если выбран человек) или фото места
viewEl.addEventListener('dragover', (e) => e.preventDefault());
viewEl.addEventListener('drop', async (e) => {
  e.preventDefault(); const f = e.dataTransfer.files[0]; if (!f) return;
  if (/\.(glb|gltf)$/i.test(f.name)) return addGLB(f);
  if (f.type.startsWith('image/')) { const p = await upload(f); const o = selObj(); if (o) change(() => (o.ref = p)); else change(() => (P.refs.location = p)); toast(o ? 'Фото добавлено герою' : 'Фото места добавлено (видно в режиме камеры)'); }
});

// ---------- таймлайн ----------
const tracks = $('#tracks');
const tw = () => tracks.clientWidth;
const tx = (t) => (t / P.duration) * tw();
const xt = (x) => snapT((x / tw()) * P.duration);
function updateTimeUI() {
  $('#tc').textContent = `${T.toFixed(2)} / ${P.duration} с · кадр ${Math.round(T * fps())}`;
  $('#playhead').style.left = tx(T) + 'px';
}
function setTime(t) { T = snapT(t); updateTimeUI(); if (sel?.kind === 'obj') refreshProps(); }
function scrubFrom(e) {
  const r = tracks.getBoundingClientRect(); const mv = (ev) => setTime(xt(ev.clientX - r.left));
  playing = false; $('#play').textContent = '▶'; mv(e);
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}
$('#ruler').addEventListener('pointerdown', scrubFrom);
$('#objTrk').addEventListener('pointerdown', (e) => { if (e.target.id === 'objTrk') scrubFrom(e); });
$('#camTrk').addEventListener('pointerdown', (e) => { if (e.target.id === 'camTrk') scrubFrom(e); });

function dragKey(e, getKey, onDone) {
  e.stopPropagation(); const r = tracks.getBoundingClientRect(); const k = getKey(); const before = JSON.stringify(P); let moved = false;
  setTime(k.t); selKeyT = k.t;
  const mv = (ev) => { const t = xt(ev.clientX - r.left); if (t !== k.t) { k.t = t; moved = true; selKeyT = t; setTime(t); pathsDirty = true; refreshTimeline(); } };
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    if (moved) { undoStack.push(before); redoStack.length = 0; onDone?.(); markDirty(); } refreshAll(); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}
function refreshTimeline() {
  const ru = $('#ruler'); ru.querySelectorAll('.tick').forEach((x) => x.remove());
  const step = P.duration > 20 ? 2 : P.duration > 8 ? 1 : 0.5;
  for (let t = 0; t <= P.duration + 1e-6; t += step) { const d = document.createElement('div'); d.className = 'tick'; d.style.left = tx(t) + 'px'; d.textContent = (step < 1 ? t.toFixed(1) : t) + 's'; ru.appendChild(d); }
  const st = $('#shotsTrk'); st.querySelectorAll('.shot').forEach((x) => x.remove());
  const S = [...P.shots].sort((a, b) => a.from - b.from);
  S.forEach((s, i) => {
    const d = document.createElement('div'); d.className = 'shot' + (sel?.kind === 'shot' && sel.id === s.id ? ' sel' : '');
    Object.assign(d.style, { left: tx(s.from) + 1 + 'px', width: Math.max(4, tx(s.to) - tx(s.from) - 2) + 'px' }); d.textContent = `${i + 1}. ${s.name}`; d.title = `${s.from}–${s.to} с`;
    d.onpointerdown = (e) => { e.stopPropagation(); select({ kind: 'shot', id: s.id }); if (T < s.from || T >= s.to) setTime(s.from); };
    st.appendChild(d);
  });
  const ct = $('#camTrk'); ct.querySelectorAll('.dia').forEach((x) => x.remove());
  for (const s of S) for (const k of s.keys) {
    const d = document.createElement('div'); d.className = 'dia cam' + (sel?.kind === 'shot' && sel.id === s.id && selKeyT !== null && Math.abs(k.t - selKeyT) < 1e-3 ? ' cur' : '');
    d.style.left = tx(k.t) + 'px'; d.title = `${s.name}: ${k.t.toFixed(2)} с, ${k.lens} мм`;
    d.onpointerdown = (e) => { sel = { kind: 'shot', id: s.id }; attachTC(); dragKey(e, () => k, () => { k.t = Math.min(s.to, Math.max(s.from, k.t)); s.keys.sort((a, b) => a.t - b.t); }); };
    ct.appendChild(d);
  }
  const ot = $('#objTrk'); ot.querySelectorAll('.dia').forEach((x) => x.remove()); const o = selObj();
  $('#objTrkLbl').textContent = o ? o.name : 'Объект (выбери)';
  if (o?.keys) for (const k of o.keys) {
    const d = document.createElement('div'); d.className = 'dia' + (selKeyT !== null && Math.abs(k.t - selKeyT) < 1e-3 ? ' cur' : '');
    d.style.left = tx(k.t) + 'px'; d.title = `${k.t.toFixed(2)} с`;
    d.onpointerdown = (e) => dragKey(e, () => k, () => o.keys.sort((a, b) => a.t - b.t));
    ot.appendChild(d);
  }
  updateTimeUI();
}
new ResizeObserver(() => P && refreshTimeline()).observe(tracks);

// ---------- список объектов ----------
function refreshList() {
  $('#objlist').innerHTML = P.objects.map((o) => {
    const c = o.type === 'person' ? (o.labelColor || o.look?.top) : (o.labelColor || o.color || '#888');
    const av = o.ref ? `<img class="av" src="${assetURL(o.ref)}">` : `<span class="dot" style="background:${c}"></span>`;
    return `<div class="it ${sel?.kind === 'obj' && sel.id === o.id ? 'sel' : ''}" data-id="${o.id}">${av}<span class="nm">${esc(o.name)}</span>${o.keys?.length ? '<span class="tag">◆</span>' : ''}${o.hero ? '<span class="tag">★</span>' : ''}</div>`;
  }).join('') || '<div class="muted">Пусто. Добавь героя или предметы.</div>';
  $('#objlist').querySelectorAll('.it').forEach((el) => (el.onclick = () => select({ kind: 'obj', id: el.dataset.id })));
}

// ---------- панель свойств ----------
const row = (label, html) => `<div class="row"><label>${label}</label><div>${html}</div></div>`;
const num = (id, v, step = 0.1, extra = '') => `<input type="number" id="${id}" value="${v}" step="${step}" ${extra}>`;
const easeSel = (id, v) => `<select id="${id}">${Object.entries(EASES).map(([k, n]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
const col = (id, v) => `<input type="color" id="${id}" value="${v}">`;
function bind(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }

function refreshProps() {
  const el = $('#right'), o = selObj(), s = selShot();
  if (o) return propsObject(el, o);
  if (s) return propsShot(el, s);
  propsProject(el);
}

function propsProject(el) {
  const w = P.world, az = Math.round(THREE.MathUtils.radToDeg(Math.atan2(w.sun?.[0] ?? 14, w.sun?.[2] ?? 10))), hz = Math.round(THREE.MathUtils.radToDeg(Math.atan2(w.sun?.[1] ?? 22, Math.hypot(w.sun?.[0] ?? 14, w.sun?.[2] ?? 10))));
  el.innerHTML = `<h4>Сцена</h4>
    ${row('Небо / туман', col('wSky', w.sky || '#c3c6ca'))}${row('Земля', col('wGround', w.ground || '#8d9094'))}
    ${row('Сетка на полу', `<input type="checkbox" id="wGrid" ${w.grid !== false ? 'checked' : ''}> <span class="muted">видно движение камеры</span>`)}
    ${row('Туман, м', `<div class="vec">${num('wFog0', w.fog?.[0] ?? 30, 1)}${num('wFog1', w.fog?.[1] ?? 120, 1)}</div>`)}
    ${row('Солнце: азимут', `<input type="range" id="wAz" min="-180" max="180" value="${az}">`)}${row('Солнце: высота', `<input type="range" id="wH" min="5" max="85" value="${hz}">`)}
    <h4>Фото места (референс)</h4>
    ${P.refs.location ? `<img class="thumb" src="${assetURL(P.refs.location)}">` : '<div class="muted">Загрузи фото локации: оно ляжет поверх вида камеры, чтобы повторить ракурс. Можно просто перетащить картинку во вьюпорт.</div>'}
    <div class="btns"><button id="locUp">Загрузить фото</button>${P.refs.location ? '<button id="locDel">Убрать</button>' : ''}</div>
    ${B.ai?.images ? `<div class="btns"><button class="primary" id="aiPlace">🪄 Собрать макет по фото</button></div><input type="text" id="aiNote" placeholder="уточнение: «это кафе, камера у входа»" style="width:100%">
      <div class="muted">Claude построит серые объёмы и поставит камеру как на фото. Прежний макет «по фото» заменится.</div>` : ''}
    ${P.refs.location ? row('Поверх камеры', `<input type="checkbox" id="locShow" ${P.refs.showOverlay !== false ? 'checked' : ''}> <input type="range" id="locOp" min="0" max="1" step="0.05" value="${P.refs.overlay ?? 0.4}" style="width:110px">`) : ''}
    <h4>Как работать</h4>
    <div class="muted">1. Добавь героев и предметы, расставь их.<br>2. Встань на время, сдвинь героя — появится ключ движения.<br>3. Найди ракурс в рабочем виде и нажми «Ключ камеры». Два ключа в одном плане = движение камеры.<br>4. «Разрезать план» — склейка.<br>5. «Записать для Seedance» — чистый MP4 для @ref1.</div>`;
  const sun = () => { const a = THREE.MathUtils.degToRad(+$('#wAz').value), h = THREE.MathUtils.degToRad(+$('#wH').value), r = 26; return [R1(Math.sin(a) * Math.cos(h) * r), R1(Math.sin(h) * r), R1(Math.cos(a) * Math.cos(h) * r)]; };
  bind('wSky', 'change', (e) => change(() => (w.sky = e.target.value), 'world'));
  bind('wGround', 'change', (e) => change(() => (w.ground = e.target.value), 'world'));
  bind('wGrid', 'change', (e) => change(() => (w.grid = e.target.checked), 'world'));
  bind('wFog0', 'change', () => change(() => (w.fog = [+$('#wFog0').value, +$('#wFog1').value]), 'world'));
  bind('wFog1', 'change', () => change(() => (w.fog = [+$('#wFog0').value, +$('#wFog1').value]), 'world'));
  bind('wAz', 'input', () => { w.sun = sun(); stage.applyWorld(); }); bind('wAz', 'change', () => change(() => (w.sun = sun()), 'world'));
  bind('wH', 'input', () => { w.sun = sun(); stage.applyWorld(); }); bind('wH', 'change', () => change(() => (w.sun = sun()), 'world'));
  bind('locUp', 'click', () => pickFile('image/*', async (f) => { const p = await upload(f); change(() => (P.refs.location = p)); }));
  bind('locDel', 'click', () => change(() => (P.refs.location = null)));
  bind('aiPlace', 'click', aiPlace);
  bind('locShow', 'change', (e) => change(() => (P.refs.showOverlay = e.target.checked)));
  bind('locOp', 'input', (e) => { P.refs.overlay = +e.target.value; }); bind('locOp', 'change', () => markDirty());
}

let showScaleCol = false;   // колонка «масштаб» в таблице ключей свёрнута до щелчка
const PRIMS = ['box', 'plane', 'cyl', 'sphere', 'cone', 'capsule', 'car', 'boat'];
const poseSel = (id, v, short = false) => `<select id="${id}">${Object.entries(POSES).map(([p, n]) => `<option value="${p}" ${(v || 'auto') === p ? 'selected' : ''}>${short ? n.split(' ')[0] : n}</option>`).join('')}</select>`;
const objOpts = (o, v, allowNone) => (allowNone ? '<option value="">—</option>' : '') + P.objects.filter((x) => x.id !== o?.id).map((x) => `<option value="${x.id}" ${x.id === v ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
function propsObject(el, o) {
  const st = worldTransform(o, T, P), animated = o.keys?.length > 0, isP = o.type === 'person', L = { ...DEFAULT_LOOK, ...(o.look || {}) };
  const curA = attachAt(o, T);
  const node = stage.nodes.get(o.id), clips = node?.userData.clips || [];
  let h = `<h4>${isP ? 'Человек' : o.type === 'glb' ? '3D-модель' : 'Объект'}</h4>
    ${row('Имя', `<input type="text" id="oName" value="${esc(o.name)}" style="width:100%">`)}
    ${row('Герой', `<input type="checkbox" id="oHero" ${o.hero ? 'checked' : ''}> <span class="muted">подпись в версии на проверку</span>`)}
    ${o.hero ? row('Цвет подписи', col('oLab', o.labelColor || o.color || '#ff3b30')) : ''}`;
  if (isP) {
    h += `<h4>Внешность (по фото)</h4>
      ${o.ref ? `<img class="thumb" src="${assetURL(o.ref)}">` : ''}<div class="btns"><button id="oRef">${o.ref ? 'Заменить фото' : 'Загрузить фото героя'}</button>${B.ai?.images ? `<button class="primary" id="aiHero">🪄 ${o.ref ? 'Внешность по фото' : 'Фото → герой'}</button>` : ''}</div>
      ${o.desc ? `<div class="muted">${esc(o.desc)}</div>` : ''}
      ${row('Рост, м', num('oH', o.size?.[1] ?? 1.75, 0.01, 'min="0.5" max="2.5"'))}
      ${row('Телосложение', `<input type="range" id="oBuild" min="0.75" max="1.45" step="0.05" value="${L.build}">`)}
      ${row('Кожа', col('lSkin', L.skin))}${row('Волосы', `${col('lHair', L.hair)} <select id="lHS">${[['short', 'короткие'], ['long', 'длинные'], ['bun', 'пучок'], ['bald', 'лысый']].map(([k, n]) => `<option value="${k}" ${L.hairStyle === k ? 'selected' : ''}>${n}</option>`).join('')}</select>`)}
      ${row('Верх', `${col('lTop', L.top)} <select id="lSl"><option value="long" ${L.sleeves !== 'short' ? 'selected' : ''}>рукав длинный</option><option value="short" ${L.sleeves === 'short' ? 'selected' : ''}>короткий</option></select>`)}
      ${row('Низ', col('lBot', L.bottom))}${row('Обувь', col('lSh', L.shoes))}`;
  } else if (o.type === 'glb') {
    h += `<div class="muted">${esc(o.glb.src)}</div>
      ${row('Высота, м', num('oH', o.size?.[1] ?? 1.75, 0.05))}${row('Доп. поворот', num('gRot', o.glb.rotY || 0, 15))}
      ${row('Анимация', `<select id="gClip"><option value="">— нет —</option>${clips.map((c) => `<option ${c === o.glb.clip ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`)}
      ${o.ref ? `<img class="thumb" src="${assetURL(o.ref)}">` : ''}<div class="btns"><button id="oRef">${o.ref ? 'Заменить фото' : 'Фото-референс'}</button></div>`;
  } else {
    const s = o.size || [1, 1, 1], d3 = ['box', 'plane', 'car'].includes(o.type);
    h += row('Цвет', col('oCol', o.color || '#9a9da1')) + row(d3 ? 'Ш × В × Г, м' : 'Диаметр × В, м', `<div class="vec">${num('s0', s[0])}${o.type === 'plane' ? '' : num('s1', s[1])}${d3 ? num('s2', s[2] ?? s[0]) : ''}</div>`);
    if (PRIMS.includes(o.type)) h += row('Ось вращения', `<select id="oPiv">${Object.entries(PIVOTS).map(([k, n]) => `<option value="${k}" ${(o.pivot || 'center') === k ? 'selected' : ''}>${n}</option>`).join('')}</select>`);
    if (o.hero) h += `<div class="btns"><button id="oRef">${o.ref ? 'Заменить фото' : 'Фото-референс'}</button></div>${o.ref ? `<img class="thumb" src="${assetURL(o.ref)}">` : ''}`;
  }
  h += `<h4>Положение на ${T.toFixed(2)} с ${curA ? `(привязан к «${esc(objById(P, curA.parent)?.name)}»)` : animated ? '(анимирован)' : ''}</h4>
    ${row('X · Y · Z, м', `<div class="vec">${num('px', R1(st.pos[0]))}${num('py', R1(st.pos[1]))}${num('pz', R1(st.pos[2]))}</div>`)}
    ${row('Поворот, °', `<div class="vec">${['person', 'car', 'glb'].includes(o.type) ? '' : num('rx', R1(st.rot[0]), 5)}${num('ry', R1(st.rot[1]), 5)}${['person', 'car', 'glb'].includes(o.type) ? '' : num('rz', R1(st.rot[2]), 5)}</div>`)}
    ${animated && ['person', 'car', 'glb'].includes(o.type) ? row('Направление', `<select id="oFace"><option value="travel" ${o.face !== 'none' ? 'selected' : ''}>по движению</option><option value="none" ${o.face === 'none' ? 'selected' : ''}>как задано</option></select>`) : ''}
    ${!animated && isP ? row('Поза', poseSel('oPose', o.pose)) : ''}
    ${row('Масштаб', `<div class="vec">${[0, 1, 2].map((j) => num('sc' + j, (o.scale || [1, 1, 1])[j], 0.05)).join('')}</div>`)}
    <h4>Привязки</h4>`;
  const A = o.attach || [];
  if (A.length) h += A.map((a, i) => `<div class="att">
      ${row('Родитель', `<select id="aP${i}">${objOpts(o, a.parent)}</select>`)}
      ${row('С · до, с', `<div class="vec">${num('aF' + i, a.from, 1 / fps())}${num('aT' + i, a.to, 1 / fps())}</div>`)}
      ${row('Смещение', `<div class="vec">${[0, 1, 2].map((j) => num(`aO${i}_${j}`, (a.offset || [0, 0, 0])[j], 0.05)).join('')}</div>`)}
      ${row('Поворот Y, °', num('aR' + i, a.rotY || 0, 5))}
      ${row('Полёт перед', `<input type="checkbox" id="aFl${i}" ${a.flight ? 'checked' : ''}>${a.flight ? ` дуга ${num('aArc' + i, a.flight.arc ?? 2, 0.1, 'style="width:52px"')} кувырок ${num('aSpin' + i, a.flight.spin ?? 0, 30, 'style="width:58px"')}° ${poseSel('aPose' + i, a.flight.pose || 'jump', true)}` : ''}`)}
      <div class="btns"><button class="small" id="aGo${i}">→ к началу</button><button class="small" id="aDel${i}">✕ отвязать</button></div></div>`).join('')
    + `<div class="muted">Внутри интервала объект едет с родителем, его ключи дают только позу. Гизмо меняет смещение. «Полёт» — дуга от прошлого отцепления до этой привязки.</div>`;
  else h += `<div class="muted">Объект ни к чему не привязан. Привязка: едет вместе с родителем (пассажир, груз в руках).</div>`;
  h += `<div class="btns"><select id="attSel">${objOpts(o, null, false)}</select><button id="attGo">🔗 Привязать с текущего места</button></div>
    <h4>Ключи движения</h4>`;
  if (animated) {
    h += `<table class="keys"><tr class="muted"><td>время</td><td>подход</td>${isP ? '<td>поза</td>' : ''}<td><button class="small" id="kScT" title="показать / скрыть масштаб">${showScaleCol ? 'масштаб ▾' : 'масштаб ▸'}</button></td><td></td></tr>${o.keys.map((k, i) => `<tr class="${selKeyT !== null && Math.abs(k.t - selKeyT) < 1e-3 ? 'cur' : ''}">
      <td>${num('kt' + i, k.t, 1 / fps(), 'min="0"')}</td><td>${i === 0 ? '<span class="muted">старт</span>' : easeSel('ke' + i, k.ease || 'linear')}</td>
      ${isP ? `<td>${poseSel('kp' + i, k.pose, true)}</td>` : ''}
      <td>${showScaleCol ? `<div class="vec">${[0, 1, 2].map((j) => num(`ks${i}_${j}`, k.scale ? k.scale[j] : '', 0.05, 'placeholder="—" style="width:44px"')).join('')}</div>` : `<span class="muted">${k.scale ? k.scale.join(' × ') : '—'}</span>`}</td>
      <td><button class="small" id="kg${i}" title="перейти">→</button><button class="small" id="kd${i}" title="удалить">✕</button></td></tr>`).join('')}</table>
      <div class="muted">«подход» — как объект приходит в этот ключ: плавно, с торможением и т.д. Поза держится до следующего ключа.</div>`;
  } else h += `<div class="muted">Объект стоит на месте. Перемести время на таймлайне и сдвинь объект — появится движение.</div>`;
  h += `<div class="btns"><button id="kAdd">◆ Ключ здесь</button>${animated ? '<button id="kClr">Убрать анимацию</button>' : ''}<button id="oDup">Дублировать</button><button id="oDel">Удалить</button></div>`;
  el.innerHTML = h;

  bind('oName', 'change', (e) => change(() => (o.name = e.target.value)));
  bind('oHero', 'change', (e) => change(() => { o.hero = e.target.checked; if (o.hero && !o.labelColor) o.labelColor = HERO_COLORS[heroCount() % HERO_COLORS.length]; }, o.id));
  bind('oLab', 'change', (e) => change(() => (o.labelColor = e.target.value)));
  bind('oRef', 'click', () => pickFile('image/*', async (f) => { const p = await upload(f); change(() => (o.ref = p)); }));
  bind('aiHero', 'click', () => aiHero(o));
  bind('oH', 'change', (e) => change(() => { o.size = [...(o.size || [0.5, 1.75])]; o.size[1] = +e.target.value; }, o.id));
  bind('oBuild', 'change', (e) => change(() => { o.look = { ...L, build: +e.target.value }; }, o.id));
  for (const [id, key] of [['lSkin', 'skin'], ['lHair', 'hair'], ['lHS', 'hairStyle'], ['lTop', 'top'], ['lSl', 'sleeves'], ['lBot', 'bottom'], ['lSh', 'shoes']])
    bind(id, 'change', (e) => change(() => { o.look = { ...L, [key]: e.target.value }; }, o.id));
  bind('gRot', 'change', (e) => change(() => (o.glb.rotY = +e.target.value), o.id));
  bind('gClip', 'change', (e) => change(() => (o.glb.clip = e.target.value), o.id));
  bind('oCol', 'change', (e) => change(() => (o.color = e.target.value), o.id));
  for (const i of [0, 1, 2]) bind('s' + i, 'change', (e) => change(() => { o.size = [...(o.size || [1, 1, 1])]; o.size[i] = Math.max(0.01, +e.target.value); }, o.id));
  const tf = () => { const g = (id, d) => { const x = document.getElementById(id); return x ? +x.value : d; }; setTransform(o, [g('px', 0), g('py', 0), g('pz', 0)], [g('rx', st.rot[0]), g('ry', 0), g('rz', st.rot[2])]); };
  for (const id of ['px', 'py', 'pz', 'rx', 'ry', 'rz']) bind(id, 'change', tf);
  bind('oFace', 'change', (e) => change(() => (o.face = e.target.value)));
  bind('oPiv', 'change', (e) => change(() => { if (e.target.value === 'center') delete o.pivot; else o.pivot = e.target.value; }, o.id));
  for (const j of [0, 1, 2]) bind('sc' + j, 'change', (e) => change(() => { o.scale = [...(o.scale || [1, 1, 1])]; o.scale[j] = Math.max(0.01, +e.target.value || 1); if (o.scale.every((v) => v === 1)) delete o.scale; }));
  bind('kScT', 'click', () => { showScaleCol = !showScaleCol; refreshProps(); });
  A.forEach((a, i) => {
    bind('aP' + i, 'change', (e) => { if (wouldCycle(P, o.id, e.target.value)) { toast('Так получится цикл привязок'); return refreshProps(); } change(() => (a.parent = e.target.value)); });
    bind('aF' + i, 'change', (e) => change(() => (a.from = snapT(+e.target.value))));
    bind('aT' + i, 'change', (e) => change(() => (a.to = snapT(+e.target.value))));
    for (const j of [0, 1, 2]) bind(`aO${i}_${j}`, 'change', (e) => change(() => { a.offset = [...(a.offset || [0, 0, 0])]; a.offset[j] = +e.target.value; }));
    bind('aR' + i, 'change', (e) => change(() => (a.rotY = +e.target.value)));
    bind('aFl' + i, 'change', (e) => change(() => { if (e.target.checked) a.flight = { arc: 2, spin: 0, pose: 'jump' }; else delete a.flight; }));
    bind('aArc' + i, 'change', (e) => change(() => (a.flight.arc = +e.target.value)));
    bind('aSpin' + i, 'change', (e) => change(() => (a.flight.spin = +e.target.value)));
    bind('aPose' + i, 'change', (e) => change(() => (a.flight.pose = e.target.value)));
    bind('aGo' + i, 'click', () => setTime(a.from));
    bind('aDel' + i, 'click', () => change(() => { o.attach.splice(i, 1); if (!o.attach.length) delete o.attach; }));
  });
  bind('attGo', 'click', () => attachHere(o, $('#attSel').value));
  bind('oPose', 'change', (e) => change(() => (o.pose = e.target.value)));
  (o.keys || []).forEach((k, i) => {
    bind('kt' + i, 'change', (e) => change(() => { k.t = snapT(+e.target.value); o.keys.sort((a, b) => a.t - b.t); selKeyT = k.t; }));
    bind('ke' + i, 'change', (e) => change(() => (k.ease = e.target.value)));
    bind('kp' + i, 'change', (e) => change(() => (k.pose = e.target.value)));
    for (const j of [0, 1, 2]) bind(`ks${i}_${j}`, 'change', (e) => change(() => {
      const v = e.target.value === '' ? null : Math.max(0.01, +e.target.value);
      if (v === null) { delete k.scale; return; }
      k.scale = [...(k.scale || objectState(o, k.t).scale)]; k.scale[j] = v;
    }));
    bind('kg' + i, 'click', () => { selKeyT = k.t; setTime(k.t); refreshAll(); });
    bind('kd' + i, 'click', () => change(() => { o.keys.splice(i, 1); if (o.keys.length === 0) { o.pos = k.pos; o.rot = k.rot; delete o.keys; } }));
  });
  bind('kAdd', 'click', () => addObjKey());
  bind('kClr', 'click', () => change(() => { const s0 = objectState(o, T); o.pos = s0.pos.map(R3); o.rot = s0.rot.map(R1); delete o.keys; }));
  bind('oDup', 'click', duplicateObject); bind('oDel', 'click', deleteObject);
}
// привязать объект к родителю с текущего места: смещение считается из текущих позиций
function attachHere(o, pid) {
  if (!pid) return;
  if (wouldCycle(P, o.id, pid)) return toast('Так получится цикл привязок: родитель уже едет на этом объекте');
  const t = snapT(T), w = worldTransform(o, t, P);
  change(() => {
    o.attach ||= [];
    const cur = o.attach.find((a) => t >= a.from && t < a.to); if (cur) cur.to = t;   // прошлая привязка заканчивается здесь
    const next = o.attach.filter((a) => a.from > t).sort((a, b) => a.from - b.from)[0];
    const a = { parent: pid, from: t, to: next ? next.from : P.duration, ...toOffsetAt(pid, t, w) };
    o.attach.push(a); o.attach.sort((x, y) => x.from - y.from);
  });
  toast(`Привязан к «${objById(P, pid)?.name}» с ${t.toFixed(2)} с`);
}
const toOffsetAt = (pid, t, w) => toOffset({ parent: pid }, t, w.pos, w.rot);
function addObjKey() {
  const o = selObj(); if (!o) return;
  change(() => { if (!o.keys?.length) { o.keys = [{ t: 0, pos: (o.pos || [0, 0, 0]).slice(), rot: (o.rot || [0, 0, 0]).slice(), ease: 'linear' }]; delete o.pos; delete o.rot; } upsertKey(o, snapT(T), {}); });
}

function propsShot(el, s) {
  const S = [...P.shots].sort((a, b) => a.from - b.from), i = S.indexOf(s) + 1;
  el.innerHTML = `<h4>План ${i}</h4>
    ${row('Название', `<input type="text" id="sName" value="${esc(s.name)}" style="width:100%">`)}
    ${row('Время, с', `<div class="vec">${num('sFrom', s.from, 0.1)}${num('sTo', s.to, 0.1)}</div>`)}
    ${row('Движение', easeSel('sEase', s.ease || 'inOut'))}
    ${row('Тряска (рука)', `<input type="range" id="sShake" min="0" max="0.06" step="0.005" value="${s.shake || 0}">`)}
    ${row('Завал горизонта', num('sRoll', s.roll || 0, 1))}
    ${row('Следовать за', `<select id="sFol">${objOpts(null, s.follow, true)}</select>`)}
    ${s.follow ? row('', `<label><input type="checkbox" id="sFolY" ${s.followYaw !== false ? 'checked' : ''}> поворачивать вместе с объектом</label>`) : ''}
    ${s.follow ? '<div class="muted">Ключи камеры заданы относительно объекта: камера летит вместе с ним. «Ключ из рабочего вида» сам переводит вид в его координаты.</div>' : ''}
    <h4>Ключи камеры</h4>
    <table class="keys"><tr class="muted"><td>время</td><td>объектив</td><td></td></tr>${s.keys.map((k, j) => `<tr class="${selKeyT !== null && Math.abs(k.t - selKeyT) < 1e-3 ? 'cur' : ''}"><td>${num('ct' + j, k.t, 1 / fps())}</td><td>${num('cl' + j, k.lens, 1)} мм</td><td><button class="small" id="cg${j}">→</button><button class="small" id="cd${j}">✕</button></td></tr>`).join('')}</table>
    <div class="muted">Один ключ — камера стоит. Два и больше — камера едет по плавной кривой через все ключи. «Движение» задаёт разгон и торможение всего проезда.</div>
    <div class="btns"><button id="sKey">📷 Ключ из рабочего вида</button><button id="sGrab">👁 Взять вид камеры</button><button id="sSplit">✂ Разрезать здесь</button><button id="sDel">Удалить план</button></div>`;
  bind('sName', 'change', (e) => change(() => (s.name = e.target.value)));
  bind('sEase', 'change', (e) => change(() => (s.ease = e.target.value)));
  bind('sShake', 'change', (e) => change(() => (s.shake = +e.target.value)));
  bind('sRoll', 'change', (e) => change(() => (s.roll = +e.target.value)));
  // смена «следовать за»: ключи пересчитываются, чтобы камера осталась на месте
  const refollow = (mut) => change(() => {
    const old = s.keys.map((k) => { const F = followFrame(P, s, k.t); return { pos: F.toWorld(k.pos), target: F.toWorld(k.target) }; });
    mut();
    s.keys.forEach((k, j) => { const F = followFrame(P, s, k.t); k.pos = F.toLocal(old[j].pos).map(R3); k.target = F.toLocal(old[j].target).map(R3); });
  });
  bind('sFol', 'change', (e) => refollow(() => { if (e.target.value) { s.follow = e.target.value; s.followYaw ??= true; } else { delete s.follow; delete s.followYaw; } }));
  bind('sFolY', 'change', (e) => refollow(() => (s.followYaw = e.target.checked)));
  const retime = () => change(() => {
    const f = Math.max(0, +$('#sFrom').value), t = Math.min(P.duration, +$('#sTo').value); if (t - f < 0.2) return;
    const j = S.indexOf(s), prev = S[j - 1], next = S[j + 1];
    s.from = prev ? Math.max(prev.from + 0.2, f) : 0; s.to = next ? Math.min(next.to - 0.2, t) : P.duration;
    if (prev) prev.to = s.from; if (next) next.from = s.to;
  });
  bind('sFrom', 'change', retime); bind('sTo', 'change', retime);
  s.keys.forEach((k, j) => {
    bind('ct' + j, 'change', (e) => change(() => { k.t = Math.min(s.to, Math.max(s.from, snapT(+e.target.value))); s.keys.sort((a, b) => a.t - b.t); }));
    bind('cl' + j, 'change', (e) => change(() => (k.lens = Math.max(8, +e.target.value))));
    bind('cg' + j, 'click', () => { selKeyT = k.t; setTime(k.t); refreshAll(); });
    bind('cd' + j, 'click', () => { if (s.keys.length < 2) return toast('В плане должен остаться хотя бы один ключ'); change(() => s.keys.splice(j, 1)); });
  });
  bind('sKey', 'click', camKeyFromView); bind('sGrab', 'click', grabCamView); bind('sSplit', 'click', splitShot); bind('sDel', 'click', () => deleteShot(s));
}

function refreshAll() {
  if (!P) return;
  $('#fmt').value = P.format.w >= P.format.h ? 'h' : 'v'; $('#dur').value = P.duration;
  refreshList(); refreshProps(); refreshTimeline();
}

// ---------- запись ----------
let fr = null;
async function record(labels) {
  if (!projName) return;
  await save();
  const s = $('#recShot').checked ? (selShot() || shotAt(P, T)) : null;
  const from = s ? s.from : 0, to = s ? s.to : P.duration, F = fps(), n = Math.round((to - from) * F);
  fr ||= new FrameRenderer(stage);
  modal(`<h3>Запись ${labels ? 'с подписями' : 'для Seedance'}</h3><div class="muted">${P.format.w}×${P.format.h}, ${F} fps, ${(to - from).toFixed(1)} с · ${n} кадров</div><div class="bar"><i id="pbar"></i></div><div id="ptxt" class="muted">…</div><div class="btns" style="margin-top:10px"><button id="pStop">Остановить</button></div>`);
  let stop = false; $('#pStop').onclick = () => (stop = true);
  const wasPlaying = playing; playing = false;
  try {
    const rec = await B.recorder({ fps: F, w: P.format.w, h: P.format.h, labels });
    const t0 = performance.now();
    for (let i = 0; i < n && !stop; i++) {
      await rec.add(fr.frame(from + i / F, labels));
      if (i % 4 === 0) { $('#pbar').style.width = (i / n * 100) + '%'; const el = (performance.now() - t0) / 1000; $('#ptxt').textContent = `${i}/${n} кадров · осталось ~${Math.max(0, Math.round(el / (i + 1) * (n - i)))} с`; }
    }
    const res = await rec.end();
    res.filename = `${(P.name || 'scene').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40)}_${labels ? 'review' : 'animatic'}${s ? '_plan' : ''}.mp4`;
    modal(`<h3>${stop ? 'Остановлено' : 'Готово'}</h3><video src="${res.url}" controls autoplay loop muted playsinline style="width:100%;max-height:60vh;border-radius:8px;background:#000"></video>
      ${res.where ? `<div class="muted" style="margin:8px 0;word-break:break-all">${esc(res.where)}</div>` : ''}
      <div class="btns"><button class="primary" id="pDl">Скачать MP4</button><button id="pClose">Закрыть</button></div>
      ${labels ? '<div class="muted">Версия с подписями — только для проверки.</div>' : '<div class="muted">Этот файл загружается в Seedance как видео-референс @ref1.</div>'}<div id="pMsg" class="muted"></div>`);
    $('#pDl').onclick = async () => { try { await B.download(res); $('#pMsg').textContent = 'Сохранено'; } catch (e) { $('#pMsg').textContent = e.code === 'declined' ? 'Скачивание отменено' : 'Не удалось скачать: ' + (e.message || e.code); } };
    $('#pClose').onclick = closeModal;
  } catch (e) { modal(`<h3>Ошибка записи</h3><div>${esc(e.message || e)}</div><div class="btns"><button id="pClose">Закрыть</button></div>`); $('#pClose').onclick = closeModal; }
  playing = wasPlaying;
}

// ---------- «по фото»: Claude смотрит на фото прямо со страницы (онлайн-версия) ----------
const HEX = /^#[0-9a-f]{6}$/i;
const clampN = (v, a, b, d) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : d);
async function refBlob(ref) { const r = await fetch(assetURL(ref)); if (!r.ok) throw new Error('фото не загрузилось'); return r.blob(); }
function aiBusy(text) { modal(`<h3>🪄 ${esc(text)}</h3><div class="muted">Claude смотрит на фото. Обычно 10–40 секунд.</div><div class="bar"><i style="width:100%;opacity:.5"></i></div>`); }
function aiFail(e) { closeModal(); const m = { not_granted: 'Нужно разрешить странице обращаться к Claude', rate_limited: 'Слишком часто — попробуй через минуту', invalid_json: 'Claude ответил не по формату — попробуй ещё раз', image_rejected: 'Это фото не подходит, возьми другое' }[e?.code]; toast(m || 'Не получилось: ' + (e?.message || e), 6000); }
async function aiHero(o) {
  if (!o.ref) return pickFile('image/*', async (f) => { const p = await upload(f); await change(() => (o.ref = p)); aiHero(o); });
  aiBusy('Собираю героя по фото');
  try {
    const r = await B.ai.hero(await refBlob(o.ref));
    const L = { ...DEFAULT_LOOK, ...(o.look || {}) };
    for (const k of ['skin', 'hair', 'top', 'bottom', 'shoes']) if (HEX.test(r[k] || '')) L[k] = r[k];
    if (['short', 'long', 'bun', 'bald'].includes(r.hairStyle)) L.hairStyle = r.hairStyle;
    if (['long', 'short'].includes(r.sleeves)) L.sleeves = r.sleeves;
    L.build = clampN(r.build, 0.75, 1.45, L.build);
    await change(() => { o.look = L; o.size = [o.size?.[0] ?? 0.5, clampN(r.height, 0.6, 2.3, o.size?.[1] ?? 1.75)]; if (r.desc) { o.desc = String(r.desc).slice(0, 60); if (/^Герой \d+$/.test(o.name)) o.name = o.desc; } }, o.id);
    closeModal(); toast('Герой собран по фото' + (r.desc ? ': ' + r.desc : ''));
  } catch (e) { aiFail(e); }
}
async function aiPlace() {
  const run = async () => {
    aiBusy('Собираю макет места по фото');
    try {
      const r = await B.ai.place(await refBlob(P.refs.location), $('#aiNote')?.value || '');
      const types = ['box', 'cyl', 'sphere', 'plane', 'car', 'cone'], greys = ['#9a9da1', '#7e8185', '#b4b7ba', '#8d9094', '#a7aaae'];
      const objs = (Array.isArray(r.objects) ? r.objects : []).slice(0, 40).map((x, i) => {
        const type = types.includes(x.type) ? x.type : 'box', sz = Array.isArray(x.size) ? x.size.map((v) => clampN(v, 0.02, 200, 1)) : [1, 1, 1];
        const pos = Array.isArray(x.pos) ? [clampN(x.pos[0], -300, 300, 0), clampN(x.pos[1], -5, 100, 0), clampN(x.pos[2], -300, 300, 0)] : [0, 0, 0];
        return { id: uid('o'), name: String(x.name || `Объём ${i + 1}`).slice(0, 40), type, size: type === 'car' ? [1.8, 1.45, 4.3] : [sz[0] ?? 1, sz[1] ?? 1, sz[2] ?? sz[0] ?? 1], color: type === 'car' ? '#7e8185' : greys[i % greys.length], pos, rot: [0, clampN(x.rotY, -360, 360, 0), 0], fromPhoto: true };
      });
      if (!objs.length) throw new Error('Claude не нашёл, что построить');
      const c = r.camera || {};
      await change(() => {
        P.objects = P.objects.filter((o) => !o.fromPhoto).concat(objs);
        if (Array.isArray(c.pos) && Array.isArray(c.target)) {
          const s0 = [...P.shots].sort((a, b) => a.from - b.from)[0];
          const k = { t: s0.from, pos: c.pos.slice(0, 3).map((v) => clampN(v, -300, 300, 0)), target: c.target.slice(0, 3).map((v) => clampN(v, -300, 300, 0)), lens: clampN(c.lens, 12, 200, 35) };
          s0.keys = [k, ...s0.keys.filter((x) => x.t > s0.from + 1e-3)];
        }
      }, true);
      closeModal(); frameAll(); toast(`Макет собран: ${objs.length} объектов${r.desc ? ' · ' + r.desc : ''}. Нажми C, чтобы сверить ракурс с фото`, 6000);
    } catch (e) { aiFail(e); }
  };
  if (!P.refs.location) return pickFile('image/*', async (f) => { const p = await upload(f); await change(() => (P.refs.location = p)); run(); });
  run();
}

// ---------- кнопки и клавиши ----------
document.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => addObject(b.dataset.add)));
$('#vmode').onclick = () => setMode(mode === 'camera' ? 'director' : 'camera');
$('#tMove').onclick = () => { tc.setMode('translate'); $('#tMove').classList.add('on'); $('#tRot').classList.remove('on'); attachTC(); };
$('#tRot').onclick = () => { tc.setMode('rotate'); $('#tRot').classList.add('on'); $('#tMove').classList.remove('on'); attachTC(); };
$('#autokey').onclick = () => { autoKey = !autoKey; $('#autokey').classList.toggle('on', autoKey); };
$('#dlens').oninput = (e) => { dirCam.setFocalLength(+e.target.value); dirCam.updateProjectionMatrix(); refreshLens(); };
$('#play').onclick = togglePlay;
$('#prevF').onclick = () => setTime(T - 1 / fps()); $('#nextF').onclick = () => setTime(T + 1 / fps());
$('#keyObj').onclick = () => (selObj() ? addObjKey() : toast('Сначала выбери объект'));
$('#keyCam').onclick = camKeyFromView; $('#grabCam').onclick = grabCamView; $('#split').onclick = splitShot;
$('#undo').onclick = undo; $('#redo').onclick = redo;
$('#newProj').onclick = createProject;
$('#projSel').onchange = (e) => openProject(e.target.value);
$('#fmt').onchange = (e) => change(() => { P.format = e.target.value === 'v' ? { w: 720, h: 1280, fps: fps() } : { w: 1280, h: 720, fps: fps() }; });
$('#dur').onchange = (e) => setDuration(+e.target.value);
$('#recClean').onclick = () => record(false); $('#recLab').onclick = () => record(true);
function togglePlay() { playing = !playing; $('#play').textContent = playing ? '❚❚' : '▶'; if (playing) { playFrom = T; playT0 = performance.now(); } else { T = snapT(T); updateTimeUI(); refreshProps(); } }

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.code === 'KeyZ') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (cmd && e.code === 'KeyD') { e.preventDefault(); return duplicateObject(); }
  if (cmd) return;
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'KeyW': $('#tMove').click(); break;
    case 'KeyE': $('#tRot').click(); break;
    case 'KeyC': setMode(mode === 'camera' ? 'director' : 'camera'); break;
    case 'KeyK': if (selObj()) addObjKey(); else camKeyFromView(); break;
    case 'Delete': case 'Backspace': deleteObject(); break;
    case 'Escape': select(null); break;
    case 'ArrowLeft': setTime(T - 1 / fps()); break;
    case 'ArrowRight': setTime(T + 1 / fps()); break;
    case 'KeyA': if (e.shiftKey) frameAll(); break;
    case 'KeyF': { const n = selObj() && stage.nodes.get(sel.id); if (n) { orbit.target.copy(n.position).add(new THREE.Vector3(0, (n.userData.height || 1) / 2, 0)); } break; }
  }
});
window.addEventListener('beforeunload', () => { if (dirty) save(); });

// ---------- старт ----------
resize(); refreshLens();
status('подключение…');
const list = await listProjects();
const want = new URLSearchParams(location.search).get('p');
if (want && list.find((p) => p.id === want)) await openProject(want);
else if (list.length) await openProject(list[0].id);
else {
  let p = null;
  for (const u of ['./examples/primer.json', './examples/' + encodeURIComponent('Пример — встреча на улице') + '/project.json']) { try { const r = await fetch(u); if (r.ok) { p = await r.json(); break; } } catch {} }
  p ||= newProject('Моя первая сцена');
  const id = await B.create(p.name, p); await listProjects(); await openProject(id);
}
if (B.offline) toast('Страница открыта вне Claude: сцены не сохраняются', 6000);
window.__studio = { B, aiHero, aiPlace, change, upload, get P() { return P; }, stage, setTime, select, setMode, addObject, camKeyFromView, commitTransform, splitShot, record, undo, frameAll, dirCam, orbit, addGLB, get T() { return T; } };
loop();
