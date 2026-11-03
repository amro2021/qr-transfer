/* Builds app/www from the website: copies the pages, bundles the QR libraries (offline),
   points links at index.html files, and adds the app bridge (shim.js). */
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname), site = path.resolve(here, '..'), www = path.join(here, 'www');
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(here, 'node_modules/qrcode-generator/qrcode.js'), path.join(www, 'vendor/qrcode.js'));
fs.copyFileSync(path.join(here, 'node_modules/jsqr/dist/jsQR.js'), path.join(www, 'vendor/jsQR.js'));
fs.copyFileSync(path.join(here, 'shim.js'), path.join(www, 'shim.js'));
fs.cpSync(path.join(site, 'lib'), path.join(www, 'lib'), { recursive: true });
fs.copyFileSync(path.join(here, 'home.html'), path.join(www, 'index.html'));

const pages = [['index.html', 'transfer'], ['multi/index.html', 'multi'], ['quiz/index.html', 'quiz'], ['chat/index.html', 'chat']];
for (const [src, dir] of pages) {
  let h = fs.readFileSync(path.join(site, src), 'utf8');
  const n = (re, to, label) => { const c = (h.match(re) || []).length; if (!c) throw new Error(`${src}: ${label} not found`); h = h.replace(re, to); };
  n(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/qrcode-generator\/[^"]+"><\/script>/g, '<script src="../vendor/qrcode.js"></script>', 'qrcode-generator tag');
  n(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/jsqr@[^"]+"><\/script>/g, '<script src="../vendor/jsQR.js"></script>\n<script src="../shim.js"></script>', 'jsQR tag');
  if (src === 'index.html') {                       // the simple page moves one folder down
    n(/<script src="lib\/qrlink\.js"><\/script>/, '<script src="../lib/qrlink.js"></script>', 'library tag');
    h = h.replace(/href="(multi|quiz|chat)\/"/g, 'href="../$1/index.html"');
  }
  h = h.replace(/href="\.\.\/"/g, 'href="../index.html"')            // "back" goes to the app's home
       .replace(/href="\.\.\/(multi|quiz|chat)\/"/g, 'href="../$1/index.html"');
  fs.mkdirSync(path.join(www, dir), { recursive: true });
  fs.writeFileSync(path.join(www, dir, 'index.html'), h);
}
console.log('www ready:', fs.readdirSync(www).join(', '));
