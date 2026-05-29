// ===== Transporte: puente WebSocket hacia el servidor local =====
// La interfaz fue escrita para la extensión de VS Code, donde hablaba con la
// extensión vía `acquireVsCodeApi().postMessage`. Aquí emulamos esa misma API
// mínima sobre un WebSocket al backend Node: `vscode.postMessage` envía por el
// socket, y cada mensaje entrante se reinyecta como un evento 'message' del
// window. Así TODO el resto del código de la UI es idéntico al de la extensión:
// solo cambia el medio por el que viajan los mensajes.
//
// Reconexión: si el WebSocket se cae (servidor reiniciado, red, suspensión), el
// shim reconecta solo con backoff y avisa a la UI con `transport.down` /
// `transport.up`. NO se confunde con `subprocess.closed` (crash real de Hermes).
const vscode = (function () {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host;
  let ws = null;
  let ready = false;
  const outbox = [];
  let reconnectDelay = 500;

  function dispatch(data) {
    window.dispatchEvent(new MessageEvent('message', { data: data }));
  }

  function connect() {
    ws = new WebSocket(url);
    ws.addEventListener('open', function () {
      ready = true;
      reconnectDelay = 500;
      dispatch({ jsonrpc: '2.0', method: 'event', params: { type: 'transport.up' } });
      outbox.splice(0).forEach(function (m) { ws.send(m); });
    });
    ws.addEventListener('message', function (e) {
      let data;
      try { data = JSON.parse(e.data); } catch (_) { return; }
      dispatch(data);
    });
    ws.addEventListener('close', function () {
      ready = false;
      dispatch({ jsonrpc: '2.0', method: 'event', params: { type: 'transport.down' } });
      // Reconexión con backoff exponencial (tope 5 s).
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    });
    ws.addEventListener('error', function () { try { ws.close(); } catch (_) {} });
  }
  connect();

  return {
    postMessage: function (obj) {
      const data = JSON.stringify(obj);
      if (ready && ws && ws.readyState === WebSocket.OPEN) { ws.send(data); }
      else { outbox.push(data); }
    }
  };
})();

// Escapa texto para inyectarlo de forma segura en HTML (previene XSS cuando el
// dato viene del agente: nombres de herramienta, etc.). Mismo escape base que
// parseMarkdown.
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

// Solicita la cancelación del turno en curso. El backend ya gestiona el
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

// Envío del formulario (Enter o botón). En la extensión esto era un atributo
// onsubmit inline; aquí lo enlazamos por JS (más limpio y compatible con CSP).
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
  escaped = escaped.replace(/```([\s\S]*?)```/g, function (match, code) {
    return '<pre><code>' + code.trim() + '</code></pre>';
  });

  // Inline code
  escaped = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Bold text
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Newlines
  escaped = escaped.replace(/\n/g, '<br/>');

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

      case 'transport.down':
        // Se cayó la conexión con el servidor (no es un crash de Hermes). El
        // shim ya está reintentando; avisamos y bloqueamos el envío.
        setStatus('connecting', 'Reconectando…');
        input.disabled = true;
        sendBtn.disabled = true;
        activeTools.clear();
        hideActivity();
        exitSendMode();
        break;
      case 'transport.up':
        // Reconectado. El backend creará una sesión nueva y reemitirá
        // session.info, que rehabilitará la UI; aquí no hacemos nada más.
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
        // Solo retiramos esta herramienta del conjunto activo. El indicador lo
        // gestiona el flujo general (message.delta / status / complete); así, si
        // hay otra herramienta en marcha, no apagamos su feedback.
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
        // escapeHtml: el nombre de herramienta viene del agente (posible marcado).
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
                                '<section class="message-body" style="color: var(--rosa-600)">El subproceso de Hermes Agent se cerró con código ' + escapeHtml(exitCode) + '. Recarga la página para reiniciar.</section>';
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
