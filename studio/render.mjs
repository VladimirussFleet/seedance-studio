// Рендер проекта без окна — для агента (посмотреть кадры, собрать раскадровку или MP4 из терминала).
// Нужен установленный Google Chrome (или CHROME_PATH). Сервер студии запускать не нужно: render.mjs поднимает свой.
//
//   node render.mjs --p="Имя сцены" --sheet                  раскадровка (2 кадра на план, с подписями) -> renders/sheet.png
//   node render.mjs --p="Имя сцены" --stills=0.5,3.2 [--labels]  отдельные кадры -> renders/still_*.jpg
//   node render.mjs --p="Имя сцены" --video [--labels] [--from=0 --to=6]   MP4 -> renders/
//   --projects=/путь  папка с проектами (по умолчанию ./projects)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(0, i).replace(/^--/, ''), a.slice(i + 1)]; }));
const APP = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS = path.resolve(args.projects || process.env.STUDIO_PROJECTS || path.join(process.cwd(), 'projects'));
const name = args.p; if (!name) { console.log('Укажи проект: --p="Имя сцены"'); process.exit(1); }
const PDIR = path.join(PROJECTS, name); if (!fs.existsSync(path.join(PDIR, 'project.json'))) { console.log('Нет проекта', PDIR); process.exit(1); }
const OUT = path.join(PDIR, 'renders'); fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.glb': 'model/gltf-binary', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
  let f;
  if (p === '/api/project') { const pf = path.join(PROJECTS, u.searchParams.get('name'), 'project.json'); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: JSON.parse(fs.readFileSync(pf, 'utf8')) })); }
  if (p.startsWith('/p/')) f = path.join(PROJECTS, p.slice(3)); else f = path.join(APP, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const CANDIDATES = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const executablePath = CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) { console.log('Не найден Google Chrome. Установи его или укажи CHROME_PATH.'); process.exit(1); }
const gpu = process.platform === 'darwin' ? ['--use-angle=metal'] : process.platform === 'win32' ? ['--use-angle=d3d11'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await puppeteer.launch({ headless: true, executablePath, args: ['--hide-scrollbars', '--force-color-profile=srgb', '--enable-gpu', '--ignore-gpu-blocklist', ...gpu] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[ошибка в сцене]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/render.html?p=${encodeURIComponent(name)}`);
await page.waitForFunction('window.__ready === true', { timeout: 60000 });
const info = await page.evaluate('window.info');
const grab = async (t, l) => Buffer.from(await page.evaluate((tt, ll) => window.frameJPEG(tt, ll), t, !!l), 'base64');
console.log(`${name}: ${info.w}x${info.h}, ${info.fps} fps, ${info.duration} с, планов: ${info.shots.length}`);

if (args.sheet) {
  const tmp = path.join(OUT, '.sheet'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
  const times = info.shots.flatMap(([a, b]) => [a + (b - a) * 0.08, a + (b - a) * 0.92]);
  for (let i = 0; i < times.length; i++) fs.writeFileSync(path.join(tmp, `${String(i).padStart(3, '0')}.jpg`), await grab(times[i], true));
  const cols = info.w >= info.h ? 2 : 4, rows = Math.ceil(times.length / cols), cw = info.w >= info.h ? 960 : 360;
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-framerate', '1', '-i', path.join(tmp, '%03d.jpg'), '-vf', `scale=${cw}:-2,tile=${cols}x${rows}:padding=6:color=0x111111`, '-frames:v', '1', path.join(OUT, 'sheet.png')], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status === 0) console.log('раскадровка ->', path.join(OUT, 'sheet.png'));
} else if (args.stills) {
  for (const s of String(args.stills).split(',')) { const f = path.join(OUT, `still_${(+s).toFixed(2)}.jpg`); fs.writeFileSync(f, await grab(+s, args.labels)); console.log('кадр ->', f); }
} else if (args.video) {
  const F = info.fps, from = +(args.from || 0), to = +(args.to || info.duration), n = Math.round((to - from) * F);
  const file = args.out ? path.resolve(args.out) : path.join(OUT, `${args.labels ? 'review' : 'animatic'}_cli.mp4`);
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(F), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let i = 0; i < n; i++) { const b = await grab(from + i / F, args.labels); if (!ff.stdin.write(b)) await new Promise((r) => ff.stdin.once('drain', r)); if (i && i % (F * 2) === 0) console.log(`${i}/${n}`); }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r));
  console.log(`видео -> ${file} (${n} кадров, ${((Date.now() - t0) / 1000).toFixed(0)} с)`);
} else console.log('Режим: --sheet, --stills=1,2 или --video');
await browser.close(); server.close();
