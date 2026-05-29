import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AcpClient } from './acpClient';
import type { AcpModel, AcpModelState, AcpPermissionOption } from './acpTypes';

export function activate(context: vscode.ExtensionContext) {
  console.log('Hermes Agent UI is now active!');

  // Vista webview anclada en la barra lateral (icono en la Activity Bar)
  const provider = new HermesViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(HermesViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Comando: abre el agente en un panel grande del area del editor (columna 2)
  const disposable = vscode.commands.registerCommand('hermesAgentUI.start', () => {
    const panel = vscode.window.createWebviewPanel(
      'hermesAgentUI',
      'Hermes Agent',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
      }
    );
    wireHermesAgent(panel.webview, context, (cb) => panel.onDidDispose(cb, null, context.subscriptions));
  });
  context.subscriptions.push(disposable);
}

/**
 * Provee la vista webview de la barra lateral. VS Code invoca resolveWebviewView
 * cuando el usuario abre el contenedor desde el icono de la Activity Bar.
 */
class HermesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hermesAgentUI.view';
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };
    wireHermesAgent(
      webviewView.webview,
      this.context,
      (cb) => webviewView.onDidDispose(cb, null, this.context.subscriptions)
    );
  }
}

/**
 * Conecta un webview (de panel o de vista lateral) con el subproceso de Hermes
 * Agent por stdio JSON-RPC. Centraliza el ciclo de vida para que el comando y la
 * vista de la barra lateral compartan exactamente la misma logica.
 */
