import { spawn, execFile, ChildProcess } from 'child_process';
import * as readline from 'readline';
import type {
  NewSessionResult,
  AcpSessionUpdate,
  AcpPermissionParams,
} from './acpTypes';

/**
 * Cliente del Agent Client Protocol (ACP) para hablar con `hermes acp`.
 *
 * ACP es JSON-RPC 2.0 sobre stdio, delimitado por líneas (NDJSON). El agente
 * (Hermes) no solo responde a nuestras peticiones: también nos envía
 * notificaciones (`session/update`) y peticiones entrantes (p. ej.
 * `session/request_permission`) que debemos contestar. Esta clase centraliza
 * ese transporte bidireccional y expone una API de alto nivel.
 *
 * NOTA DE PARIDAD: copia literal del transporte de la extensión de VS Code. Es
 * código Node puro (child_process + readline), sin dependencia del editor, así
 * que sirve igual para el wrapper web. Si se corrige un bug aquí, replicarlo en
 * `hermes-vscode-extension/src/acpClient.ts` (y viceversa).
 */

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

// Timeouts de las peticiones de CONTROL (deben ser rápidas). El turno
// (session/prompt) NO lleva timeout: puede ser largo y el usuario lo cancela
// con el botón Detener.
const CONTROL_TIMEOUT_MS = 60_000;
const SET_MODEL_TIMEOUT_MS = 30_000;

export type { NewSessionResult } from './acpTypes';

export class AcpClient {
  private readonly proc: ChildProcess;
  private readonly cwd: string;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  // Últimas líneas de stderr de Hermes, para diagnosticar fallos de arranque.
  private readonly stderrTail: string[] = [];

  private updateCb: ((update: AcpSessionUpdate) => void) | null = null;
  private permissionCb: ((requestId: number | string, params: AcpPermissionParams) => void) | null = null;
  private errorCb: ((message: string) => void) | null = null;
  private closeCb: ((code: number | null) => void) | null = null;

  constructor(hermesExe: string, cwd: string) {
    this.cwd = cwd;
    this.proc = spawn(hermesExe, ['acp'], { cwd, env: { ...process.env } });

    const rl = readline.createInterface({ input: this.proc.stdout!, terminal: false });
    rl.on('line', (line) => this.handleLine(line));

    this.proc.stderr!.on('data', (data) => {
      // stderr son logs humanos de Hermes; útiles para depurar, no son protocolo.
      const text = data.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          this.stderrTail.push(line);
          if (this.stderrTail.length > 20) {
            this.stderrTail.shift();
          }
        }
      }
      console.error(`[hermes acp] ${text}`);
    });

    this.proc.on('close', (code) => {
      for (const p of this.pending.values()) {
        p.reject(new Error('El proceso ACP de Hermes se cerró.'));
      }
      this.pending.clear();
      this.closeCb?.(code);
    });

    this.proc.on('error', (err) => {
      this.errorCb?.(`No se pudo lanzar Hermes ACP: ${err.message}`);
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // línea no-JSON (ruido): ignorar
    }

    const id = msg.id as number | string | undefined;

    // 1) Respuesta a una petición nuestra. Normalizamos el id por si Hermes lo
    //    devuelve como string ("3"): así la promesa nunca queda colgada.
    if (id !== undefined && (('result' in msg) || ('error' in msg))) {
      const numId = typeof id === 'number' ? id : Number(id);
      if (!Number.isNaN(numId) && this.pending.has(numId)) {
        const p = this.pending.get(numId)!;
        this.pending.delete(numId);
        if ('error' in msg && msg.error) {
          const e = msg.error as { message?: string };
          p.reject(new Error(e.message || JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
        return;
      }
    }

    // 2) Petición entrante del agente (method + id): hay que responder
    if (typeof msg.method === 'string' && id !== undefined) {
      if (msg.method === 'session/request_permission') {
        this.permissionCb?.(id, (msg.params as AcpPermissionParams) || {});
      } else {
        // Método del agente que no soportamos: responder error (forward-compat).
        // TODO: cuando ACP defina session/request_input (clarify/sudo/secret),
        // enrutarlo aquí hacia la UI en vez de rechazarlo.
        this.respond(id, undefined, { code: -32601, message: 'method not supported by client' });
      }
      return;
    }

    // 3) Notificación (method sin id)
    if (msg.method === 'session/update') {
      const params = (msg.params as Record<string, unknown>) || {};
      const update = (params.update as AcpSessionUpdate) || {};
      this.updateCb?.(update);
    }
  }

  private send(obj: unknown): void {
    this.proc.stdin!.write(JSON.stringify(obj) + '\n');
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`Tiempo de espera agotado en ${method} (${timeoutMs} ms).`));
          }
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => { if (timer) { clearTimeout(timer); } resolve(v); },
        reject: (e) => { if (timer) { clearTimeout(timer); } reject(e); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private respond(id: number | string, result: unknown, error?: { code: number; message: string }): void {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', id };
    if (error) {
      msg.error = error;
    } else {
      msg.result = result ?? null;
    }
    this.send(msg);
  }

  onSessionUpdate(cb: (update: AcpSessionUpdate) => void): void { this.updateCb = cb; }
  onPermissionRequest(cb: (requestId: number | string, params: AcpPermissionParams) => void): void { this.permissionCb = cb; }
  onError(cb: (message: string) => void): void { this.errorCb = cb; }
  onClose(cb: (code: number | null) => void): void { this.closeCb = cb; }

  /** Últimas líneas de stderr de Hermes (diagnóstico de fallos de arranque). */
  recentStderr(): string {
    return this.stderrTail.join('\n');
  }

  initialize(): Promise<unknown> {
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, CONTROL_TIMEOUT_MS);
  }

  async newSession(): Promise<NewSessionResult> {
    const res = (await this.request('session/new', { cwd: this.cwd, mcpServers: [] }, CONTROL_TIMEOUT_MS)) as NewSessionResult;
    return res;
  }

  prompt(sessionId: string, text: string): Promise<unknown> {
    // Sin timeout: un turno puede ser largo; se interrumpe con cancel().
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  /** Cambia el modelo de la sesión (método ACP session/set_model). */
  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.request('session/set_model', { sessionId, modelId }, SET_MODEL_TIMEOUT_MS);
  }

  cancel(sessionId: string): void {
    // session/cancel es una notificación (no espera respuesta) en ACP.
    this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  }

  /** Responde a una `session/request_permission` con el optionId elegido. */
  respondPermission(requestId: number | string, optionId: string): void {
    this.respond(requestId, { outcome: { outcome: 'selected', optionId } });
  }

  /** Cancela una `session/request_permission` (equivale a denegar sin opción). */
  cancelPermission(requestId: number | string): void {
    this.respond(requestId, { outcome: { outcome: 'cancelled' } });
  }

  dispose(): void {
    try {
      // En Windows, kill('SIGTERM') solo termina hermes.exe, no su árbol de
      // procesos (el python.exe del agente quedaría huérfano). taskkill /t mata
      // el árbol completo.
      if (process.platform === 'win32' && typeof this.proc.pid === 'number') {
        execFile('taskkill', ['/pid', String(this.proc.pid), '/t', '/f'], () => { /* ignorar errores: puede que ya esté muerto */ });
      }
      this.proc.stdin?.destroy();
      this.proc.stdout?.destroy();
      this.proc.stderr?.destroy();
      this.proc.kill('SIGTERM');
    } catch {
      // proceso ya muerto: nada que hacer
    }
  }
}
