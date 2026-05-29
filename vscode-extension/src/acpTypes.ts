/**
 * Formas del Agent Client Protocol (ACP) que consumimos.
 *
 * Centraliza el tipado del protocolo para no esparcir aserciones `as` por el
 * código. La frontera real `unknown -> tipo` está en `AcpClient.handleLine`;
 * a partir de ahí los consumidores reciben datos ya tipados.
 *
 * IDÉNTICO en hermes-web y hermes-vscode-extension. Si cambias aquí, replica.
 */

/** Un modelo disponible en la sesión. */
export interface AcpModel {
  modelId: string;
  name?: string;
}

/** Estado de modelos devuelto por session/new. */
export interface AcpModelState {
  availableModels?: AcpModel[];
  currentModelId?: string;
}

/** Resultado de session/new. */
export interface NewSessionResult {
  sessionId: string;
  models?: AcpModelState;
  modes?: unknown;
}

/** Notificación session/update (su campo `update`). */
export interface AcpSessionUpdate {
  sessionUpdate?: string;
  content?: { text?: string };
  text?: string;
  title?: string;
  kind?: string;
  status?: string;
  toolCallId?: string;
  availableCommands?: unknown[];
  commands?: unknown[];
}

/** Herramienta dentro de una petición de permiso. */
export interface AcpToolCall {
  title?: string;
  kind?: string;
  toolCallId?: string;
  rawInput?: unknown;
}

/** Opción de una petición de permiso (allow_* / reject_*). */
export interface AcpPermissionOption {
  optionId?: string;
  kind?: string;
}

/** Params de session/request_permission. */
export interface AcpPermissionParams {
  toolCall?: AcpToolCall;
  options?: AcpPermissionOption[];
}
