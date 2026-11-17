// Дымовая проверка редактора в безоконном Chrome:  node studio/tests/editor-smoke.mjs --projects=/папка --p="Сцена" --obj=<id> --shot=<id>
// Открывает сцену, выбирает объект и план, проверяет, что новые поля видны и меняют project.json.
import { spawn } from 'node:child_process'; import path from 'node:path'; import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)]; }));
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5199;
const srv = spawn('node', [path.join(APP, 'server.mjs'), `--projects=${args.projects}`, `--port=${PORT}`, '--no-open'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const exe = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ headless: true, executablePath: exe, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(); await page.setViewport({ width: 1500, height: 950 });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
try {
  await page.goto(`http://127.0.0.1:${PORT}/?p=${encodeURIComponent(args.p)}`);
  await page.waitForFunction('window.__studio && window.__studio.P', { timeout: 20000 });
  await page.evaluate((id) => { __studio.setTime(1); __studio.select({ kind: 'obj', id }); }, args.obj);
  const txt = await page.$eval('#right', (e) => e.innerText);
  ok(/привязки/i.test(txt) && /родитель/i.test(txt), 'панель объекта: блок «Привязки» с родителем');
  ok(/масштаб/i.test(txt), 'панель объекта: поле «Масштаб»');
  ok(await page.$('#aFl0') !== null, 'поле «Полёт перед» на месте');
  const poses = await page.$$eval('#kp0 option', (o) => o.map((x) => x.value)).catch(() => []);
  ok(poses.includes('crouch') && poses.includes('jump'), 'позы crouch и jump в списке ключей');
  // смещение привязки меняется из панели
  await page.evaluate(() => { const el = document.getElementById('aO0_2'); el.value = -1.5; el.dispatchEvent(new Event('change')); });
  await new Promise((r) => setTimeout(r, 300));
  ok(await page.evaluate((id) => __studio.P.objects.find((o) => o.id === id).attach[0].offset[2] === -1.5, args.obj), 'смещение привязки меняется из панели');
  await page.evaluate(() => __studio.undo()); await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => { document.getElementById('kScT').click(); });
  ok(await page.$('#ks0_0') !== null, 'колонка «масштаб» раскрывается по щелчку');
  await page.evaluate((id) => __studio.select({ kind: 'shot', id }), args.shot);
  const st = await page.$eval('#right', (e) => e.innerText);
  ok(/следовать за/i.test(st) && /поворачивать вместе/i.test(st), 'панель плана: «Следовать за» и галочка поворота');
  await page.evaluate(() => __studio.select(null));
  await page.evaluate(() => [...document.querySelectorAll('[data-add="boat"]')][0].click()); await new Promise((r) => setTimeout(r, 300));
  ok(await page.evaluate(() => __studio.P.objects.some((o) => o.type === 'boat' && /Катер/.test(o.name))), 'кнопка «⛵ Катер» добавляет катер');
  await page.evaluate(() => __studio.undo()); await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: path.join(args.projects, args.p, 'renders', 'editor.png') });
  ok(!errors.length, 'нет ошибок в консоли' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) { ok(false, 'исключение: ' + e.message); }
await browser.close(); srv.kill();
console.log(fails ? `НЕ ПРОШЛО: ${fails}` : 'Редактор: все проверки прошли'); process.exit(fails ? 1 : 0);
