// Seedance Studio — локальный сервер. Отдаёт редактор, хранит проекты на диске и собирает запись в MP4 через ffmpeg.
//   node server.mjs [--projects=/путь/к/папке] [--port=5178] [--no-open]
// Проекты лежат в папке projects/ там, откуда запущен сервер (или в --projects):
//   projects/<имя>/project.json   сцена
//   projects/<имя>/assets/         фото-референсы и GLB-модели
//   projects/<имя>/renders/        записанные ролики
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const APP = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS = path.resolve(args.projects || process.env.STUDIO_PROJECTS || path.join(process.cwd(), 'projects'));
const PORT = +(args.port || process.env.STUDIO_PORT || 5178);
fs.mkdirSync(PROJECTS, { recursive: true });
// первый запуск: кладём пример, чтобы было с чего начать
if (!fs.readdirSync(PROJECTS).some((d) => fs.existsSync(path.join(PROJECTS, d, 'project.json')))) {
  const EX = path.join(APP, 'examples');
  if (fs.existsSync(EX)) for (const d of fs.readdirSync(EX)) fs.cpSync(path.join(EX, d), path.join(PROJECTS, d), { recursive: true });
}

let FFMPEG = null; try { execSync('ffmpeg -version', { stdio: 'ignore' }); FFMPEG = 'ffmpeg'; } catch { /* нет ffmpeg: запись будет недоступна */ }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.mp4': 'video/mp4', '.css': 'text/css', '.bin': 'application/octet-stream' };
const safe = (s) => String(s || '').replace(/[\/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim().slice(0, 80) || 'scene';
const pdir = (name) => path.join(PROJECTS, safe(name));
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, bad) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', bad); });
function serveFile(res, file) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'нет файла' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}
const inside = (base, p) => { const r = path.resolve(p); return r === base || r.startsWith(base + path.sep); };

const recordings = new Map();   // id -> { ff, file, done }

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), q = Object.fromEntries(u.searchParams), p = decodeURIComponent(u.pathname);

    // ---- API проектов ----
    if (p === '/api/info') return send(res, 200, { projects: PROJECTS, ffmpeg: !!FFMPEG });
    if (p === '/api/projects') {
      const list = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(PROJECTS, d.name, 'project.json')))
        .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(PROJECTS, d.name, 'project.json')).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
      return send(res, 200, list);
    }
    if (p === '/api/project') {
      const f = path.join(pdir(q.name), 'project.json');
      if (req.method === 'GET') { if (!fs.existsSync(f)) return send(res, 404, { error: 'нет проекта' }); return send(res, 200, { mtime: fs.statSync(f).mtimeMs, data: JSON.parse(fs.readFileSync(f, 'utf8')) }); }
      if (req.method === 'PUT') {
        const data = JSON.parse((await readBody(req)).toString('utf8'));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak');              // предыдущая версия на всякий случай
        fs.writeFileSync(f, JSON.stringify(data, null, 1));
        return send(res, 200, { mtime: fs.statSync(f).mtimeMs });
      }
    }
    if (p === '/api/mtime') { const f = path.join(pdir(q.name), 'project.json'); return send(res, 200, { mtime: fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0 }); }
    if (p === '/api/asset' && req.method === 'POST') {
      const dir = path.join(pdir(q.name), 'assets'); fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(q.file || '').toLowerCase() || '.bin', base = safe(path.basename(q.file || 'file', ext)).replace(/\s+/g, '_');
      let fn = base + ext, i = 2; while (fs.existsSync(path.join(dir, fn))) fn = `${base}_${i++}${ext}`;
      fs.writeFileSync(path.join(dir, fn), await readBody(req));
      return send(res, 200, { path: 'assets/' + fn });
    }

    // ---- запись: кадры JPEG -> ffmpeg -> MP4 ----
    if (p === '/api/record/start' && req.method === 'POST') {
      if (!FFMPEG) return send(res, 500, { error: 'ffmpeg не найден. Установи: brew install ffmpeg' });
      const dir = path.join(pdir(q.name), 'renders'); fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const file = path.join(dir, `${q.labels === '1' ? 'review' : 'animatic'}_${stamp}.mp4`);
      const ff = spawn(FFMPEG, ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(+q.fps || 24), '-c:v', 'mjpeg', '-i', '-',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', file], { stdio: ['pipe', 'ignore', 'inherit'] });
      const id = Math.random().toString(36).slice(2);
      const rec = { ff, file, done: new Promise((r) => ff.on('close', r)) }; recordings.set(id, rec);
      ff.stdin.on('error', () => {});
      return send(res, 200, { id });
    }
    if (p === '/api/record/frame' && req.method === 'POST') {
      const rec = recordings.get(q.id); if (!rec) return send(res, 404, { error: 'нет записи' });
      const buf = await readBody(req);
      if (!rec.ff.stdin.write(buf)) await new Promise((r) => rec.ff.stdin.once('drain', r));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/record/end' && req.method === 'POST') {
      const rec = recordings.get(q.id); if (!rec) return send(res, 404, { error: 'нет записи' });
      rec.ff.stdin.end(); const code = await rec.done; recordings.delete(q.id);
      if (code !== 0) return send(res, 500, { error: 'ffmpeg завершился с ошибкой' });
      return send(res, 200, { file: rec.file, url: '/p/' + encodeURIComponent(path.basename(path.dirname(path.dirname(rec.file)))) + '/renders/' + encodeURIComponent(path.basename(rec.file)) });
    }

    // ---- файлы проектов ----
    if (p.startsWith('/p/')) { const f = path.join(PROJECTS, p.slice(3)); if (!inside(PROJECTS, f)) return send(res, 403, {}); return serveFile(res, f); }

    // ---- сам редактор ----
    const f = path.join(APP, p === '/' ? 'index.html' : p);
    if (!inside(APP, f)) return send(res, 403, {});
    return serveFile(res, f);
  } catch (e) { console.error(e); send(res, 500, { error: String(e.message || e) }); }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Seedance Studio: ${url}\nПроекты: ${PROJECTS}${FFMPEG ? '' : '\nВНИМАНИЕ: ffmpeg не найден, запись видео не будет работать (brew install ffmpeg)'}`);
  if (!args['no-open']) { try { spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref(); } catch {} }
});
