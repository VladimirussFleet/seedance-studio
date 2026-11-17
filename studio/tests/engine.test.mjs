// Автопроверки движка без браузера:  node studio/tests/engine.test.mjs [путь/к/project.json]
// 1) нет скачков при прицеплении/отцеплении  2) смещение камеры за объектом постоянно
// 3) край у петли неподвижен  4) одинаковое t даёт одинаковый результат  5) масштаб от основания
import fs from 'node:fs';
import * as THREE from 'three';
import { worldTransform, attachments, cameraState, followFrame, Stage } from '../engine.js';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// --- тестовая сцена: машина едет, на ней человек, потом прыжок на катер, у человека чемодан ---
const T = {
  format: { w: 720, h: 1280, fps: 24 }, duration: 10, world: {},
  objects: [
    { id: 'car', type: 'car', size: [1.8, 1.45, 4.3], keys: [{ t: 0, pos: [0, 4, -60] }, { t: 6, pos: [0, 4, 0] }] },
    { id: 'boat', type: 'boat', size: [3, 1.2, 9], keys: [{ t: 0, pos: [-30, 0, 15] }, { t: 10, pos: [20, 0, 15] }] },
    { id: 'girl', type: 'person', size: [0.5, 1.6], keys: [{ t: 0, pos: [0, 0, 0], pose: 'sit' }, { t: 4, pos: [0, 0, 0], pose: 'crouch' }, { t: 6.5, pos: [0, 0, 0], pose: 'auto' }],
      attach: [{ parent: 'car', from: 0, to: 5, offset: [0, 0.95, -1.7] }, { parent: 'boat', from: 6.5, to: 10, offset: [0, 1.2, -2.5], rotY: 180, flight: { arc: 2.5, spin: 360, pose: 'jump' } }] },
    { id: 'case', type: 'box', size: [0.45, 0.32, 0.12], attach: [{ parent: 'girl', from: 0, to: 10, offset: [0.25, 0.9, 0.3] }] },
    { id: 'span', type: 'box', size: [12, 0.8, 15], pivot: 'z-', keys: [{ t: 0, pos: [0, 3.2, 7.5], rot: [0, 0, 0] }, { t: 8, pos: [0, 3.2, 7.5], rot: [-38, 0, 0], ease: 'inOut' }] },
    { id: 'loop', type: 'box', size: [1, 1, 1], attach: [{ parent: 'loop2', from: 0, to: 10 }] },
    { id: 'loop2', type: 'box', size: [1, 1, 1], attach: [{ parent: 'loop', from: 0, to: 10 }] },
  ],
  shots: [{ id: 's1', from: 0, to: 10, follow: 'car', followYaw: true, keys: [{ t: 0, pos: [3.2, 0.7, 0.5], target: [0, 0.8, 0.5], lens: 24 }] }],
};
const W = (id, t, p = T) => worldTransform(p.objects.find((o) => o.id === id), t, p);
const F = 1 / 24;
// скачок: шаг через край не больше «скорость рядом с краем × кадр + 2 см»
function jumpCheck(w, e) {
  const p = [-2, -1, 0, 1, 2].map((i) => w(e + i * F));
  const v = Math.max(dist(p[0], p[1]), dist(p[3], p[4])) / F, lim = v * F + 0.02;
  const s1 = dist(p[1], p[2]), s2 = dist(p[2], p[3]); return { ok: s1 < lim && s2 < lim, s1, s2, lim };
}

console.log('1. Прицепление и отцепление без скачка');
for (const [id, P] of [['girl', T]]) {
  const o = P.objects.find((x) => x.id === id);
  for (const a of attachments(o, P)) for (const edge of [a.from, a.to]) {
    if (edge <= 0 || edge >= P.duration) continue;
    const r = jumpCheck((t) => W(id, t, P).pos, edge);
    ok(r.ok, `${id} @ ${edge} с: шаги ${r.s1.toFixed(3)} / ${r.s2.toFixed(3)} м, допуск ${r.lim.toFixed(3)} м`);
  }
  // не скользит по багажнику: смещение относительно машины постоянно
  const rel = [0.5, 2, 4.5].map((t) => { const c = W('car', t).pos, g = W('girl', t).pos; return [g[0] - c[0], g[1] - c[1], g[2] - c[2]]; });
  ok(dist(rel[0], rel[1]) < 1e-6 && dist(rel[1], rel[2]) < 1e-6, 'угонщица не скользит по машине (смещение постоянно)');
  const c1 = W('case', 3).pos, g1 = W('girl', 3).pos; ok(Math.abs(c1[1] - g1[1] - 0.9) < 1e-6, 'чемодан едет с героиней (вложенность 3 уровня)');
  ok(W('girl', 5.75).pose === 'jump' && W('girl', 5.75).pos[1] > W('girl', 5).pos[1], 'в середине полёта поза jump и героиня выше точки отцепления');
}
ok(Number.isFinite(W('loop', 3).pos[0]), 'цикл привязок игнорируется, движок не падает');

