# Hermes Agent UI

Extensión nativa de **VS Code / Antigravity** que envuelve **Hermes Agent** con una
interfaz de chat propia. Envuelve **[Hermes Agent](https://hermes-agent.nousresearch.com/)**
aplicando el sistema de diseño "Movimiento Funcional"
(turquesa `#00BEC8`, fuente ABeeZee).

## Cómo funciona

La extensión lanza `hermes acp` y se comunica con el agente por **ACP**
(Agent Client Protocol = JSON-RPC sobre stdio). El streaming de la respuesta, el
razonamiento, las llamadas a herramientas y los comandos slash se renderizan en un
*webview* propio en la barra lateral (Activity Bar).

No inyecta API key ni modelo: usa la sesión y el modelo por defecto que ya tengas
configurados en tu instalación de Hermes (`hermes model`). Opcionalmente puedes
forzar un modelo concreto en los ajustes de la extensión.

```
webview (VS Code)  ⇄  postMessage  ⇄  extensión  ⇄  stdio  ⇄  hermes acp
```

## Requisitos

- **Hermes Agent** instalado y funcionando. Verifícalo con `hermes acp --check`.
  Por defecto se busca el binario en
  `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`.
- VS Code / Antigravity `>= 1.85.0`.

## Instalación

Empaqueta e instala el `.vsix`:

```powershell
pnpm install
pnpm run compile
pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository
# instala el .vsix generado en tu editor (Extensions: Install from VSIX...)
```

En **Antigravity** la instalación por CLI es:

```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity\bin\antigravity-ide.cmd" --install-extension <ruta.vsix> --force
# luego: Reload Window
```

## Uso

1. Abre el icono **"Hermes Agent"** en la barra lateral.
2. Escribe en el chat. Verás el streaming de la respuesta y el menú de comandos (`/`).
3. (Opcional) **Settings → "Hermes Agent UI" → modelo**: déjalo vacío para usar el
   modelo por defecto de Hermes, o rellénalo para forzar uno concreto.

## Configuración

| Ajuste                 | Por defecto | Descripción                                                              |
| ---------------------- | ----------- | ------------------------------------------------------------------------ |
| `hermesAgentUI.model`  | `""`        | Vacío = modelo por defecto de Hermes. Rellénalo solo para forzar uno.    |

## Desarrollo

```powershell
pnpm install
pnpm run compile   # webpack
pnpm run watch     # webpack en modo watch
pnpm run lint      # eslint
```

> La UI de esta extensión está **duplicada a propósito** con la del wrapper web
> (`../web`). Si arreglas un bug en una, replícalo en la otra. El transporte ACP
> (`src/acpClient.ts`, `src/acpTypes.ts`) es copia literal entre ambos proyectos.
