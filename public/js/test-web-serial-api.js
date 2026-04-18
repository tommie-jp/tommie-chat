// ES module — type="module" でロードされる
import { serial as polyfillSerial } from './web-serial-polyfill.js';

const $ = (id) => document.getElementById(id);

// 選択中の API（auto/native/polyfill）に応じた serial 実装を返す
// auto: Android のみ polyfill（WebUSB）、その他は Native（Windows等で usbser.sys と取り合わない）
function resolveMode() {
  const sel = $('api')?.value || 'auto';
  if (sel !== 'auto') return sel;
  return /Android/i.test(navigator.userAgent) ? 'polyfill' : 'native';
}
function getSerial() {
  const mode = resolveMode();
  if (mode === 'native') {
    if (!('serial' in navigator)) throw new Error('navigator.serial 非対応');
    return navigator.serial;
  }
  if (!('usb' in navigator)) throw new Error('navigator.usb 非対応');
  return polyfillSerial;
}

// 画面内コンソール（Android リモートデバッグ無しでも見れるように）
// シリアル出力 (#log) とは別の textarea (#console-log) に表示する
(function installConsoleHook() {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const fmt = (args) => Array.from(args).map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
    return String(a);
  }).join(' ');
  const writeToConsole = (tag, args) => {
    const el = document.getElementById('console-log');
    if (!el) return;
    const ts = new Date().toTimeString().slice(0, 8);
    el.value += `[${ts}][${tag}] ${fmt(args)}\n`;
    el.scrollTop = el.scrollHeight;
  };
  console.log = function () { writeToConsole('LOG', arguments); origLog(...arguments); };
  console.warn = function () { writeToConsole('WARN', arguments); origWarn(...arguments); };
  console.error = function () { writeToConsole('ERR', arguments); origError(...arguments); };
  window.addEventListener('error', (e) => writeToConsole('UNCAUGHT', [e.message, e.filename + ':' + e.lineno]));
  window.addEventListener('unhandledrejection', (e) => writeToConsole('UNHANDLED', [e.reason]));
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('clear-console');
    if (btn) btn.onclick = () => { document.getElementById('console-log').value = ''; };
  });
})();

// 環境情報を起動時に出す
console.log('UA:', navigator.userAgent);
console.log('serial in navigator:', 'serial' in navigator);
console.log('usb in navigator:', 'usb' in navigator);
console.log('isSecureContext:', window.isSecureContext);
if (navigator.serial) {
  navigator.serial.getPorts().then((ports) => {
    console.log('Native: 既に許可済みのポート数:', ports.length);
    ports.forEach((p, i) => console.log(`  native[${i}]:`, JSON.stringify(p.getInfo())));
  }).catch((e) => console.warn('Native getPorts:', e));
}
polyfillSerial.getPorts().then((ports) => {
  console.log('Polyfill: 既に許可済みのポート数:', ports.length);
  ports.forEach((p, i) => console.log(`  polyfill[${i}]:`, JSON.stringify(p.getInfo())));
}).catch((e) => console.warn('Polyfill getPorts:', e));

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

if (!('serial' in navigator) && !('usb' in navigator)) {
  setStatus('Web Serial API も WebUSB も使えません', 'error');
  $('connect').disabled = true;
}

$('connect').onclick = async () => {
  try {
    const mode = resolveMode();
    console.log(`[${mode}] requestPort 呼び出し直前 (UA-detected)`);
    const serial = getSerial();
    port = await serial.requestPort({});
    console.log(`[${mode}] requestPort 成功:`, JSON.stringify(port.getInfo()));
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