console.log('2. Камера за объектом');
const offs = [0.3, 2.1, 4.7, 5.9].map((t) => { const c = cameraState(T, t).pos, p = W('car', t).pos; return [c[0] - p[0], c[1] - p[1], c[2] - p[2]]; });
ok(offs.every((o) => dist(o, offs[0]) < 1e-6), `смещение камеры от машины постоянно: [${offs[0].map((v) => v.toFixed(2))}]`);
const fr = followFrame(T, T.shots[0], 3), back = fr.toLocal(fr.toWorld([1.5, 2, -3]));
ok(dist(back, [1.5, 2, -3]) < 1e-9, 'перевод локальное -> мир -> локальное без потерь');

console.log('3. Петля и масштаб (через сцену three.js)');
const st = new Stage(); await st.load(T);
const edgeAt = (t) => { st.evaluate(t); st.scene.updateMatrixWorld(true); const g = st.nodes.get('span'); const b = new THREE.Box3().setFromObject(g);
  return { box: b }; };
const hingeY = [0, 4, 8].map((t) => { st.evaluate(t); st.scene.updateMatrixWorld(true); const v = new THREE.Vector3(6, 0, 0); // правая точка петли в локальных координатах узла
  const g = st.nodes.get('span'); return g.localToWorld(v.clone()).toArray(); });
ok(hingeY.every((p) => dist(p, [6, 3.2, 0]) < 1e-6), 'край у петли неподвижен: ' + JSON.stringify(hingeY[2].map((v) => +v.toFixed(3))));
const far = edgeAt(8).box.max.y; ok(far > 10, `свободный край поднялся при rot[0] = −38°: верх пролёта ${far.toFixed(2)} м`);
const sq = { ...T, objects: [{ id: 'c', type: 'car', size: [1.8, 1.45, 4.3], keys: [{ t: 0, pos: [0, 4, 0] }, { t: 1, pos: [0, 4, 0], scale: [1, 1.15, 0.55] }] }] };
const st2 = new Stage(); await st2.load(sq); st2.evaluate(1); st2.scene.updateMatrixWorld(true);
const bb = new THREE.Box3().setFromObject(st2.nodes.get('c'));
ok(Math.abs(bb.min.y - 4) < 0.01 && bb.max.z - bb.min.z < 4.3 * 0.6, `сплющенная машина стоит на дороге: низ ${bb.min.y.toFixed(3)} м, длина ${(bb.max.z - bb.min.z).toFixed(2)} м`);

console.log('4. Детерминизм');
const seq = [7.3, 1.2, 9.9, 7.3, 0, 7.3].map((t) => JSON.stringify(W('girl', t)) + JSON.stringify(cameraState(T, t).pos));
ok(seq[0] === seq[3] && seq[0] === seq[5], 'одно и то же t даёт один и тот же результат в любом порядке');
st.evaluate(9.9); const a1 = st.nodes.get('girl').userData.limbs.L.kn.rotation.x; st.evaluate(1); st.evaluate(9.9);
ok(a1 === st.nodes.get('girl').userData.limbs.L.kn.rotation.x, 'поза манекена не зависит от предыдущих кадров');

// --- необязательно: та же проверка скачков на настоящей сцене ---
const file = process.argv[2];
if (file) {
  const P = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('5. Сцена ' + (P.name || file));
  const cuts = P.shots.map((s) => s.from);   // на склейке скачок не виден: внутри плана — проверяем
  for (const o of P.objects) for (const a of attachments(o, P)) for (const edge of [a.from, a.to]) {
    if (edge <= 0 || edge >= P.duration) continue;
    if (cuts.some((c) => Math.abs(c - edge) < 1e-6)) { console.log(`  · ${o.name || o.id} @ ${edge} с — на склейке, пропуск`); continue; }
    const r = jumpCheck((t) => worldTransform(o, t, P).pos, edge);
    ok(r.ok, `${o.name || o.id} @ ${edge} с: шаги ${r.s1.toFixed(3)} / ${r.s2.toFixed(3)} м, допуск ${r.lim.toFixed(3)} м`);
  }
}
console.log(fails ? `\nНЕ ПРОШЛО: ${fails}` : '\nВсе проверки прошли');
process.exit(fails ? 1 : 0);
