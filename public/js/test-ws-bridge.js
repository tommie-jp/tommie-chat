'use strict';

const $ = (id) => document.getElementById(id);

let ws = null;
let lineBuffer = '';
let bytesRx = 0;
let bytesTx = 0;
let connectedAt = 0;

// 画面内コンソール
(function installConsoleHook() {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const fmt = (args) => Array.from(args).map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
    return String(a);
  }).join(' ');
  const writeToLog = (tag, args) => {
    const el = document.getElementById('log');
    if (!el) return;
    el.value += `[${tag}] ${fmt(args)}\n`;
    if (document.getElementById('opt-autoscroll')?.checked) el.scrollTop = el.scrollHeight;
  };
  console.log = function () { writeToLog('LOG', arguments); origLog(...arguments); };
  console.warn = function () { writeToLog('WARN', arguments); origWarn(...arguments); };
  console.error = function () { writeToLog('ERR', arguments); origError(...arguments); };
  window.addEventListener('error', (e) => writeToLog('UNCAUGHT', [e.message, e.filename + ':' + e.lineno]));
  window.addEventListener('unhandledrejection', (e) => writeToLog('UNHANDLED', [e.reason]));
})();

console.log('UA:', navigator.userAgent);
console.log('isSecureContext:', window.isSecureContext);

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + cls;
}

function updateStats() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    $('stats').textContent = '';
    return;
  }
  const sec = ((Date.now() - connectedAt) / 1000).toFixed(1);
  $('stats').textContent = `RX ${bytesRx} bytes / TX ${bytesTx} bytes / ${sec}s`;
}
setInterval(updateStats, 500);

function nowStamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function appendLog(s) {
  if (!s) return;
  const el = $('log');
  el.value += s;
  if ($('opt-autoscroll').checked) el.scrollTop = el.scrollHeight;
}

function emitLine(line) {
  const prefix = $('opt-timestamp').checked ? `[${nowStamp()}] ` : '';
  appendLog(prefix + line + '\n');
}

function emitRaw(text) {
  const prefix = $('opt-timestamp').checked ? `[${nowStamp()}] ` : '';
  appendLog(prefix + text);
}

function processIncoming(buf) {
  const value = new Uint8Array(buf);
  bytesRx += value.length;

  if ($('opt-hex').checked) {
    emitLine(toHex(value));
    return;
  }

  const text = new TextDecoder().decode(value);

  if (!$('opt-line-buffer').checked) {
    emitRaw(text);
    return;
  }

  lineBuffer += text;
  const lines = lineBuffer.split(/\r?\n/);
  lineBuffer = lines.pop() || '';
  for (const line of lines) emitLine(line);
}

function flushLineBuffer() {
  if (lineBuffer) {
    emitLine(lineBuffer);
    lineBuffer = '';
  }
}

$('connect').onclick = () => {
  const url = $('ws-url').value.trim();
  console.log('WebSocket 接続:', url);
  try {
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
  } catch (e) {
    console.error('WebSocket 生成失敗:', e);
    setStatus('エラー: ' + e.message, 'error');
    return;
  }

  ws.onopen = () => {
    bytesRx = 0;
    bytesTx = 0;
    connectedAt = Date.now();
    lineBuffer = '';
    setStatus('接続中', 'connected');
    $('connect').disabled = true;
    $('disconnect').disabled = false;
    $('send').disabled = false;
    console.log('WebSocket OPEN');
  };

  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      processIncoming(ev.data);
    } else if (typeof ev.data === 'string') {
      const enc = new TextEncoder().encode(ev.data);
      processIncoming(enc.buffer);
    }
  };

  ws.onerror = (ev) => {
    console.error('WebSocket ERROR');
    setStatus('エラー（ブリッジ未起動の可能性）', 'error');
  };

  ws.onclose = (ev) => {
    flushLineBuffer();
    setStatus(`切断 (code=${ev.code})`, 'disconnected');
    $('connect').disabled = false;
    $('disconnect').disabled = true;
    $('send').disabled = true;
    ws = null;
    console.log('WebSocket CLOSE', ev.code, ev.reason);
  };
};

$('disconnect').onclick = () => {
  if (ws) ws.close();
};

$('send').onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const eolMap = { crlf: '\r\n', lf: '\n', cr: '\r', none: '' };
  const eol = eolMap[$('send-eol').value] ?? '\r\n';
  const txt = $('send-text').value + eol;
  const bytes = new TextEncoder().encode(txt);
  ws.send(bytes);
  bytesTx += bytes.length;
  emitLine('[SEND] ' + JSON.stringify(txt));
};

$('send-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('send').disabled) $('send').click();
});

$('clear').onclick = () => {
  $('log').value = '';
  lineBuffer = '';
};

$('opt-line-buffer').addEventListener('change', flushLineBuffer);
