// камера внутри объекта? рывки внутри плана? (по всем 360 кадрам)
import fs from 'node:fs'; import * as THREE from 'three';
import { Stage, cameraState, shotAt } from '../engine.js';
const P = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); const st = new Stage(); await st.load(P);
const F = P.format.fps, N = Math.round(P.duration * F); let prev = null, inside = [], jumps = [];
const ray = new THREE.Raycaster();
for (let i = 0; i < N; i++) {
  const t = i / F; st.evaluate(t); st.scene.updateMatrixWorld(true);
  const c = cameraState(P, t), p = new THREE.Vector3(...c.pos);
  // внутри меша: луч вверх пересекает нечётное число граней одного объекта
  for (const [id, n] of st.nodes) {
    if (!new THREE.Box3().setFromObject(n).expandByScalar(0.05).containsPoint(p)) continue;
    ray.set(p, new THREE.Vector3(0.123, 1, 0.071).normalize()); const hits = ray.intersectObject(n, true);
    if (hits.length % 2 === 1) inside.push(`${t.toFixed(2)}s ${P.objects.find((o) => o.id === id).name}`);
  }
  const s = shotAt(P, t);
  if (prev && prev.s === s.id) prev.d.push(p.distanceTo(prev.p));
  if (!prev || prev.s !== s.id) { if (prev) jumps.push(prev); prev = { s: s.id, d: [], p }; } else prev.p = p;
}
jumps.push(prev);
console.log('камера внутри объекта:', inside.length ? inside.join(', ') : 'нигде');
for (const j of jumps) { const d = j.d, mx = Math.max(...d), med = d.slice().sort((a, b) => a - b)[d.length >> 1];
  let worst = 0; for (let i = 1; i < d.length; i++) worst = Math.max(worst, Math.abs(d[i] - d[i - 1])); 
  console.log(`план ${j.s}: шаг камеры за кадр медиана ${med.toFixed(3)} м, макс ${mx.toFixed(3)} м, макс. изменение шага ${worst.toFixed(3)} м`); }
