import * as path from 'path';

/**
 * Localiza el binario de Hermes y su directorio de instalación.
 *
 * Por defecto usa la ruta de instalación estándar en Windows
 * (`%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`), la misma que
 * usa la extensión de VS Code. Se puede sobrescribir con la variable de entorno
 * `HERMES_EXE` (p. ej. para apuntar a un `hermes` del PATH en otro SO).
 */

/** Directorio raíz de la instalación de Hermes (repo + venv). */
export function resolveHermesHome(): string {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(userProfile, 'AppData', 'Local', 'hermes', 'hermes-agent');
}

/** Ruta absoluta al ejecutable `hermes` que habla ACP. */
export function resolveHermesExe(): string {
  if (process.env.HERMES_EXE) {
    return process.env.HERMES_EXE;
  }
  return path.join(resolveHermesHome(), 'venv', 'Scripts', 'hermes.exe');
}
