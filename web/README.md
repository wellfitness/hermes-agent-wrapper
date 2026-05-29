# Hermes Web

Wrapper **web (localhost)** para [Hermes Agent](https://hermes-agent.nousresearch.com/). Sirve en el navegador la misma interfaz de chat de la extensión de VS Code/Antigravity ("Hermes Agent UI"), con el branding de Movimiento Funcional.

Es un proyecto **independiente** de la extensión: tiene su propia copia de la UI. Comparte el mismo transporte ACP (`acpClient.ts`) y la misma lógica de traducción de eventos, pero el medio cambia: en vez de hablar con el webview de VS Code por `postMessage`, un pequeño servidor Node hace de puente entre el navegador (WebSocket) y `hermes acp` (stdio).

```
navegador  ⇄  WebSocket  ⇄  servidor Node (localhost)  ⇄  stdio  ⇄  hermes acp
```

## Requisitos

- Node.js 18+ y `pnpm`.
- Hermes Agent instalado. Por defecto se busca en
  `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`
  (la misma ruta que usa la extensión). Se puede sobrescribir con `HERMES_EXE`.

## Uso

```powershell
pnpm install
pnpm start          # compila (tsc) y arranca el servidor
```

Luego abre **http://127.0.0.1:4790** en el navegador.

### Variables de entorno

| Variable           | Por defecto                         | Descripción                                                        |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| `HERMES_WEB_PORT`  | `4790`                              | Puerto del servidor local.                                         |
| `HERMES_WEB_CWD`   | directorio actual (`process.cwd()`) | Carpeta de trabajo sobre la que opera Hermes (lee/escribe ficheros).|
| `HERMES_EXE`       | ruta estándar en Windows            | Ruta absoluta al ejecutable `hermes`.                              |

Ejemplo, trabajando sobre un proyecto concreto en otro puerto:

```powershell
$env:HERMES_WEB_CWD = "D:\Recursos para IA\.hermes"
$env:HERMES_WEB_PORT = "5000"
pnpm start
```

## Seguridad

- El servidor escucha **solo en `127.0.0.1`** (loopback). Hermes puede leer/escribir
  archivos y ejecutar comandos, así que **no se expone a la red ni a internet**.
- En el *upgrade* del WebSocket se validan `Origin` y `Host` para impedir que una
  web abierta en otra pestaña pilote a Hermes (DNS-rebinding / CSRF de WebSocket).
- Cada pestaña abre su propio subproceso `hermes acp`; al cerrarla, el subproceso
  se termina.

## Estructura

```
hermes-web/
├── src/
│   ├── server.ts        Servidor HTTP (estáticos) + WebSocket (127.0.0.1)
│   ├── session.ts       Puente ACP ⇄ UI por conexión (port de wireHermesAgent)
│   ├── acpClient.ts     Transporte ACP por stdio (copia de la extensión)
│   └── resolveHermes.ts Localiza el binario de Hermes
└── public/
    ├── index.html       Markup del chat
    ├── styles.css        Estilos (idénticos a la extensión)
    ├── app.js            Lógica de UI + shim WebSocket (emula vscode.postMessage)
    └── hermes-icon-128.png
```

## Relación con la extensión

La UI (`public/`) es una **copia** de la que vive embebida en
`hermes-vscode-extension/src/extension.ts` (`getWebviewContent`). Si se mejora el
chat en un sitio, conviene replicar el cambio en el otro. El transporte
(`acpClient.ts`) y la lógica de eventos (`session.ts` ↔ `wireHermesAgent`) están
deliberadamente alineados para minimizar la divergencia.
