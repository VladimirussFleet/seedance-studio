// Онлайн-хранилище: страница в Claude. Сцены — в базе страницы, фото и модели — в её файлах,
// видео кодируется прямо в браузере (WebCodecs) и отдаётся через «Скачать».
import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs';
import { AI_HERO, AI_PLACE } from './ai-prompts.js';

const use = async (name) => { try { return window.claude?.use ? await window.claude.use(name) : null; } catch { return null; } };
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const toB64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => { const bin = atob(s.trim()); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };

export async function onlineBackend() {
  const [db, assets, downloads, sample] = await Promise.all([use('db'), use('assets'), use('downloads'), use('sample')]);
  let lastRev = null;
  const mem = new Map();          // без базы (страница открыта вне Claude) — работаем в памяти
  const blobURL = (ref) => (ref?.startsWith('blob:') || ref?.startsWith('b64:') ? '/_blob/' + ref.split(':')[1] : ref);
  const imgLimits = sample ? await sample.limits().catch(() => null) : null;

  const be = {
    kind: 'online',
    label: db ? 'сцены хранятся на этой странице' : 'нет связи с базой: изменения не сохранятся',
    offline: !db,
    async list() {
      if (!db) return [...mem.entries()].map(([id, d]) => ({ id, name: d.name }));
      const snap = await db.collection('projects').get();
      return snap.docs.map((d) => ({ id: d.id, name: d.data().name || d.id, t: d.data().updatedAt || 0 })).sort((a, b) => b.t - a.t);
    },
    async load(id) {
      if (!db) return structuredClone(mem.get(id).project);
      const s = await db.doc('projects/' + id).get(); if (!s.exists) throw new Error('Сцена не найдена');
      lastRev = s.data().rev; return structuredClone(s.data().project);
    },
    async save(id, project) {
      if (!db) { mem.set(id, { name: project.name, project: structuredClone(project) }); return; }
      lastRev = Math.random().toString(36).slice(2);
      await db.doc('projects/' + id).set({ name: project.name, updatedAt: Date.now(), rev: lastRev, project });
    },
    async create(name, project) { const id = newId(); project.name = name; await this.save(id, project); return id; },
    // сцену поменял Claude из чата — подхватываем
    watch(id, onRemote) {
      if (!db) return () => {};
      return db.doc('projects/' + id).onSnapshot((s) => {
        if (!s.exists || s.metadata.hasPendingWrites) return; const d = s.data();
        if (d.rev && d.rev !== lastRev) { lastRev = d.rev; onRemote(structuredClone(d.project)); }
      }, () => {});
    },
    async upload(file) {
      if (!assets) throw new Error('Загрузка файлов недоступна: страницу может менять только владелец');
      const isModel = /\.(glb|gltf)$/i.test(file.name);
      if (!isModel) { const r = await assets.upload(file); return 'blob:' + r.id; }
      // 3D-модель: пробуем как есть, иначе кладём текстом (base64) — такие файлы хранилище точно принимает
      try { const r = await assets.upload(new Blob([file], { type: 'model/gltf-binary' })); return 'blob:' + r.id; }
      catch { const r = await assets.upload(new Blob([await toB64(file)], { type: 'text/plain' })); return 'b64:' + r.id; }
    },
    assetURL: (ref) => blobURL(ref),
    async fetchGLB(ref) {
      const r = await fetch(blobURL(ref)); if (!r.ok) throw new Error('модель не загрузилась');
      return ref.startsWith('b64:') ? fromB64(await r.text()) : await r.arrayBuffer();
    },
    async recorder({ fps, w, h }) {
      if (!('VideoEncoder' in window)) throw new Error('Этот браузер не умеет записывать видео. Открой страницу в Google Chrome.');
      const codecs = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f'];
      let cfg = null;
      for (const codec of codecs) { const c = { codec, width: w, height: h, bitrate: 8e6, framerate: fps, avc: { format: 'avc' } }; try { if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; break; } } catch {} }
      if (!cfg) throw new Error('Браузер не поддерживает H.264. Открой страницу в Google Chrome.');
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({ target, video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory' });
      let err = null;
      const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { err = e; } });
      enc.configure(cfg);
      let i = 0;
      return {
        async add(canvas) {
          if (err) throw err;
          const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
          enc.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close(); i++;
          while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 5));
        },
        async end() {
          await enc.flush(); enc.close(); if (err) throw err; muxer.finalize();
          const blob = new Blob([target.buffer], { type: 'video/mp4' });
          return { url: URL.createObjectURL(blob), blob, filename: 'animatic.mp4', where: null };
        },
      };
    },
    async download(res) {
      if (!downloads) throw new Error('Скачивание недоступно в этом окне');
      await downloads.save({ filename: res.filename, data: res.blob });
    },
    ai: sample ? {
      images: !!imgLimits?.images,
      // внешность героя по фото
      async hero(blob) { return sample.json(AI_HERO, { images: [blob] }); },
      // серый макет места + камера по фото
      async place(blob, note) { return sample.json(AI_PLACE + (note ? `\n\nКомментарий пользователя: ${note}` : ''), { images: [blob], modelTier: 'complex' }); },
    } : null,
  };
  return be;
}
