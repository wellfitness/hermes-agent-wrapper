# CLAUDE.md — Hermes Web

Instrucciones para Claude Code al trabajar en este proyecto. **Comunicación siempre en castellano** (excepciones: términos técnicos e identificadores de código).

---

## Qué es

Wrapper **web (localhost)** de **Hermes Agent**. Sirve en el navegador la misma interfaz de chat de la extensión `hermes-vscode-extension` (hermana, en `../hermes-vscode-extension`), hablando **ACP** (Agent Client Protocol = JSON-RPC 2.0 NDJSON sobre stdio) con `hermes acp`.

Es un proyecto **independiente con copia propia de la UI** (decisión deliberada de Elena: NO monorepo, para no tocar la extensión que ya funciona). Idea rectora: **"cambiar el transporte, no la lógica"**.

```
navegador  ⇄  WebSocket  ⇄  servidor Node (127.0.0.1)  ⇄  stdio  ⇄  hermes acp
```

Un navegador no puede lanzar `hermes.exe` ni hablar stdio (sandbox); por eso hace falta el servidor Node local que hace de puente.

---

## Arquitectura

| Archivo | Responsabilidad |
| --- | --- |
| `src/server.ts` | Servidor `http` nativo (estáticos de `public/`) + `ws`. Bindea **solo a 127.0.0.1**. Valida `Origin`/`Host` en el `upgrade`. 1 conexión WS = 1 subproceso `hermes acp`. |
| `src/session.ts` | Puente ACP ⇄ UI por conexión. Port de `wireHermesAgent` de la extensión: traduce eventos ACP → `emit(type,payload)` por WS, y comandos de UI → llamadas ACP. |
| `src/acpClient.ts` | Transporte ACP por stdio (`spawn hermes acp` + readline + JSON-RPC). **Copia literal del de la extensión.** |
| `src/resolveHermes.ts` | Localiza `hermes.exe` (override por env `HERMES_EXE`). |
| `public/index.html` · `styles.css` · `app.js` | **Copia de la UI** de la extensión. `app.js` usa un *shim* que emula `vscode.postMessage` sobre WebSocket y reinyecta los mensajes entrantes como eventos `'message'` del window, de modo que el resto del JS sea idéntico al de la extensión. |

**Contrato de eventos (no romper):** los mensajes backend → UI tienen SIEMPRE la forma `{ jsonrpc:'2.0', method:'event', params:{ type, payload } }`. La UI los consume en el `switch(type)` de `app.js`. Cambiar esa forma rompe la UI.

---

## Comandos

```powershell
pnpm install          # instalar dependencias
pnpm start            # compila (tsc) y arranca el servidor (prestart -> build)
pnpm run build        # solo compilar TypeScript a dist/
pnpm run watch        # tsc en modo watch
pnpm run serve        # arrancar sin recompilar (node dist/server.js)
```

Abrir **http://127.0.0.1:4790**. Variables de entorno: `HERMES_WEB_PORT` (4790), `HERMES_WEB_CWD` (cwd de trabajo de Hermes), `HERMES_EXE` (ruta al binario), `HERMES_WEB_OPEN=1` (el servidor abre el navegador al arrancar; lo usa el lanzador).

### Lanzador de doble clic

`launch.ps1` + acceso directo `Hermes Web.lnk` en el Escritorio permiten abrir todo sin terminal: al pulsarlo, si ya hay servidor solo abre el navegador; si no, muestra un diálogo para elegir la carpeta de trabajo de Hermes y arranca (`pnpm start` con `HERMES_WEB_OPEN=1`). La ventana de PowerShell que queda abierta ES el servidor; cerrarla lo detiene. El acceso directo invoca `powershell.exe -ExecutionPolicy Bypass -STA -File launch.ps1` con `hermes-web.ico` como icono. Recrear el acceso directo: ver el bloque de PowerShell del historial (genera `.ico` desde `public/hermes-icon-128.png` con `System.Drawing` y crea el `.lnk` con `WScript.Shell`).

---

## Convenciones

- **`pnpm` siempre, nunca `npm`.**
- **0 errores TypeScript**, `strict: true`, **prohibido `any`**.
- **Castellano** en UI, mensajes y comentarios de dominio (con ñ y tildes). Excepciones: términos técnicos.
- **YAGNI** / empezar por versión mínima funcional, no arquitecturas ambiciosas.
- No `git push` ni `git commit --no-verify` sin permiso explícito.
- Una sola dependencia de runtime: `ws`. Pensarlo dos veces antes de añadir más.

---

## Relación con la extensión — PARIDAD (importante)