function wireHermesAgent(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  onDispose: (cb: () => void) => void
): void {
    const config = vscode.workspace.getConfiguration('hermesAgentUI');
    const model = config.get<string>('model') || '';

    // Localizar el binario hermes (el del venv de la instalación de Hermes)
    const userProfile = process.env.USERPROFILE || '';
    const hermesHome = path.join(userProfile, 'AppData', 'Local', 'hermes', 'hermes-agent');
    const hermesExe = path.join(hermesHome, 'venv', 'Scripts', 'hermes.exe');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : hermesHome;

    // URI del logo válida dentro del webview (no se pueden usar rutas locales directas)
    const logoUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(context.extensionPath, 'media', 'hermes-icon-128.png'))
    ).toString();
    const nonce = getNonce();
    webview.html = getWebviewContent(logoUri, nonce, webview.cspSource);

    // Helper: emite hacia el webview los mismos eventos que su UI ya entiende.
    const emit = (type: string, payload?: Record<string, unknown>) => {
      webview.postMessage({ jsonrpc: '2.0', method: 'event', params: { type, payload } });
    };

    if (!fs.existsSync(hermesExe)) {
      vscode.window.showErrorMessage(
        `No se encontró Hermes en:\n${hermesExe}\n\nVerifica la instalación de Hermes Agent.`
      );
      emit('error', { message: 'Hermes no está instalado en la ruta esperada.' });
      return;
    }

    const client = new AcpClient(hermesExe, cwd);
    let sessionId: string | null = null;
    let streaming = false;
    // Marca si el turno en curso fue cancelado por el usuario: evita que el
    // `prompt` que resuelve después emita un segundo `message.complete`.
    let cancelled = false;
    let lastModels: AcpModel[] = [];
    // options de la última petición de permiso, indexadas por requestId
    const permissionOptions = new Map<string, AcpPermissionOption[]>();

    const startStream = () => {
      if (!streaming) {
        streaming = true;
        emit('message.start');
      }
    };

    // --- Notificaciones ACP (session/update) -> eventos del webview ---
    client.onSessionUpdate((update) => {
      const kind = update.sessionUpdate;
      const text = update.content?.text ?? update.text ?? '';
      switch (kind) {
        case 'agent_message_chunk':
          startStream();
          if (text) {
            emit('message.delta', { text });
          }
          break;
        case 'agent_thought_chunk':
          // Razonamiento: indicador sutil (no volcamos el texto íntegro al chat)
          emit('status.update', { text: 'Razonando…' });
          break;
        case 'tool_call':
          emit('tool.start', {
            id: update.toolCallId,
            display_name: update.title || update.kind || 'herramienta',
          });
          break;
        case 'tool_call_update': {
          if (update.status === 'completed' || update.status === 'failed') {
            emit('tool.complete', { id: update.toolCallId });
          }
          break;
        }
        case 'available_commands_update': {
          const cmds = update.availableCommands || update.commands || [];
          emit('commands.update', { commands: cmds });
          break;
        }
        default:
          // usage_update, plan, etc.: sin UI
          break;
      }
    });

    // --- Petición de permiso del agente -> tarjeta de aprobación del webview ---
    client.onPermissionRequest((requestId, params) => {
      const toolCall = params.toolCall || {};
      const options = params.options || [];
      permissionOptions.set(String(requestId), options);
      const rawInput = toolCall.rawInput;
      emit('approval.request', {
        request_id: String(requestId),
        tool: toolCall.title || toolCall.kind || 'comando',
        details: typeof rawInput === 'object' ? JSON.stringify(rawInput, null, 2) : String(rawInput ?? ''),
      });
    });

    client.onError((message) => emit('error', { message }));

    client.onClose((code) => {
      streaming = false;
      emit('subprocess.closed', { code });
    });

    // --- Arranque ACP: initialize -> session/new ---
    void (async () => {
      try {
        await client.initialize();
        const session = await client.newSession();
        sessionId = session.sessionId;
        const modelState: AcpModelState = session.models || {};
        lastModels = modelState.availableModels || [];
        const currentId = modelState.currentModelId;
        const currentName = lastModels.find((m) => m.modelId === currentId)?.name || model || 'Hermes';
        emit('session.info', { model: currentName, cwd });
        emit('models.update', { available: lastModels, current: currentId });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const stderr = client.recentStderr();
        emit('error', {
          message: `No se pudo iniciar Hermes (ACP): ${detail}${stderr ? `\n\n${stderr}` : ''}`,
        });
      }
    })();

    // --- Mensajes del webview -> ACP ---
    webview.onDidReceiveMessage(
      async (message: { command: string; text?: string; requestId?: string; approved?: boolean; modelId?: string }) => {
        switch (message.command) {
          case 'setModel': {
            if (!sessionId || !message.modelId) {
              return;
            }
            try {
              await client.setModel(sessionId, message.modelId);
              const name = lastModels.find((m) => m.modelId === message.modelId)?.name || message.modelId;
              emit('session.info', { model: name, cwd });
              emit('models.update', { available: lastModels, current: message.modelId });
            } catch (err) {
              emit('error', {
                message: `No se pudo cambiar de modelo: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            break;
          }
          case 'sendMessage': {
            if (!sessionId) {
              vscode.window.showErrorMessage('La sesión de Hermes aún no está lista.');
              return;
            }
            streaming = false;
            cancelled = false;
            // Feedback INMEDIATO: enciende el indicador de actividad antes de
            // que llegue la primera notificación ACP (elimina el "silencio").
            emit('turn.start');
            try {
              await client.prompt(sessionId, message.text || '');
              if (!cancelled) {
                emit('message.complete');
              }
            } catch (err) {
              if (!cancelled) {
                emit('error', {
                  message: `Error en el turno: ${err instanceof Error ? err.message : String(err)}`,
                });
              }
            }
            break;
          }
          case 'cancel': {
            // Interrumpe el turno en curso. El `prompt` pendiente ya no emitirá
            // su propio message.complete (cancelled).
            if (sessionId) {
              cancelled = true;
              client.cancel(sessionId);
            }
            emit('message.complete');
            break;
          }
          case 'respondApproval': {
            const rid = message.requestId || '';
            const options = permissionOptions.get(rid) || [];
            permissionOptions.delete(rid);
            const wantAllow = !!message.approved;
            const match = options.find((o) => {
              const k = String(o.kind || '');
              return wantAllow ? k.startsWith('allow') : k.startsWith('reject');
            });
            if (match && match.optionId) {
              client.respondPermission(rid, String(match.optionId));
            } else {
              client.cancelPermission(rid);
            }
            break;
          }
          // gatewayReady / respondClarify / respondSudo / respondSecret pertenecían
          // al protocolo interno antiguo; ACP no los usa.
          default:
            break;
        }
      },
      undefined,
      context.subscriptions
    );

    onDispose(() => {
      client.dispose();
    });
}

/** Genera un nonce alfanumérico para la Content-Security-Policy del webview. */
function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function getWebviewContent(logoUri: string, nonce: string, cspSource: string) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hermes Agent UI</title>
  <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=ABeeZee&family=Righteous&display=swap" rel="stylesheet">
  <style>
    :root {
      /* Turquesa - Color Principal de Marca */
      --turquesa-100: #cdfffb;
      --turquesa-400: #18f8f6;
      --turquesa-600: #00bec8;
      --turquesa-700: #088b96;
      
      /* Rosa Fuerte - Acciones Críticas / Error */
      --rosa-600: #e11d48;
      --rosa-700: #be123c;
      
      /* Dorado - Información Importante */
      --tulip-tree-500: #eab308;
      
      /* Sistema de Neutrales en Capas de Profundidad */
      --layer-bg-deepest: #111827;    /* Capa 1 - Fondo profundo */
      --layer-bg-container: #1f2937;  /* Capa 2 - Contenedores, tarjetas */
      --layer-bg-interactive: #374151;/* Capa 3 - Inputs, interactivos, hover */
      --layer-bg-active: #4b5563;     /* Capa 4 - Bordes, estados activos */
      
      --text: #f9fafb;
      --text-muted: #9ca3af;
      
      --ok-green: #4caf50;

      /* Tipografía Movimiento Funcional */
      --font-display: 'Righteous', Arial, sans-serif;
      --font-sans: 'ABeeZee', -apple-system, sans-serif;
      --font-mono: 'Consolas', 'Courier New', monospace;
      --font-size-base: 18px;

      /* Sombra de Dos Capas Premium (luz superior + profundidad) */
      --shadow-two-layer-sm: inset 0 1px 0 0 rgba(255, 255, 255, 0.04), 0 1px 2px 0 rgba(0, 0, 0, 0.35);
      --shadow-two-layer-md: inset 0 1px 0 0 rgba(255, 255, 255, 0.05), 0 4px 12px 0 rgba(0, 0, 0, 0.3);
      --shadow-two-layer-lg: inset 0 1px 0 0 rgba(255, 255, 255, 0.06), 0 12px 32px -4px rgba(0, 0, 0, 0.55);
      --shadow-popup: inset 0 1px 0 0 rgba(255, 255, 255, 0.06), 0 16px 40px -8px rgba(0, 0, 0, 0.65);

      /* Anillo de foco accesible (WCAG 2.1 AA, alto contraste) */
      --focus-ring: 0 0 0 2px var(--layer-bg-deepest), 0 0 0 4px var(--turquesa-400);

      /* Tokens de movimiento */
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      --ease-soft: cubic-bezier(0.4, 0, 0.2, 1);
      --dur-fast: 130ms;
      --dur-base: 200ms;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    /* Foco visible coherente en todo elemento interactivo (accesibilidad) */
    :focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
      border-radius: 8px;
    }

    /* Solo para lectores de pantalla (etiquetas accesibles invisibles) */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    /* Respeta la preferencia de movimiento reducido del sistema */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
      }
    }
    
    body {
      background-color: var(--layer-bg-deepest);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: var(--font-size-base);
      line-height: 1.6;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      text-align: left;
      hyphens: none;
    }
    
    /* Encabezado */
    header.app-header {
      background:
        linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0) 60%),
        var(--layer-bg-container);
      border-bottom: 1px solid var(--layer-bg-interactive);
      padding: 14px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      box-shadow: var(--shadow-two-layer-md);
      z-index: 20;
    }

    header.app-header h1 {
      font-family: var(--font-display);
      font-size: 22px;
      letter-spacing: 0.3px;
      color: var(--turquesa-400);
      display: flex;
      align-items: center;
      gap: 9px;
      text-shadow: 0 0 18px rgba(24, 248, 246, 0.18);
    }

    header.app-header h1 .material-icons {
      font-size: 24px;
      color: var(--turquesa-600);
    }

    header.app-header h1 .brand-logo {
      width: 34px;
      height: 34px;
      border-radius: 9px;
      object-fit: cover;
      vertical-align: middle;
      box-shadow: 0 0 10px rgba(24, 248, 246, 0.25);
    }

    .model-badge {
      background-color: var(--layer-bg-interactive);
      border: 1px solid var(--layer-bg-active);
      color: var(--turquesa-100);
      padding: 7px 13px;
      border-radius: 999px;
      font-family: var(--font-sans);
      font-size: 13px;
      font-weight: bold;
      letter-spacing: 0.2px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      min-height: 32px;
      transition: background-color var(--dur-fast) var(--ease-soft),
                  border-color var(--dur-fast) var(--ease-soft),
                  transform var(--dur-fast) var(--ease-out);
    }

    .model-badge:hover {
      background-color: var(--layer-bg-active);
      border-color: var(--turquesa-700);
      transform: translateY(-1px);
    }

    .model-badge:active { transform: translateY(0); }

    /* Semáforo de estado: punto + halo suave, animado al conectar */
    .status-dot {
      display: inline-block;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex: none;
      background: var(--text-muted);
      box-shadow: 0 0 0 0 transparent;
      transition: background-color var(--dur-base) var(--ease-soft),
                  box-shadow var(--dur-base) var(--ease-soft);
    }
    .status-dot.connecting {
      background: var(--tulip-tree-500);
      box-shadow: 0 0 8px 0 var(--tulip-tree-500);
      animation: pulse-dot 1.4s var(--ease-soft) infinite;
    }
    .status-dot.online {
      background: var(--ok-green);
      box-shadow: 0 0 8px 0 rgba(76, 175, 80, 0.85);
    }
    .status-dot.offline {
      background: var(--text-muted);
      box-shadow: none;
    }

    @keyframes pulse-dot {
      0%, 100% { box-shadow: 0 0 6px 0 var(--tulip-tree-500); opacity: 0.85; }
      50% { box-shadow: 0 0 11px 1px var(--tulip-tree-500); opacity: 1; }
    }
    
    /* Área Principal de Chat */
    main.chat-area {
      flex: 1;
      padding: 24px;
      overflow-y: auto;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      gap: 18px;
      scroll-behavior: smooth;
      scrollbar-width: thin;
      scrollbar-color: var(--layer-bg-active) transparent;
    }
    main.chat-area::-webkit-scrollbar { width: 10px; }
    main.chat-area::-webkit-scrollbar-track { background: transparent; }
    main.chat-area::-webkit-scrollbar-thumb {
      background: var(--layer-bg-interactive);
      border: 3px solid var(--layer-bg-deepest);
      border-radius: 999px;
    }
    main.chat-area::-webkit-scrollbar-thumb:hover { background: var(--layer-bg-active); }

    /* Estado vacío: bienvenida sobria y discreta */
    .empty-state {
      margin: auto;
      max-width: 420px;
      text-align: center;
      color: var(--text-muted);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      padding: 32px 16px;
      opacity: 0;
      animation: fade-in 500ms var(--ease-out) forwards;
    }
    .empty-state .empty-icon {
      width: 64px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 18px;
      background: radial-gradient(circle at 50% 35%, rgba(0,190,200,0.18), rgba(0,190,200,0.04));
      border: 1px solid var(--layer-bg-interactive);
      box-shadow: var(--shadow-two-layer-sm);
    }
    .empty-state .empty-icon .material-icons {
      font-size: 34px;
      color: var(--turquesa-400);
    }
    .empty-state .empty-icon .empty-logo {
      width: 100%;
      height: 100%;
      border-radius: 16px;
      object-fit: cover;
    }
    .empty-state h2 {
      font-family: var(--font-display);
      font-size: 21px;
      color: var(--text);
      letter-spacing: 0.3px;
    }
    .empty-state p {
      font-size: 15px;
      line-height: 1.55;
      color: var(--text-muted);
      max-width: 340px;
    }
    .empty-state kbd {
      font-family: var(--font-mono);
      font-size: 13px;
      background: var(--layer-bg-interactive);
      border: 1px solid var(--layer-bg-active);
      border-bottom-width: 2px;
      color: var(--turquesa-100);
      padding: 1px 7px;
      border-radius: 6px;
    }

    /* Mensajes */
    article.message {
      padding: 16px 18px;
      border-radius: 16px;
      max-width: 88%;
      box-shadow: var(--shadow-two-layer-md);
      display: flex;
      flex-direction: column;
      gap: 10px;
      opacity: 0;
      transform: translateY(8px);
      animation: msg-in var(--dur-base) var(--ease-out) forwards;
    }

    @keyframes msg-in {
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fade-in {
      to { opacity: 1; }
    }

    article.message.user {
      align-self: flex-end;
      background:
        linear-gradient(180deg, rgba(0,190,200,0.10), rgba(0,190,200,0) 70%),
        var(--layer-bg-interactive);
      border: 1px solid var(--turquesa-700);
      border-bottom-right-radius: 6px;
    }

    article.message.agent {
      align-self: flex-start;
      background-color: var(--layer-bg-container);
      border: 1px solid var(--layer-bg-interactive);
      border-bottom-left-radius: 6px;
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-muted);
    }

    .message-header .material-icons {
      font-size: 19px;
    }

    .message.agent .message-header .material-icons { color: var(--turquesa-400); }
    .message.user .message-header .material-icons { color: var(--turquesa-400); }

    .message-header h3 {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
    }

    .message-body {
      font-size: var(--font-size-base);
      line-height: 1.65;
      word-break: break-word;
      color: var(--text);
    }

    .message-body strong { color: var(--turquesa-100); font-weight: 700; }
    
    /* Indicadores de Actividad */
    aside.activity-bar {
      align-self: flex-start;
      font-size: 14px;
      color: var(--text-muted);
      padding: 6px 14px;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      margin-left: 4px;
      opacity: 0;
      animation: fade-in var(--dur-base) var(--ease-out) forwards;
    }

    aside.tool-badge {
      align-self: flex-start;
      font-size: 14px;
      color: var(--turquesa-100);
      background-color: var(--layer-bg-container);
      border: 1px solid var(--turquesa-700);
      padding: 7px 14px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      margin-left: 4px;
      box-shadow: var(--shadow-two-layer-sm);
      opacity: 0;
      animation: fade-in var(--dur-base) var(--ease-out) forwards;
    }
    aside.tool-badge .material-icons { font-size: 17px; color: var(--turquesa-400); }

    /* Renderizado de Código */
    pre {
      background-color: var(--layer-bg-deepest);
      border: 1px solid var(--layer-bg-interactive);
      padding: 14px 16px;
      border-radius: 10px;
      overflow-x: auto;
      margin: 12px 0;
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.4);
      scrollbar-width: thin;
    }

    code {
      font-family: var(--font-mono);
      font-size: 15px;
      color: var(--turquesa-400);
    }

    code.inline-code {
      background-color: var(--layer-bg-deepest);
      border: 1px solid var(--layer-bg-interactive);
      padding: 2px 7px;
      border-radius: 6px;
      font-size: 15px;
      color: var(--turquesa-400);
    }
    
    /* Cajas de Aprobación Interactiva (WCAG AA - Tactiles) */
    .approval-card {
      background:
        linear-gradient(180deg, rgba(234,179,8,0.07), rgba(234,179,8,0) 40%),
        var(--layer-bg-container);
      border: 1px solid var(--tulip-tree-500);
      border-left: 4px solid var(--tulip-tree-500);
      padding: 20px 22px;
      border-radius: 14px;
      margin: 8px 0;
      box-shadow: var(--shadow-two-layer-lg);
      display: flex;
      flex-direction: column;
      gap: 14px;
      align-self: flex-start;
      width: 100%;
      max-width: 600px;
      opacity: 0;
      transform: translateY(8px);
      animation: msg-in var(--dur-base) var(--ease-out) forwards;
    }

    .approval-title {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--tulip-tree-500);
      font-family: var(--font-display);
      font-size: 18px;
      letter-spacing: 0.3px;
    }
    .approval-title h3 { font: inherit; color: inherit; }

    .approval-details {
      background-color: var(--layer-bg-deepest);
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid var(--layer-bg-interactive);
      font-family: var(--font-mono);
      font-size: 14px;
      color: var(--turquesa-100);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.4);
    }

    .approval-actions {
      display: flex;
      gap: 12px;
      margin-top: 2px;
    }

    /* Pie de página y entrada */
    footer.input-area {
      background:
        linear-gradient(0deg, rgba(255,255,255,0.02), rgba(255,255,255,0) 60%),
        var(--layer-bg-container);
      border-top: 1px solid var(--layer-bg-interactive);
      padding: 16px 24px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: 0 -8px 24px -8px rgba(0,0,0,0.45);
      z-index: 20;
    }

    .input-wrapper {
      display: flex;
      gap: 12px;
      align-items: stretch;
      background-color: var(--layer-bg-interactive);
      border: 1px solid var(--layer-bg-active);
      border-radius: 14px;
      padding: 6px 6px 6px 6px;
      box-shadow: var(--shadow-two-layer-sm);
      transition: border-color var(--dur-base) var(--ease-soft),
                  box-shadow var(--dur-base) var(--ease-soft);
    }

    /* El contenedor refleja el foco del input interior */
    .input-wrapper:focus-within {
      border-color: var(--turquesa-600);
      box-shadow: var(--shadow-two-layer-sm), 0 0 0 3px rgba(0, 190, 200, 0.22);
    }

    .input-wrapper input {
      flex: 1;
      padding: 12px 14px;
      border-radius: 10px;
      border: none;
      background-color: transparent;
      color: var(--text);
      font-size: var(--font-size-base);
      font-family: var(--font-sans);
      outline: none;
    }
    .input-wrapper input::placeholder { color: var(--text-muted); }
    .input-wrapper input:disabled { opacity: 0.55; cursor: not-allowed; }
    /* El foco lo señala el contenedor; evita doble anillo en el input */
    .input-wrapper input:focus-visible { box-shadow: none; }

    /* Botones Premium */
    .btn-primary {
      background-color: var(--turquesa-600);
      color: #06222a;
      border: 1px solid var(--turquesa-400);
      padding: 10px 22px;
      border-radius: 10px;
      font-weight: 700;
      font-family: var(--font-sans);
      font-size: 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      cursor: pointer;
      box-shadow: var(--shadow-two-layer-sm);
      transition: background-color var(--dur-fast) var(--ease-soft),
                  transform var(--dur-fast) var(--ease-out),
                  box-shadow var(--dur-fast) var(--ease-soft),
                  opacity var(--dur-fast) var(--ease-soft);
      min-height: 44px; /* Ley de Fitts touch target */
    }
    .btn-primary .material-icons { font-size: 19px; }

    .btn-primary:hover {
      background-color: var(--turquesa-400);
      transform: translateY(-2px);
      box-shadow: 0 6px 16px -2px rgba(0, 190, 200, 0.45);
    }
    .btn-primary:active { transform: translateY(0); box-shadow: var(--shadow-two-layer-sm); }
    .btn-primary:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    .btn-critical {
      background-color: var(--rosa-600);
      color: #ffffff;
      border: 1px solid var(--rosa-700);
      padding: 10px 22px;
      border-radius: 10px;
      font-weight: 700;
      font-family: var(--font-sans);
      font-size: 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      cursor: pointer;
      box-shadow: var(--shadow-two-layer-sm);
      transition: background-color var(--dur-fast) var(--ease-soft),
                  transform var(--dur-fast) var(--ease-out),
                  box-shadow var(--dur-fast) var(--ease-soft);
      min-height: 44px;
    }
    .btn-critical .material-icons { font-size: 19px; }

    .btn-critical:hover {
      background-color: var(--rosa-700);
      transform: translateY(-2px);
      box-shadow: 0 6px 16px -2px rgba(225, 29, 72, 0.45);
    }
    .btn-critical:active { transform: translateY(0); box-shadow: var(--shadow-two-layer-sm); }
    .btn-critical:disabled {
      opacity: 0.55;
      cursor: progress;
      transform: none;
      box-shadow: none;
    }

    /* El botón #send conserva su id y alterna entre btn-primary (Enviar) y
       btn-critical (Detener). Transición suave de color al cambiar de estado. */
    #send {
      transition: background-color var(--dur-fast) var(--ease-soft),
                  border-color var(--dur-fast) var(--ease-soft),
                  color var(--dur-fast) var(--ease-soft),
                  transform var(--dur-fast) var(--ease-out),
                  box-shadow var(--dur-fast) var(--ease-soft),
                  opacity var(--dur-fast) var(--ease-soft);
    }
    /* Cuadrado de "stop" dibujado con CSS (no depende de fuente de iconos) */
    #send .stop-glyph {
      width: 13px;
      height: 13px;
      border-radius: 3px;
      background: currentColor;
      flex: none;
    }

    /* Animación del Spinner */
    .spinner {
      border: 2.5px solid var(--layer-bg-active);
      border-top: 2.5px solid var(--turquesa-400);
      border-radius: 50%;
      width: 16px;
      height: 16px;
      animation: spin 0.8s linear infinite;
      display: inline-block;
      flex: none;
      will-change: transform;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* ===== Indicador de actividad de turno (persistente) ===== */
    /* Píldora fija sobre la barra de composición: comunica de forma
       inequívoca que Hermes está trabajando durante todo el turno. */
    .activity-indicator {
      display: flex;
      align-items: center;
      gap: 11px;
      align-self: stretch;
      padding: 10px 16px;
      border-radius: 12px;
      background:
        linear-gradient(180deg, rgba(0,190,200,0.12), rgba(0,190,200,0.03) 70%),
        var(--layer-bg-container);
      border: 1px solid var(--turquesa-700);
      box-shadow: var(--shadow-two-layer-sm), 0 0 0 1px rgba(0,190,200,0.06);
      color: var(--turquesa-100);
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.2px;
      /* Animación de entrada al encender */
      animation: activity-in var(--dur-base) var(--ease-out);
      will-change: transform, opacity;
    }
    /* Estado apagado: oculto y fuera del flujo (sin reservar espacio) */
    .activity-indicator[hidden] { display: none; }

    /* Spinner propio del indicador, algo mayor para visibilidad clara */
    .activity-indicator .spinner {
      width: 18px;
      height: 18px;
      border-width: 2.5px;
    }

    /* Punto de actividad latente junto al texto (refuerza el "está vivo") */
    .activity-indicator .activity-pulse {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex: none;
      background: var(--turquesa-400);
      box-shadow: 0 0 8px 0 var(--turquesa-400);
      animation: activity-pulse 1.4s var(--ease-soft) infinite;
      will-change: opacity, transform;
    }

    .activity-indicator .activity-text {
      flex: 1;
      min-width: 0;
      color: var(--turquesa-100);
    }

    @keyframes activity-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes activity-pulse {
      0%, 100% { opacity: 0.55; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1); }
    }

    /* ===== Barra de composición estilo Claude Code ===== */
    header.app-header { position: relative; }
    footer.input-area { position: relative; }

    .composer-toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .tool-btn {
      background: transparent;
      border: 1px solid var(--layer-bg-active);
      color: var(--text-muted);
      padding: 7px 13px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      font-family: var(--font-sans);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background-color var(--dur-fast) var(--ease-soft),
                  border-color var(--dur-fast) var(--ease-soft),
                  color var(--dur-fast) var(--ease-soft),
                  transform var(--dur-fast) var(--ease-out);
    }
    .tool-btn:hover {
      background: var(--layer-bg-interactive);
      border-color: var(--turquesa-700);
      color: var(--turquesa-100);
      transform: translateY(-1px);
    }
    .tool-btn:active { transform: translateY(0); }
    .tool-btn .material-icons { font-size: 17px; color: var(--turquesa-400); }
    .tool-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }

    .popup-menu {
      position: absolute;
      z-index: 100;
      background: var(--layer-bg-container);
      border: 1px solid var(--layer-bg-active);
      border-radius: 12px;
      box-shadow: var(--shadow-popup);
      max-height: 320px;
      overflow-y: auto;
      padding: 6px;
      scrollbar-width: thin;
      scrollbar-color: var(--layer-bg-active) transparent;
      transform-origin: var(--menu-origin, bottom center);
      animation: menu-in 150ms var(--ease-out);
    }
    .popup-menu::-webkit-scrollbar { width: 8px; }
    .popup-menu::-webkit-scrollbar-track { background: transparent; }
    .popup-menu::-webkit-scrollbar-thumb {
      background: var(--layer-bg-active);
      border: 2px solid var(--layer-bg-container);
      border-radius: 999px;
    }
    @keyframes menu-in {
      from { opacity: 0; transform: translateY(6px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .command-menu { left: 24px; right: 24px; bottom: 100px; --menu-origin: bottom center; }
    .model-menu { right: 24px; top: 56px; min-width: 250px; --menu-origin: top right; }

    .command-item {
      padding: 9px 12px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 2px;
      border-radius: 8px;
      scroll-margin: 6px;
      transition: background-color var(--dur-fast) var(--ease-soft);
    }
    .command-item:hover, .command-item.active {
      background: var(--layer-bg-interactive);
    }
    /* Item resaltado por navegación de teclado (flechas) */
    .command-item.highlighted {
      background: var(--layer-bg-interactive);
      box-shadow: inset 3px 0 0 0 var(--turquesa-400);
    }
    .cmd-name {
      color: var(--turquesa-400);
      font-weight: 600;
      font-family: var(--font-mono);
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .cmd-desc {
      color: var(--text-muted);
      font-size: 12.5px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <header class="app-header">
    <h1>
      <img class="brand-logo" src="${logoUri}" alt="" aria-hidden="true" />
      Hermes Agent
    </h1>
    <button type="button" id="model-container" class="model-badge" title="Cambiar modelo"
            aria-haspopup="listbox" aria-expanded="false" aria-controls="model-menu" aria-label="Estado: iniciando. Pulsa para cambiar de modelo.">
      <span class="status-dot connecting" aria-hidden="true"></span>
      <span>Iniciando...</span>
    </button>
    <div id="model-menu" class="popup-menu model-menu" role="listbox" aria-label="Modelos disponibles" hidden></div>
  </header>

  <main class="chat-area" id="chat-container" role="log" aria-live="polite" aria-label="Conversación con Hermes Agent">
    <div class="empty-state" id="empty-state">
      <span class="empty-icon"><img class="empty-logo" src="${logoUri}" alt="" aria-hidden="true" /></span>
      <h2>Hermes Agent</h2>
      <p>Tu asistente está listo. Escribe una petición abajo, o pulsa <kbd>/</kbd> para explorar los comandos disponibles.</p>
    </div>
  </main>

  <footer class="input-area">
    <div id="activity-indicator" class="activity-indicator" role="status" aria-live="polite" hidden>
      <span class="spinner" aria-hidden="true"></span>
      <span class="activity-pulse" aria-hidden="true"></span>
      <span class="activity-text" id="activity-text">Hermes está pensando...</span>
    </div>
    <div class="composer-toolbar" role="toolbar" aria-label="Acciones de conversación">
      <button type="button" class="tool-btn" id="btn-commands" title="Comandos disponibles"
              aria-haspopup="listbox" aria-expanded="false" aria-controls="command-menu">
        <span class="material-icons" aria-hidden="true">bolt</span>Comandos
      </button>
      <button type="button" class="tool-btn" id="btn-clear" title="Limpiar conversación (/reset)">
        <span class="material-icons" aria-hidden="true">delete_sweep</span>Limpiar
      </button>
      <button type="button" class="tool-btn" id="btn-compact" title="Compactar contexto (/compact)">
        <span class="material-icons" aria-hidden="true">compress</span>Compactar
      </button>
    </div>
    <form id="chat-form" class="input-wrapper">
      <label for="prompt" class="sr-only">Mensaje para Hermes Agent</label>
      <input type="text" id="prompt" placeholder="Escribe un comando o petición... (escribe / para ver comandos)" disabled required autocomplete="off"
             role="combobox" aria-expanded="false" aria-controls="command-menu" aria-autocomplete="list" />
      <button type="submit" id="send" class="btn-primary" disabled aria-label="Enviar mensaje">
        <span class="material-icons" aria-hidden="true">send</span>
        Enviar
      </button>
    </form>
    <div id="command-menu" class="popup-menu command-menu" role="listbox" aria-label="Comandos disponibles" hidden></div>
  </footer>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Escapa texto para inyectarlo de forma segura en HTML (previene XSS cuando
    // el dato viene del agente: nombres de herramienta, etc.).
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    const sendBtn = document.getElementById('send');
    const input = document.getElementById('prompt');
    const chat = document.getElementById('chat-container');
    const modelContainer = document.getElementById('model-container');

    let activeMessageBody = null;
    let rawTextBuffer = '';
    // Herramientas en ejecución, por toolCallId (para no apagar el indicador de
    // una herramienta cuando termina otra distinta).
    const activeTools = new Set();

    // ===== Botón dual Enviar <-> Detener (patrón Claude Code) =====
    // Mientras el turno está activo, el botón #send (mismo id) se transforma
    // en un botón crítico de DETENER. Esta bandera bifurca el comportamiento
    // de envío para que durante el turno NO se mande un segundo prompt.
    let turnActive = false;

    // Markup de cada estado del botón. Conservamos el id 'send'; solo cambian
    // clase, contenido y aria-label. El icono 'stop' se dibuja con CSS para no
    // depender de que la fuente de iconos haya cargado.
    const SEND_HTML = '<span class="material-icons" aria-hidden="true">send</span>Enviar';
    const STOP_HTML = '<span class="stop-glyph" aria-hidden="true"></span>Detener';

    // Pasa el botón a modo DETENER (turno en curso).
    function enterStopMode() {
      turnActive = true;
      sendBtn.classList.remove('btn-primary');
      sendBtn.classList.add('btn-critical');
      sendBtn.innerHTML = STOP_HTML;
      sendBtn.setAttribute('aria-label', 'Detener generación');
      sendBtn.title = 'Detener generación';
      sendBtn.disabled = false; // siempre pulsable mientras el agente trabaja
    }

    // Devuelve el botón a modo ENVIAR (turno terminado).
    function exitSendMode() {
      turnActive = false;
      sendBtn.classList.remove('btn-critical');
      sendBtn.classList.add('btn-primary');
      sendBtn.innerHTML = SEND_HTML;
      sendBtn.setAttribute('aria-label', 'Enviar mensaje');
      sendBtn.title = '';
    }

    // Solicita la cancelación del turno en curso. La extensión ya gestiona el
    // comando 'cancel' y emitirá message.complete, que devuelve el botón a Enviar.
    function requestCancel() {
      vscode.postMessage({ command: 'cancel' });
      sendBtn.innerHTML = STOP_HTML; // mantiene icono stop
      sendBtn.disabled = true;       // evita doble pulsación de cancelar
      setActivity('Deteniendo...');
    }

    // Punto de entrada único del botón #send y del submit del form (Enter).
    // Bifurca según el estado del turno para no enviar un segundo mensaje.
    function handlePrimaryAction() {
      if (turnActive) {
        requestCancel();
        return;
      }
      sendMessage();
    }

    // Indicador de estado de conexion en la cabecera (punto de color + texto)
    function setStatus(state, text) {
      const dotState = (state === 'online' || state === 'connecting') ? state : 'offline';
      modelContainer.innerHTML =
        '<span class="status-dot ' + dotState + '" aria-hidden="true"></span>' +
        '<span>' + escapeHtml(text) + '</span>';
      const labels = { connecting: 'Conectando', online: 'Conectado', offline: 'Desconectado' };
      modelContainer.setAttribute('aria-label',
        'Estado: ' + (labels[dotState] || 'desconocido') + '. Modelo ' + text + '. Pulsa para cambiar de modelo.');
    }

    // ===== Comandos slash y selector de modelo (estilo Claude Code) =====
    let slashCommands = [];
    let availableModels = [];
    let currentModelId = '';
    const commandMenu = document.getElementById('command-menu');
    const modelMenu = document.getElementById('model-menu');

    // Índice del item resaltado por teclado dentro del menú visible (-1 = ninguno)
    let menuHighlight = -1;

    function activeMenu() {
      if (!commandMenu.hidden) { return commandMenu; }
      if (!modelMenu.hidden) { return modelMenu; }
      return null;
    }

    function clearHighlight() {
      menuHighlight = -1;
      Array.prototype.forEach.call(document.querySelectorAll('.command-item.highlighted'), function (el) {
        el.classList.remove('highlighted');
        el.removeAttribute('aria-selected');
      });
    }

    function moveHighlight(delta) {
      const menu = activeMenu();
      if (!menu) { return; }
      const items = menu.querySelectorAll('.command-item');
      if (!items.length) { return; }
      Array.prototype.forEach.call(items, function (el) {
        el.classList.remove('highlighted');
        el.removeAttribute('aria-selected');
      });
      menuHighlight = (menuHighlight + delta + items.length) % items.length;
      const el = items[menuHighlight];
      el.classList.add('highlighted');
      el.setAttribute('aria-selected', 'true');
      if (el.scrollIntoView) { el.scrollIntoView({ block: 'nearest' }); }
    }

    function activateHighlight() {
      const menu = activeMenu();
      if (!menu || menuHighlight < 0) { return false; }
      const items = menu.querySelectorAll('.command-item');
      const el = items[menuHighlight];
      if (el) { el.click(); return true; }
      return false;
    }

    function hideMenus() {
      commandMenu.hidden = true;
      modelMenu.hidden = true;
      clearHighlight();
      syncMenuAria();
    }

    function renderCommandMenu(filter) {
      const f = (filter || '').toLowerCase();
      const items = slashCommands.filter(function (c) { return c.name.toLowerCase().indexOf(f) !== -1; });
      if (!items.length) { commandMenu.hidden = true; syncMenuAria(); return; }
      commandMenu.innerHTML = items.map(function (c) {
        return '<div class="command-item" role="option" data-cmd="' + escapeHtml(c.name) + '" data-hasinput="' + (c.input ? '1' : '') + '">' +
          '<span class="cmd-name">/' + escapeHtml(c.name) + '</span>' +
          '<span class="cmd-desc">' + escapeHtml(c.description || '') + '</span></div>';
      }).join('');
      Array.prototype.forEach.call(commandMenu.querySelectorAll('.command-item'), function (el) {
        el.onclick = function () { selectCommand(el.getAttribute('data-cmd'), el.getAttribute('data-hasinput') === '1'); };
      });
      modelMenu.hidden = true;
      commandMenu.hidden = false;
      clearHighlight();
      syncMenuAria();
    }

    function selectCommand(name, hasInput) {
      commandMenu.hidden = true;
      if (hasInput) {
        input.value = '/' + name + ' ';
        input.focus();
      } else {
        submitText('/' + name);
      }
    }

    function renderModelMenu() {
      if (!availableModels.length) { return; }
      modelMenu.innerHTML = availableModels.map(function (m) {
        const active = m.modelId === currentModelId;
        return '<div class="command-item ' + (active ? 'active' : '') + '" role="option" aria-selected="' + (active ? 'true' : 'false') + '" data-model="' + escapeHtml(m.modelId) + '">' +
          '<span class="cmd-name">' + escapeHtml(m.name || m.modelId) +
          (active ? '<span class="material-icons" style="font-size:17px;color:var(--ok-green);" aria-hidden="true">check_circle</span>' : '') +
          '</span>' +
          (active ? '<span class="cmd-desc">En uso</span>' : '') + '</div>';
      }).join('');
      Array.prototype.forEach.call(modelMenu.querySelectorAll('.command-item'), function (el) {
        el.onclick = function () {
          modelMenu.hidden = true;
          clearHighlight();
          syncMenuAria();
          vscode.postMessage({ command: 'setModel', modelId: el.getAttribute('data-model') });
        };
      });
      commandMenu.hidden = true;
      modelMenu.hidden = false;
      clearHighlight();
      syncMenuAria();
    }

    // Envía un texto directamente (para comandos y botones de la barra)
    function submitText(text) {
      if (input.disabled) { return; }
      dismissEmptyState();
      hideMenus();
      const userMsg = document.createElement('article');
      userMsg.className = 'message user';
      userMsg.innerHTML = '<header class="message-header" style="color: var(--turquesa-400)"><span class="material-icons">account_circle</span><h3>Tú</h3></header>' +
        '<section class="message-body">' + parseMarkdown(text) + '</section>';
      chat.appendChild(userMsg);
      vscode.postMessage({ command: 'sendMessage', text: text });
      input.value = '';
      scrollToBottom();
    }

    // Wiring de la barra de composición
    document.getElementById('btn-commands').addEventListener('click', function (e) {
      e.stopPropagation();
      if (commandMenu.hidden) { renderCommandMenu(''); } else { commandMenu.hidden = true; clearHighlight(); syncMenuAria(); }
    });
    document.getElementById('btn-clear').addEventListener('click', function (e) {
      e.stopPropagation(); submitText('/reset');
    });
    document.getElementById('btn-compact').addEventListener('click', function (e) {
      e.stopPropagation(); submitText('/compact');
    });
    modelContainer.addEventListener('click', function (e) {
      e.stopPropagation();
      if (modelMenu.hidden) { renderModelMenu(); } else { modelMenu.hidden = true; clearHighlight(); syncMenuAria(); }
    });
    commandMenu.addEventListener('click', function (e) { e.stopPropagation(); });
    modelMenu.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('input', function () {
      const v = input.value;
      if (v.charAt(0) === '/') {
        renderCommandMenu(v.slice(1).split(' ')[0]);
      } else {
        commandMenu.hidden = true;
        clearHighlight();
        syncMenuAria();
      }
    });
    // Envío del formulario (Enter o botón). Antes era un atributo onsubmit
    // inline; con CSP/nonce se enlaza por JS.
    document.getElementById('chat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      handlePrimaryAction();
    });

    // Navegación de teclado en menús: flechas, Enter, Escape (WCAG 2.1 AA)
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hideMenus(); return; }
      if (commandMenu.hidden) { return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(-1); }
      else if (e.key === 'Enter' && menuHighlight >= 0) { e.preventDefault(); activateHighlight(); }
      else if (e.key === 'Tab' && menuHighlight >= 0) { e.preventDefault(); activateHighlight(); }
    });
    // El selector de modelo (badge en cabecera) también navegable con teclado
    modelContainer.addEventListener('keydown', function (e) {
      if (modelMenu.hidden) { return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(-1); }
      else if (e.key === 'Enter' && menuHighlight >= 0) { e.preventDefault(); activateHighlight(); }
      else if (e.key === 'Escape') { hideMenus(); }
    });
    document.addEventListener('click', function () { hideMenus(); });

    // Auto-scroll utility
    function scrollToBottom() {
      chat.scrollTop = chat.scrollHeight;
    }

    // Oculta el estado vacío en cuanto entra contenido real en el chat
    function dismissEmptyState() {
      const es = document.getElementById('empty-state');
      if (es) { es.remove(); }
    }

    // Sincroniza aria-expanded del disparador asociado a cada menú
    function syncMenuAria() {
      const cmdOpen = !commandMenu.hidden;
      const modelOpen = !modelMenu.hidden;
      const btnCmd = document.getElementById('btn-commands');
      if (btnCmd) { btnCmd.setAttribute('aria-expanded', String(cmdOpen)); }
      input.setAttribute('aria-expanded', String(cmdOpen));
      modelContainer.setAttribute('aria-expanded', String(modelOpen));
    }

    // Basic markdown helper (safe & lightweight)
    function parseMarkdown(text) {
      if (!text) return '';
      let escaped = escapeHtml(text);

      // Triple code blocks
      escaped = escaped.replace(/\\\`\\\`\\\`([\\s\\S]*?)\\\`\\\`\\\`/g, function(match, code) {
        return '<pre><code>' + code.trim() + '</code></pre>';
      });
      
      // Inline code
      escaped = escaped.replace(/\\\`([^\`]+)\\\`/g, '<code class="inline-code">$1</code>');
      
      // Bold text
      escaped = escaped.replace(/\\*\\*([^\\*]+)\\*\\*/g, '<strong>$1</strong>');
      
      // Newlines
      escaped = escaped.replace(/\\n/g, '<br/>');
      
      return escaped;
    }

    // Appending simple visual activities or tool states
    function removeAllTempElements() {
      const activeTool = document.getElementById('active-tool-badge');
      if (activeTool) activeTool.remove();
      const activeActivity = document.getElementById('active-activity-bar');
      if (activeActivity) activeActivity.remove();
    }

    // ===== Indicador de actividad de turno (persistente) =====
    // Vive sobre la barra de composición durante TODO el turno. Reutiliza
    // SIEMPRE el mismo nodo (solo cambia el texto) para evitar parpadeo y
    // que el lector de pantalla anuncie cada cambio de estado (aria-live).
    const activityIndicator = document.getElementById('activity-indicator');
    const activityText = document.getElementById('activity-text');

    // Enciende el indicador o actualiza su texto si ya está visible.
    function setActivity(text) {
      if (!activityIndicator || !activityText) { return; }
      if (text) { activityText.textContent = text; }
      activityIndicator.hidden = false;
    }

    // Apaga el indicador al finalizar el turno (éxito, error o cierre).
    function hideActivity() {
      if (!activityIndicator) { return; }
      activityIndicator.hidden = true;
    }

    // Process incoming JSON-RPC packets
    window.addEventListener('message', event => {
      const msg = event.data;
      
      // JSON-RPC Events
      if (msg.method === 'event' && msg.params) {
        const { type, payload } = msg.params;
        
        switch (type) {
          case 'commands.update':
            slashCommands = (payload && Array.isArray(payload.commands)) ? payload.commands : [];
            break;
          case 'models.update':
            availableModels = (payload && Array.isArray(payload.available)) ? payload.available : [];
            currentModelId = (payload && payload.current) || '';
            break;
          case 'session.info':
            // Conectado y listo: solo indicador de estado + modelo (sin texto verboso)
            setStatus('online', payload?.model || 'Hermes');
            input.disabled = false;
            sendBtn.disabled = false;
            input.placeholder = "Escribe un comando o petición...";
            removeAllTempElements();
            break;
            
          case 'turn.start':
            // El usuario acaba de enviar: enciende el indicador YA, antes de
            // cualquier respuesta del agente. No vuelvas a crear el nodo.
            removeAllTempElements();
            dismissEmptyState();
            activeTools.clear();
            setActivity('Hermes está pensando...');
            // El botón Enviar se transforma en DETENER durante todo el turno.
            enterStopMode();
            break;

          case 'message.start':
            removeAllTempElements();
            dismissEmptyState();
            setActivity('Escribiendo respuesta...');
            const messageElement = document.createElement('article');
            messageElement.className = 'message agent';
            
            const header = document.createElement('header');
            header.className = 'message-header';
            header.innerHTML = '<span class="material-icons">smart_toy</span><h3>Hermes Agent</h3>';
            messageElement.appendChild(header);
            
            activeMessageBody = document.createElement('section');
            activeMessageBody.className = 'message-body';
            activeMessageBody.innerHTML = '<div class="spinner"></div>';
            messageElement.appendChild(activeMessageBody);
            
            chat.appendChild(messageElement);
            rawTextBuffer = '';
            scrollToBottom();
            break;
            
          case 'message.delta':
            if (activeMessageBody) {
              const deltaText = payload?.text || '';
              rawTextBuffer += deltaText;
              activeMessageBody.innerHTML = parseMarkdown(rawTextBuffer);
              scrollToBottom();
            }
            break;
            
          case 'message.complete':
            // Fin del turno: apaga el indicador de actividad.
            removeAllTempElements();
            activeTools.clear();
            hideActivity();
            // El botón DETENER vuelve a ENVIAR.
            exitSendMode();
            activeMessageBody = null;
            break;

          case 'status.update':
            // Razonamiento en curso: solo actualiza el texto del indicador
            // persistente (mismo nodo, sin recrear -> sin parpadeo).
            removeAllTempElements();
            setActivity(payload?.text || 'Razonando...');
            break;

          case 'tool.start':
            // Ejecución de herramienta: refleja el nombre en el indicador.
            removeAllTempElements();
            if (payload && payload.id) { activeTools.add(payload.id); }
            setActivity('Ejecutando ' + (payload?.display_name || payload?.name || 'herramienta') + '...');
            break;

          case 'tool.complete':
            // Solo retira esta herramienta del conjunto activo; el indicador lo
            // gestiona el flujo general (no apaga el feedback de otra en marcha).
            if (payload && payload.id) { activeTools.delete(payload.id); }
            removeAllTempElements();
            break;

          case 'error':
            removeAllTempElements();
            activeTools.clear();
            hideActivity();
            // Turno abortado por error: el botón vuelve a ENVIAR.
            exitSendMode();
            dismissEmptyState();
            const errBlock = document.createElement('article');
            errBlock.className = 'message agent';
            errBlock.style.borderColor = 'var(--rosa-600)';
            const errHeader = document.createElement('header');
            errHeader.className = 'message-header';
            errHeader.style.color = 'var(--rosa-600)';
            errHeader.innerHTML = '<span class="material-icons">error</span><h3>Error</h3>';
            const errBody = document.createElement('section');
            errBody.className = 'message-body';
            errBody.style.color = 'var(--rosa-600)';
            // textContent (no innerHTML): el mensaje puede contener marcado del agente.
            errBody.textContent = (payload && payload.message) || 'Error desconocido del agente.';
            errBlock.appendChild(errHeader);
            errBlock.appendChild(errBody);
            chat.appendChild(errBlock);
            scrollToBottom();
            break;
            
          case 'approval.request':
            removeAllTempElements();
            dismissEmptyState();
            const reqId = payload?.request_id;
            const tool = payload?.tool || 'comando';
            const details = payload?.details || '';
            
            const appCard = document.createElement('section');
            appCard.id = 'app-' + reqId;
            appCard.className = 'approval-card';
            
            const title = document.createElement('header');
            title.className = 'approval-title';
            title.innerHTML = '<span class="material-icons">security</span><h3>Aprobación de Permiso</h3>';
            appCard.appendChild(title);
            
            const bodyText = document.createElement('p');
            bodyText.innerHTML = 'El agente requiere autorización para ejecutar la herramienta <strong>' + escapeHtml(tool) + '</strong>:';
            appCard.appendChild(bodyText);
            
            if (details) {
              const codeBlock = document.createElement('pre');
              codeBlock.className = 'approval-details';
              codeBlock.textContent = details;
              appCard.appendChild(codeBlock);
            }
            
            const actions = document.createElement('footer');
            actions.className = 'approval-actions';
            
            const denyBtn = document.createElement('button');
            denyBtn.className = 'btn-critical';
            denyBtn.innerHTML = '<span class="material-icons">close</span>Denegar';
            denyBtn.onclick = () => {
              vscode.postMessage({ command: 'respondApproval', requestId: reqId, approved: false });
              appCard.remove();
            };
            
            const approveBtn = document.createElement('button');
            approveBtn.className = 'btn-primary';
            approveBtn.innerHTML = '<span class="material-icons">check</span>Aprobar';
            approveBtn.onclick = () => {
              vscode.postMessage({ command: 'respondApproval', requestId: reqId, approved: true });
              appCard.remove();
            };
            
            actions.appendChild(denyBtn);
            actions.appendChild(approveBtn);
            appCard.appendChild(actions);
            
            chat.appendChild(appCard);
            scrollToBottom();
            break;

          case 'subprocess.closed':
            removeAllTempElements();
            activeTools.clear();
            hideActivity();
            // Subproceso cerrado: el turno termina; restablece el botón a
            // ENVIAR (y libera turnActive) antes de deshabilitarlo.
            exitSendMode();
            input.disabled = true;
            sendBtn.disabled = true;
            const exitCode = payload?.code;
            if (exitCode && exitCode !== 0) {
              // Cierre inesperado (crash): avisar en rojo
              setStatus('offline', 'Error (' + exitCode + ')');
              const closeMsg = document.createElement('article');
              closeMsg.className = 'message agent';
              closeMsg.style.borderColor = 'var(--rosa-600)';
              closeMsg.innerHTML = '<header class="message-header" style="color: var(--rosa-600)"><span class="material-icons">offline_bolt</span><h3>Conexión Perdida</h3></header>' +
                                    '<section class="message-body" style="color: var(--rosa-600)">El subproceso de Hermes Agent se cerró con código ' + escapeHtml(exitCode) + '. Vuelve a abrir el panel para reiniciar.</section>';
              chat.appendChild(closeMsg);
              scrollToBottom();
            } else {
              // Cierre limpio (código 0): indicador discreto, sin alarma
              setStatus('offline', 'Desconectado');
            }
            break;
        }
      }
    });

    function sendMessage() {
      const text = input.value.trim();
      if (!text) return;

      dismissEmptyState();
      hideMenus();
      const userMsg = document.createElement('article');
      userMsg.className = 'message user';
      userMsg.innerHTML = '<header class="message-header" style="color: var(--turquesa-400)"><span class="material-icons">account_circle</span><h3>Tú</h3></header>' +
                           '<section class="message-body">' + parseMarkdown(text) + '</section>';
      chat.appendChild(userMsg);
      
      vscode.postMessage({ command: 'sendMessage', text: text });
      input.value = '';
      scrollToBottom();
    }
  </script>
</body>
</html>`;
}

export function deactivate() {}
