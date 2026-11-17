// Локальное хранилище: сервер server.mjs на этом компьютере (проекты в папке, запись через ffmpeg).
const api = (u, o) => fetch(u, o).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; });

export function localBackend() {
  let cur = null, lastMtime = 0;
  return {
    kind: 'local',
    label: 'проекты в папке на компьютере',
    async list() { return (await api('/api/projects')).map((p) => ({ id: p.name, name: p.name })); },
    async load(id) { const r = await api(`/api/project?name=${encodeURIComponent(id)}`); cur = id; lastMtime = r.mtime; return r.data; },
    async save(id, data) { const r = await api(`/api/project?name=${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }); lastMtime = r.mtime; },
    async create(name, data) {
      await api(`/api/project?name=${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(data) });
      const list = await this.list(); return (list.find((p) => p.name === name) || list.find((p) => p.name.startsWith(name.slice(0, 20))) || list[0]).id;
    },
    // если project.json поменял агент — сообщаем редактору
    watch(id, onRemote) {
      const t = setInterval(async () => {
        try { const { mtime } = await api(`/api/mtime?name=${encodeURIComponent(id)}`); if (mtime > lastMtime + 1) { const d = await this.load(id); onRemote(d); } } catch {}
      }, 2000);
      return () => clearInterval(t);
    },
    async upload(file) { const r = await api(`/api/asset?name=${encodeURIComponent(cur)}&file=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }); return r.path; },
    assetURL(ref) { return `/p/${encodeURIComponent(cur)}/${ref}`; },
    fetchGLB: null,
    async recorder({ fps, labels }) {
      const info = await api('/api/info'); if (!info.ffmpeg) throw new Error('Для записи нужен ffmpeg: brew install ffmpeg');
      const { id } = await api(`/api/record/start?name=${encodeURIComponent(cur)}&fps=${fps}&labels=${labels ? 1 : 0}`, { method: 'POST' });
      return {
        async add(canvas) { const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.93)); await api(`/api/record/frame?id=${id}`, { method: 'POST', body: blob }); },
        async end() { const r = await api(`/api/record/end?id=${id}`, { method: 'POST' }); return { url: r.url, where: r.file, filename: r.url.split('/').pop() }; },
      };
    },
    // скачивание: обычная ссылка
    async download(res) { const a = document.createElement('a'); a.href = res.url; a.download = res.filename; document.body.appendChild(a); a.click(); a.remove(); },
    ai: null,   // локально «по фото» собирает агент в Claude Code
  };
}
