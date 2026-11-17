// Поиск точки камеры, откуда герой виден весь отрезок времени (лучи three.js по реальной геометрии сцены).
//   node tests/viewsearch.mjs project.json <id героя> <от> <до> [x0,x1,y0,y1,z0,z1,шаг]
import fs from 'node:fs'; import * as THREE from 'three'; import { Stage, worldTransform } from '../engine.js';
const [file, id, a, b, box] = process.argv.slice(2);
const P = JSON.parse(fs.readFileSync(file, 'utf8')); const st = new Stage(); await st.load(P);
st.scene.traverse((m) => { if (m.material) m.material.side = THREE.DoubleSide; });   // камера внутри объекта тоже «упирается» в грань
const [x0, x1, y0, y1, z0, z1, step] = (box || '-30,30,1.5,14,-15,30,1.5').split(',').map(Number);
const hero = P.objects.find((o) => o.id === id), ray = new THREE.Raycaster();
const times = []; for (let t = +a; t <= +b + 1e-6; t += 0.1) times.push(t);
const scenes = times.map((t) => { st.evaluate(t); st.scene.updateMatrixWorld(true);
  const meshes = []; for (const [oid, n] of st.nodes) n.traverse((c) => c.isMesh && meshes.push({ m: c.clone(), oid }));
  meshes.forEach((x) => x.m.matrixWorld.copy(x.m.matrixWorld)); 
  const W = worldTransform(hero, t, P); return { t, p: new THREE.Vector3(W.pos[0], W.pos[1] + 0.8, W.pos[2]), meshes: [] }; });
// снимок мешей на каждый момент: пересобираем сцену на t и бросаем лучи сразу
const res = [];
for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) for (let z = z0; z <= z1; z += step) res.push({ c: new THREE.Vector3(x, y, z), vis: 0, dsum: 0 });
for (const S of scenes) {
  st.evaluate(S.t); st.scene.updateMatrixWorld(true);
  const objs = [...st.nodes.values()];
  for (const r of res) {
    const dir = S.p.clone().sub(r.c), d = dir.length(); ray.set(r.c, dir.normalize()); ray.far = d;
    const h = ray.intersectObjects(objs, true).find((x) => x.object.userData.ownerId !== id && x.object.userData.ownerId !== 'case');
    if (!h) { r.vis++; r.dsum += d; }
    // камера внутри объекта — штраф
  }
}
const N = scenes.length; const ok = res.filter((r) => r.vis > 0).map((r) => ({ ...r, d: r.dsum / r.vis }));
ok.sort((p, q) => q.vis - p.vis || Math.abs(p.d - 16) - Math.abs(q.d - 16));
console.log(`моментов: ${N}; лучшие точки (видно / всего):`);
for (const r of ok.slice(0, 20)) console.log(r.c.toArray().map((v) => v.toFixed(1)).join(', '), `${r.vis}/${N}`, 'ср. дистанция', r.d.toFixed(1));
