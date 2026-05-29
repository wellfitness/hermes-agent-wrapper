import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import { wireSession } from './session';
import { resolveHermesExe } from './resolveHermes';

/**
 * Servidor local del wrapper web de Hermes.
 *
 * - Sirve la UI estática (HTML/CSS/JS) desde `public/`.
 * - Abre un WebSocket por pestaña; cada uno arranca su propio `hermes acp`.
 *
 * SEGURIDAD: escucha SOLO en 127.0.0.1 (loopback). Hermes puede leer/escribir
 * archivos y ejecutar comandos, así que NUNCA se expone a la red. Además, en el
 * "upgrade" del WebSocket se validan Origin y Host (fail-safe) para evitar que
 * una web abierta en otra pestaña (DNS-rebinding / CSRF de WebSocket) o un
 * cliente local ajeno puedan pilotar Hermes.
 */

const HOST = '127.0.0.1';
const PORT = Number(process.env.HERMES_WEB_PORT) || 4790;
// Directorio de trabajo que verá Hermes (sobre el que opera lectura/escritura
// de archivos y terminal). Por defecto, el directorio desde el que se lanza el
// servidor; se puede fijar con HERMES_WEB_CWD.
const CWD = process.env.HERMES_WEB_CWD || process.cwd();
// Tope de sesiones simultáneas (cada una = 1 subproceso hermes acp). Evita que
// un bucle de conexiones agote la memoria. Uso personal: un puñado basta.
const MAX_CONNECTIONS = 8;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Orígenes/hosts aceptados para el WebSocket (loopback en el puerto del server).
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

  // Resuelve dentro de PUBLIC_DIR y bloquea path traversal (../). Se compara con
  // el separador final para que un hermano cuyo nombre empiece por "public" no
  // pase la guarda por prefijo.
  const filePath = path.join(PUBLIC_DIR, path.normalize(relative));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// WebSocket en modo "noServer": validamos el upgrade a mano antes de aceptar.
// maxPayload acota el tamaño de cada mensaje (defensa frente a mensajes enormes).
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
let activeConnections = 0;

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  // Fail-safe: rechaza si falta Origin/Host o no están en la whitelist.
  if (!origin || !ALLOWED_ORIGINS.has(origin) || !host || !ALLOWED_HOSTS.has(host)) {
    socket.destroy();
    return;
  }
  if (activeConnections >= MAX_CONNECTIONS) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  activeConnections++;
  ws.on('close', () => { activeConnections--; });
  wireSession(ws, resolveHermesExe(), CWD);
});

/** Abre una URL en el navegador por defecto del sistema (best-effort). */
function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // 'start' es interno de cmd; el primer "" es el título de la ventana.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Si falla, el usuario abre la URL a mano; no es crítico.
  }
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  Hermes Web escuchando en  ${url}`);
  console.log(`  Directorio de trabajo:    ${CWD}\n`);
  // Lo activa el lanzador (launch.ps1). En otros usos no se abre el navegador.
  if (process.env.HERMES_WEB_OPEN === '1') {
    openBrowser(url);
  }
});
