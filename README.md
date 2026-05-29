# Hermes Agent Wrapper

Dos interfaces de chat propias para **[Hermes Agent](https://hermes-agent.nousresearch.com/)** — una como **extensión de
VS Code / Antigravity** y otra como **aplicación web local** — que envuelven el
agente con una UI cuidada (sistema de diseño "Movimiento Funcional", turquesa
`#00BEC8`).

Ambas hablan con Hermes por **ACP** (Agent Client Protocol = JSON-RPC sobre stdio),
así que **no contienen ni necesitan tu API key**: usan la sesión y el modelo que ya
tengas configurados en tu propia instalación de Hermes.

> ⚠️ **Requiere Hermes Agent instalado por separado.** Este repositorio solo contiene
> los *wrappers* de interfaz; no incluye el agente. Instala Hermes según su
> documentación y verifica la integración con `hermes acp --check`.

## Las dos modalidades

| | [`vscode-extension/`](vscode-extension/) | [`web/`](web/) |
| --- | --- | --- |
| **Dónde corre** | Dentro de VS Code / Antigravity | En el navegador (`http://127.0.0.1:4790`) |
| **Transporte** | webview ⇄ extensión ⇄ stdio | navegador ⇄ WebSocket ⇄ servidor Node ⇄ stdio |
| **Cuándo usarla** | Si trabajas dentro del editor | Si quieres la UI fuera del editor |

Comparten la **misma UI** y el **mismo transporte ACP** (duplicados a propósito;
ver la nota de paridad más abajo).

## Inicio rápido

### Web

```powershell
cd web
pnpm install
pnpm start          # compila y arranca el servidor
# abre http://127.0.0.1:4790
```

### Extensión

```powershell
cd vscode-extension
pnpm install
pnpm run compile
pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository
# instala el .vsix en tu editor
```

Cada subcarpeta tiene su propio `README.md` con el detalle.

## Seguridad

- La versión web escucha **solo en `127.0.0.1`** (loopback). Hermes en ACP tiene
  acceso **total** a ficheros y terminal: exponerlo a la red equivale a ejecución
  remota de código. **No bindear a `0.0.0.0`** sin diseñar antes autenticación fuerte.
- En el *upgrade* del WebSocket se validan `Origin` y `Host` (anti DNS-rebinding /
  CSRF de WebSocket).
- Las API keys viven en la instalación de Hermes (su propio `.env`), **fuera de este
  repositorio**. Nunca se commitean.

## Multiplataforma

- **Windows / macOS / Linux.** El cierre de procesos es multiplataforma: en Windows
  se mata el árbol con `taskkill /t`; en macOS/Linux se lanza Hermes como líder de
  su propio grupo de procesos y se termina el grupo entero (`SIGTERM`, con `SIGKILL`
  de respaldo), de modo que no quedan subprocesos huérfanos.
- En macOS/Linux apunta la variable `HERMES_EXE` al binario de `hermes` (las rutas
  por defecto asumen la instalación estándar en Windows).
- La UI (`web/public/` y el webview de la extensión) y el transporte ACP
  (`acpClient.ts`, `acpTypes.ts`) están **duplicados a propósito** entre las dos
  carpetas. Si arreglas un bug en una, **replícalo en la otra**.

## Licencia

[MIT](LICENSE) © 2026 Movimiento Funcional (Elena Cruces).

Hermes Agent es un proyecto de terceros con su propia licencia; este repositorio no
lo redistribuye.
