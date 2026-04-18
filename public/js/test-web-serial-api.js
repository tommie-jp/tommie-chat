'use strict';

const $ = (id) => document.getElementById(id);

// 画面内コンソール（Android リモートデバッグ無しでも見れるように）
(function installConsoleHook() {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const fmt = (args) => Array.from(args).map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
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

// 環境情報を起動時に出す
console.log('UA:', navigator.userAgent);
console.log('serial in navigator:', 'serial' in navigator);
console.log('isSecureContext:', window.isSecureContext);
if (navigator.serial) {
  navigator.serial.getPorts().then((ports) => {
    console.log('既に許可済みのポート数:', ports.length);
    ports.forEach((p, i) => {
      const info = p.getInfo();
      console.log(`  port[${i}]:`, JSON.stringify(info));
    });
  }).catch((e) => console.warn('getPorts:', e));
}

let port = null;
let reader = null;
let writer = null;
let abortRead = false;
let lineBuffer = '';
let bytesRx = 0;
let bytesTx = 0;
let connectedAt = 0;

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + cls;
}

function updateStats() {
  if (!port) {
    $('stats').textContent = '';
    return;
  }
  const sec = ((Date.now() - connectedAt) / 1000).toFixed(1);
  $('stats').textContent = `RX ${bytesRx} bytes / TX ${bytesTx} bytes / ${sec}s`;
}
setInterval(updateStats, 500);

function nowStamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' +
    String(d.getMilliseconds()).padStart(3, '0');
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function appendLog(s) {
  if (!s) return;
  const el = $('log');
  el.value += s;
  if ($('opt-autoscroll').checked) el.scrollTop = el.scrollHeight;
}

function emitLine(line) {
  let prefix = '';
  if ($('opt-timestamp').checked) prefix = `[${nowStamp()}] `;
  appendLog(prefix + line + '\n');
}

function emitRaw(text) {
  let prefix = '';
  if ($('opt-timestamp').checked) prefix = `[${nowStamp()}] `;
  appendLog(prefix + text);
}

function processIncoming(value) {
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

if (!('serial' in navigator)) {
  setStatus('navigator.serial がありません（Web Serial API 非対応ブラウザ）', 'error');
  $('connect').disabled = true;
}

$('connect').onclick = async () => {
  try {
    console.log('requestPort 呼び出し直前');
    port = await navigator.serial.requestPort({});
    console.log('requestPort 成功:', JSON.stringify(port.getInfo()));
    const baud = parseInt($('baud').value, 10);
    console.log('port.open baudRate=', baud);
    await port.open({ baudRate: baud });
    console.log('port.open 成功');
    bytesRx = 0;
    bytesTx = 0;
    connectedAt = Date.now();
    lineBuffer = '';
    setStatus('接続中', 'connected');
    $('connect').disabled = true;
    $('disconnect').disabled = false;
    $('send').disabled = false;
    writer = port.writable.getWriter();
    abortRead = false;
    readLoop();
  } catch (e) {
    console.error('connect 例外:', e);
    emitLine('[ERR] ' + e.name + ': ' + e.message);
    setStatus('エラー: ' + e.message, 'error');
  }
};

async function readLoop() {
  reader = port.readable.getReader();
  try {
    while (!abortRead) {
      const { value, done } = await reader.read();
      if (done) break;
      processIncoming(value);
    }
  } catch (e) {
    emitLine('[READ ERR] ' + e.message);
  } finally {
    flushLineBuffer();
    try { reader.releaseLock(); } catch (e) { console.warn('reader release:', e); }
  }
}

$('disconnect').onclick = async () => {
  abortRead = true;
  try { if (reader) await reader.cancel(); } catch (e) { console.warn('reader cancel:', e); }
  try { if (writer) writer.releaseLock(); } catch (e) { console.warn('writer release:', e); }
  try { if (port) await port.close(); } catch (e) { console.warn('port close:', e); }
  port = null;
  reader = null;
  writer = null;
  setStatus('未接続', 'disconnected');
  $('connect').disabled = false;
  $('disconnect').disabled = true;
  $('send').disabled = true;
};

$('send').onclick = async () => {
  if (!writer) return;
  const eolMap = { crlf: '\r\n', lf: '\n', cr: '\r', none: '' };
  const eol = eolMap[$('send-eol').value] ?? '\r\n';
  const txt = $('send-text').value + eol;
  const bytes = new TextEncoder().encode(txt);
  await writer.write(bytes);
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

$('opt-line-buffer').addEventListener('change', () => {
  flushLineBuffer();
});
