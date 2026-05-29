import * as fs from 'fs';
import type { WebSocket } from 'ws';
import { AcpClient } from './acpClient';
import type { AcpModel, AcpModelState, AcpPermissionOption } from './acpTypes';

/**
 * Conecta UNA conexión WebSocket del navegador con UN subproceso de Hermes
 * (`hermes acp`) por stdio JSON-RPC.
 *
 * Es la versión web de `wireHermesAgent` de la extensión de VS Code: la lógica
 * de traducción ACP -> eventos de UI y de comandos de UI -> ACP es exactamente
 * la misma. Lo único que cambia es el transporte hacia la interfaz: aquí los
 * eventos viajan por el WebSocket (`ws.send`) en vez de por `webview.postMessage`,
 * y los comandos del usuario llegan por `ws.on('message')` en vez de por
 * `webview.onDidReceiveMessage`. El formato de los mensajes
 * (`{ jsonrpc, method:'event', params:{ type, payload } }`) es idéntico, de modo
 * que el JavaScript de la UI no nota la diferencia.
 *
 * Ciclo de vida: 1 WebSocket = 1 AcpClient = 1 subproceso `hermes acp`. Al
 * cerrarse el WebSocket se mata el subproceso (`dispose`).
 */
export function wireSession(ws: WebSocket, hermesExe: string, cwd: string): void {
  // Helper: emite hacia la UI los mismos eventos que ya entiende.
  const emit = (type: string, payload?: Record<string, unknown>) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, payload } }));
    }
  };

  if (!fs.existsSync(hermesExe)) {
    emit('error', {
      message: `No se encontró Hermes en:\n${hermesExe}\n\nVerifica la instalación de Hermes Agent (o define la variable HERMES_EXE).`,
    });
    return;
  }

  const client = new AcpClient(hermesExe, cwd);
  let sessionId: string | null = null;
  let streaming = false;
  // Marca si el turno en curso fue cancelado por el usuario: evita que el
  // `prompt` que resuelve después emita un segundo `message.complete` que
  // apagaría el indicador de un turno nuevo.
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

  // --- Notificaciones ACP (session/update) -> eventos de la UI ---
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

  // --- Petición de permiso del agente -> tarjeta de aprobación de la UI ---
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
      const currentName = lastModels.find((m) => m.modelId === currentId)?.name || 'Hermes';
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

  // --- Mensajes de la UI -> ACP ---
  ws.on('message', async (raw) => {
    let message: { command: string; text?: string; requestId?: string; approved?: boolean; modelId?: string };
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return; // mensaje no-JSON: ignorar
    }
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
          emit('error', { message: 'La sesión de Hermes aún no está lista.' });
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
        // Interrumpe el turno en curso (el usuario quiere aclarar/parar). El
        // `prompt` pendiente ya no emitirá su propio message.complete (cancelled).
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
      default:
        break;
    }
  });

  // Al cerrarse la pestaña / WebSocket: matar el subproceso de Hermes.
  ws.on('close', () => {
    client.dispose();
  });
}