La UI y el transporte están **duplicados a propósito** entre este proyecto y `../hermes-vscode-extension`. Riesgo principal: que diverjan con el tiempo. Reglas:

- Si arreglas un bug en la UI (`public/app.js`), **replícalo** en el `<script>` de `getWebviewContent` de `extension.ts`, y viceversa.
- `src/acpClient.ts` es copia literal del de la extensión: un fix aquí debe replicarse allá.
- `session.ts` ≈ `wireHermesAgent`: misma lógica de traducción de eventos.
- Diferencias **correctas y deliberadas** (no "arreglar"): el shim WebSocket vs `acquireVsCodeApi`; `addEventListener('submit')` aquí vs `onsubmit` inline en la extensión; "Recarga la página" vs "Vuelve a abrir el panel"; `emit('error')` vs `vscode.window.showErrorMessage`; fallback de modelo `'Hermes'` vs `model`.

---

## Seguridad (no negociable)

- **SOLO localhost** (`127.0.0.1`). Hermes en ACP tiene acceso TOTAL a archivos y terminal: exponerlo a la red equivale a RCE remoto. No bindear a `0.0.0.0` ni añadir acceso de red sin diseñar antes autenticación fuerte.
- Mantener la validación de `Origin`/`Host` en el `upgrade` del WebSocket (anti DNS-rebinding / CSRF de WebSocket).
- `spawn` se usa con array de args (sin shell): no introducir interpolación de strings en comandos.
- Nunca commitear `.env`, API keys ni tokens (ya excluidos en `.gitignore`).

---

## Auditoría 2026-05-29 — aplicada

Los hallazgos de la auditoría (security-super-agent + typescript-eslint-fixer +
project-aware-code-reviewer) se corrigieron en AMBOS proyectos. Resumen:

1. **[RESUELTO] XSS por `innerHTML`**: se escapa con `escapeHtml()`/`textContent` el nombre de herramienta (tarjeta de aprobación), el mensaje de error (ahora `textContent`), `setStatus`, y los menús de comandos/modelos.
2. **[RESUELTO] Procesos huérfanos en Windows**: `acpClient.dispose()` usa `taskkill /pid <pid> /t /f` para matar el árbol completo (el `python.exe` hijo).
3. **[RESUELTO] Reconexión del WebSocket**: el shim de `app.js` reconecta con backoff y emite `transport.down`/`transport.up`, distinguidos de `subprocess.closed` (crash real). La conversación del DOM se conserva.
4. **[RESUELTO] Doble `message.complete`**: flag `cancelled` en `session.ts` y `wireHermesAgent`.
5. **[RESUELTO] Timeout en peticiones de control**: `initialize`/`session/new` (60 s) y `set_model` (30 s). `session/prompt` sin timeout (se cancela a mano).
6. **[RESUELTO] DoS local**: `MAX_CONNECTIONS` y `maxPayload` en `server.ts`.
7. **[RESUELTO] `Origin` fail-safe**: rechaza si falta `Origin`/`Host` o no están en whitelist.
8. **[RESUELTO] Path traversal**: comparación con `PUBLIC_DIR + path.sep`.
9. **[RESUELTO] Tipos ACP**: centralizados en `acpTypes.ts` (idéntico en ambos proyectos); se eliminaron las aserciones `as` dispersas.
10. **[RESUELTO] ESLint**: flat config con `@typescript-eslint` y `no-explicit-any`. `pnpm run lint` pasa limpio.
11. **[RESUELTO] Código muerto**: eliminados `gateway.ready`/`gatewayReady`, `id==='init_session'`, `clarify/sudo/secret`.
12. **[RESUELTO] CSP del webview** (extensión): CSP con nonce para `script-src`; `onsubmit` inline migrado a `addEventListener`; config `apiKey` muerta eliminada del manifest.

Diagnóstico de arranque: `acpClient.recentStderr()` se incluye en el mensaje de error si Hermes no arranca, para ver el motivo real (venv roto, falta de credenciales, etc.).

---

## Verificación end-to-end

1. `pnpm install` && `pnpm run build` (0 errores TS).
2. `pnpm start`, abrir `http://127.0.0.1:4790`. El badge debe pasar de "Iniciando..." al modelo (p. ej. MiniMax-M2.7-highspeed).
3. Probar: enviar un prompt corto y ver streaming; abrir el menú de Comandos (`/`); cambiar de modelo; aprobar/denegar una acción; botón Detener.
4. Confirmar que el servidor escucha solo en `127.0.0.1` y que un WebSocket con `Origin` ajeno es rechazado.
