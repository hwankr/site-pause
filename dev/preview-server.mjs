import http from 'node:http';
import {watch} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dev = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(dev, '..', 'outputs', 'site-pause');
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const clients = new Set();
const mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/vnd.microsoft.icon'};
const pages = new Set(['/options.html', '/popup.html', '/usage.html', '/blocked.html']);
const previewFiles = new Map([
  ['/', 'preview.html'], ['/__preview/adapter.js', 'preview-adapter.js'],
  ['/__preview/reload.js', 'preview-reload.js']
]);
const previewFavicons = new Map([
  ['youtube.com', 'youtube.png'], ['music.youtube.com', 'youtube-music.png'],
  ['github.com', 'github.ico'], ['instagram.com', 'instagram.png'], ['x.com', 'x.png'],
  ['notion.so', 'notion.ico'], ['notion.com', 'notion.ico']
]);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const {pathname} = url;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405); response.end('Method not allowed'); return;
  }
  if (pathname === '/__preview/events') {
    response.writeHead(200, {'Content-Type': 'text/event-stream', Connection: 'keep-alive'});
    response.write(': connected\n\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  let filename;
  if (pathname === '/_favicon/') {
    // Offline demo assets only; never proxy browsing history or arbitrary URLs.
    try {
      const page = new URL(url.searchParams.get('pageUrl'));
      const host = page.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
      const icon = previewFavicons.get(host);
      if (['http:', 'https:'].includes(page.protocol) && icon) filename = path.join(dev, 'favicons', icon);
    } catch {}
  } else if (previewFiles.has(pathname)) filename = path.join(dev, previewFiles.get(pathname));
  else if (pages.has(pathname) || /^\/[a-z][a-z0-9-]*\.(?:js|css)$/.test(pathname) ||
    /^\/icons\/(?:16|32|48|128)\.png$/.test(pathname)) filename = path.join(extension, pathname.slice(1));
  if (!filename) { response.writeHead(404); response.end('Not found'); return; }
  try {
    let body = await readFile(filename);
    if (pages.has(pathname)) {
      // Only HTTP responses receive the adapter. Packaged extension files stay untouched.
      body = Buffer.from(body.toString('utf8').replace('<head>', `<head>
  <script type="module" src="/__preview/adapter.js"></script>
  <script defer src="/__preview/reload.js"></script>`));
    }
    response.writeHead(200, {'Content-Type': mime[path.extname(filename)] || 'application/octet-stream'});
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500);
    response.end(error.code === 'ENOENT' ? 'Not found' : 'Preview could not load this file');
  }
});

let refreshTimer;
const changed = (_event, filename) => {
  if (!filename || !/\.(?:html|css|js)$/.test(filename) || /\.test\.js$/.test(filename)) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const client of clients) client.write(`data: ${JSON.stringify({file: filename})}\n\n`);
  }, 180);
};
const watchers = [watch(extension, {recursive: true}, changed), watch(dev, changed)];
const heartbeat = setInterval(() => { for (const client of clients) client.write(': alive\n\n'); }, 20000);
heartbeat.unref();
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to choose another.` : error.message);
  process.exitCode = 1;
  shutdown();
});
server.listen(port, '127.0.0.1', () => console.log(`Site Pause design preview: http://127.0.0.1:${port}\nDemo data only. Source changes reload automatically. Ctrl+C to stop.`));
function shutdown() {
  clearTimeout(refreshTimer);
  clearInterval(heartbeat);
  watchers.forEach(watcher => watcher.close());
  for (const client of clients) client.end();
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
