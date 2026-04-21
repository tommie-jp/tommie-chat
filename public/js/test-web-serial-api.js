// ES module — type="module" でロードされる
import { serial as polyfillSerial } from './web-serial-polyfill.js';

const $ = (id) => document.getElementById(id);

// 自作スクロールバー: 対象要素 (pre) は overflow:hidden（ネイティブ scroll 機構を無効化して
// Chromium コンポジタの層昇格→Babylon canvas ゴースト焼き付きバグを回避）、scrollTop は JS で操作する。
// wheel / thumb drag の両方で対応、thumb 位置は表示時と appendToPre 後の syncThumb 呼び出しで同期。
const scrollbars = new Map(); // id -> { target, thumb, sync }
function setupFakeScrollbar(target, track, thumb) {
  const sync = () => {
    const ch = target.clientHeight;
    const sh = target.scrollHeight;
    const st = target.scrollTop;
    if (sh <= ch + 1) {
      thumb.style.display = 'none';
      return;
    }
    thumb.style.display = '';
    const trackH = track.clientHeight;
    const thumbH = Math.max(20, Math.round(trackH * ch / sh));
    const maxThumbTop = trackH - thumbH;
    const scrollRange = sh - ch;
    const thumbTop = scrollRange > 0 ? Math.round(st / scrollRange * maxThumbTop) : 0;
    thumb.style.height = thumbH + 'px';
    thumb.style.top = thumbTop + 'px';
  };
  target.addEventListener('wheel', (e) => {
    if (target.scrollHeight <= target.clientHeight + 1) return;
    e.preventDefault();
    target.scrollTop = Math.max(0, Math.min(target.scrollHeight - target.clientHeight,
      target.scrollTop + e.deltaY));
    sync();
  }, { passive: false });
  let dragging = false, startY = 0, startScroll = 0;
  thumb.addEventListener('pointerdown', (e) => {
    dragging = true; startY = e.clientY; startScroll = target.scrollTop;
    thumb.classList.add('dragging');
    thumb.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  thumb.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const ch = target.clientHeight;
    const sh = target.scrollHeight;
    const trackH = track.clientHeight;
    const thumbH = Math.max(20, Math.round(trackH * ch / sh));
    const maxThumbTop = Math.max(1, trackH - thumbH);
    const scrollRange = sh - ch;
    target.scrollTop = Math.max(0, Math.min(scrollRange, startScroll + dy * (scrollRange / maxThumbTop)));
    sync();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    thumb.classList.remove('dragging');
    try { thumb.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);
  // トラッククリックでページ単位ジャンプ
  track.addEventListener('pointerdown', (e) => {
    if (e.target !== track) return;
    const rect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const dir = e.clientY < thumbRect.top ? -1 : 1;
    target.scrollTop = Math.max(0, Math.min(target.scrollHeight - target.clientHeight,
      target.scrollTop + dir * target.clientHeight * 0.9));
    sync();
  });
  return { sync };
}
function initScrollbars() {
  document.querySelectorAll('.fake-sb').forEach((track) => {
    const targetId = track.dataset.target;
    const target = document.getElementById(targetId);
    const thumb = track.querySelector('.fake-sb-thumb');
    if (!target || !thumb) return;
    scrollbars.set(targetId, { target, thumb, ...setupFakeScrollbar(target, track, thumb) });
  });
}
function syncScrollbar(id) { scrollbars.get(id)?.sync(); }
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initScrollbars);
} else {
  initScrollbars();
}
// パネル自体のリサイズで clientHeight が変わる（serial-test-panel は resize: both）。
// ResizeObserver で wrap の寸法変化を監視して thumb 位置/高さを再計算する。
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => scrollbars.forEach((s) => s.sync()));
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.log-wrap').forEach((el) => ro.observe(el));
  });
}

// <pre> 要素への追記は単一テキストノードの nodeValue を伸ばすことで実現する（DOM ノード数を増やさず、textContent 全書き換えも避ける）
function preTextNode(el) {
  if (!el) return null;
  if (!el.firstChild) el.appendChild(document.createTextNode(''));
  return el.firstChild;
}
function appendToPre(el, text) {
  const n = preTextNode(el);
  if (n) n.nodeValue += text;
}
function getPreText(el) {
  return (el && el.firstChild) ? el.firstChild.nodeValue : '';
}
function clearPre(el) {
  const n = preTextNode(el);
  if (n) n.nodeValue = '';
}
// <pre> のログローテーション: 値が maxLen 超過で末尾 keepLen 分だけ残す（行頭で切る）
function rotatePre(el, maxLen, keepLen) {
  const n = el && el.firstChild;
  if (!n || n.nodeValue.length <= maxLen) return;
  const v = n.nodeValue;
  const cutFrom = v.length - keepLen;
  const nl = v.indexOf('\n', cutFrom);
  n.nodeValue = v.slice(nl >= 0 ? nl + 1 : cutFrom);
}
const LOG_MAX = 200000, LOG_KEEP = 150000;
const CONSOLE_MAX = 100000, CONSOLE_KEEP = 75000;

// 桁区切りカンマ（123456 → "123,456"）
const fmtComma = (n) => n.toLocaleString('en-US');

// 行番号（シリアル出力／コンソールログ 別カウンタ）
let serialLineNo = 0;
let consoleLineNo = 0;
const lineNumPrefix = (n) => n.toString().padStart(5, ' ') + ': ';

// 起動時に取得する「既に許可済みのポート数」。auto 判定で使う。
// 取得前は null、取得後は数値 / 取得エラー時は -1。
let nativeAuthorizedCount = null;
let polyfillAuthorizedCount = null;

// 選択中の API（auto/native/polyfill）に応じた serial 実装を返す
// auto の決定順（UA には頼らない）:
//   1. 既に許可済みのポートがある側を優先（native 優先、無ければ polyfill）
//   2. どちらも 0 のとき: navigator.serial があれば native
//   3. navigator.usb があれば polyfill
//   4. 最終フォールバック: native（後段でエラーを出す）
function resolveMode() {
  const sel = $('api')?.value || 'auto';
  if (sel !== 'auto') return sel;
  if ((nativeAuthorizedCount ?? 0) > 0) return 'native';
  if ((polyfillAuthorizedCount ?? 0) > 0) return 'polyfill';
  if ('serial' in navigator) return 'native';
  if ('usb' in navigator) return 'polyfill';
  return 'native';
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
  // コンソールログもバッチ化（logger 自身が高頻度で呼ばれてもメインスレッドを止めないため）
  // 1フレーム（rAF）ごとにまとめて flush
  let pendingConsole = '';
  let consoleFlushScheduled = false;
  // 表示中テキスト長をローカル変数で追跡し、nodeValue.length 読み取りを最小化する
  let consoleLen = 0;
  const flushConsole = () => {
    consoleFlushScheduled = false;
    const el = document.getElementById('console-log');
    if (!el || !pendingConsole) return;
    // 追記前に「末尾付近に居たか」を記録。末尾追従中のユーザだけ新着で自動スクロール、
    // 途中まで遡って読んでる最中のユーザは位置を保つ（一般的なログビューの挙動）。
    const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    appendToPre(el, pendingConsole);
    consoleLen += pendingConsole.length;
    pendingConsole = '';
    if (consoleLen > CONSOLE_MAX) {
      rotatePre(el, CONSOLE_MAX, CONSOLE_KEEP);
      consoleLen = getPreText(el).length;
    }
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
    syncScrollbar('console-log');
  };
  const writeToConsole = (tag, args) => {
    const lineOpt = document.getElementById('opt-line-number');
    const linePrefix = (lineOpt && lineOpt.checked) ? lineNumPrefix(++consoleLineNo) : '';
    const ts = new Date().toTimeString().slice(0, 8);
    pendingConsole += `${linePrefix}[${ts}][${tag}] ${fmt(args)}\n`;
    // 非アクティブタブで rAF が止まっている間に無限に膨らまないよう上限でトリム
    if (pendingConsole.length > CONSOLE_MAX) pendingConsole = pendingConsole.slice(-CONSOLE_KEEP);
    if (!consoleFlushScheduled) {
      consoleFlushScheduled = true;
      requestAnimationFrame(flushConsole);
    }
  };
  console.log = function () { writeToConsole('LOG', arguments); origLog(...arguments); };
  console.warn = function () { writeToConsole('WARN', arguments); origWarn(...arguments); };
  console.error = function () { writeToConsole('ERR', arguments); origError(...arguments); };
  window.addEventListener('error', (e) => writeToConsole('UNCAUGHT', [e.message, e.filename + ':' + e.lineno]));
  window.addEventListener('unhandledrejection', (e) => writeToConsole('UNHANDLED', [e.reason]));
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('clear-console');
    if (btn) btn.onclick = () => {
      clearPre(document.getElementById('console-log'));
      consoleLineNo = 0; consoleLen = 0;
      syncScrollbar('console-log');
    };
  });
})();

// 環境情報を起動時に出す
console.log('UA:', navigator.userAgent);
console.log('serial in navigator:', 'serial' in navigator);
console.log('usb in navigator:', 'usb' in navigator);
console.log('isSecureContext:', window.isSecureContext);

// 16進 4桁フォーマット（undefined の場合は '?'）
const hex4 = (n) => (n == null ? '?' : '0x' + n.toString(16).padStart(4, '0'));

// native SerialPort の詳細ダンプ。getInfo() が {} でも vid/pid の有無を分かりやすく出す
function dumpNativePort(p) {
  const info = (p && p.getInfo) ? p.getInfo() : {};
  const keys = Object.keys(info);
  return `vid=${hex4(info.usbVendorId)} pid=${hex4(info.usbProductId)} infoKeys=[${keys.join(',')}] raw=${JSON.stringify(info)}`;
}

// polyfill SerialPort は内部で USBDevice(this.device_) を持つので、そこから詳細を取る
function dumpPolyfillPort(p) {
  const info = (p && p.getInfo) ? p.getInfo() : {};
  const dev = p && p.device_;
  const devStr = dev
    ? ` productName="${dev.productName || ''}" manufacturerName="${dev.manufacturerName || ''}" serialNumber="${dev.serialNumber || ''}" usb=${dev.usbVersionMajor}.${dev.usbVersionMinor}.${dev.usbVersionSubminor} class=${dev.deviceClass}/${dev.deviceSubclass}/${dev.deviceProtocol} opened=${dev.opened}`
    : '';
  return `vid=${hex4(info.usbVendorId)} pid=${hex4(info.usbProductId)} raw=${JSON.stringify(info)}${devStr}`;
}

if (navigator.serial) {
  navigator.serial.getPorts().then((ports) => {
    nativeAuthorizedCount = ports.length;
    console.log('Native: 既に許可済みのポート数:', ports.length);
    ports.forEach((p, i) => console.log(`  native[${i}]: ${dumpNativePort(p)}`));
  }).catch((e) => { nativeAuthorizedCount = -1; console.warn('Native getPorts:', e); });
} else {
  nativeAuthorizedCount = 0;
}
polyfillSerial.getPorts().then((ports) => {
  polyfillAuthorizedCount = ports.length;
  console.log('Polyfill: 既に許可済みのポート数:', ports.length);
  ports.forEach((p, i) => console.log(`  polyfill[${i}]: ${dumpPolyfillPort(p)}`));
}).catch((e) => { polyfillAuthorizedCount = -1; console.warn('Polyfill getPorts:', e); });

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
  $('stats').textContent = `RX ${fmtComma(bytesRx)} bytes / TX ${fmtComma(bytesTx)} bytes / ${sec}s`;
}
setInterval(updateStats, 500);

function nowStamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' +
    String(d.getMilliseconds()).padStart(3, '0');
}

// 接続開始（connectedAt）からの相対時間 HH:MM:SS.mmm。未接続時は '--:--:--.---'
function relStamp() {
  if (!connectedAt) return '--:--:--.---';
  const ms = Math.max(0, Date.now() - connectedAt);
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const mill = ms % 1000;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(mill).padStart(3, '0')}`;
}

// タイムスタンプ接頭辞。select #opt-timestamp の値に応じて切替
function tsPrefix() {
  const mode = $('opt-timestamp').value;
  if (mode === 'clock') return `[${nowStamp()}] `;
  if (mode === 'relative') return `[${relStamp()}] `;
  return '';
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

// hexdump -C 風: 16 バイトごとに折返し、右側に ASCII 併記（非印字は '.'）。
// offset を渡すと左端に 8 桁の 16 進オフセット、中央に 8/8 の区切りギャップを挿入する（hexdump -C 互換スタイル）。
// 配列で返すので呼び出し側が 1 行ずつ emitLine してタイムスタンプ/行番号を付けられる。
function toHexAscii(bytes, offset) {
  const withOffset = offset != null;
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.subarray ? bytes.subarray(i, i + 16) : bytes.slice(i, i + 16);
    const hexs = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0'));
    let hex;
    if (withOffset) {
      const left = hexs.slice(0, 8).join(' ').padEnd(23, ' ');
      const right = hexs.slice(8).join(' ').padEnd(23, ' ');
      hex = `${left}  ${right}`;
    } else {
      hex = hexs.join(' ').padEnd(47, ' ');
    }
    const ascii = Array.from(chunk).map((b) => (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.').join('');
    const prefix = withOffset ? ((offset + i).toString(16).padStart(8, '0') + '  ') : '';
    lines.push(`${prefix}${hex}  |${ascii}|`);
  }
  return lines;
}

// シリアル出力のバッチ化: 受信は高頻度で発生するので、1フレーム（rAF）ごとにまとめて DOM に書き込む
let pendingLog = '';
let logFlushScheduled = false;
// 表示中テキスト長をローカル変数で追跡し、nodeValue.length 読み取りを最小化する
let logLen = 0;
function flushLog() {
  logFlushScheduled = false;
  const el = $('log');
  if (!el || !pendingLog) return;
  const autoscroll = $('opt-autoscroll').checked;

  appendToPre(el, pendingLog);
  logLen += pendingLog.length;
  pendingLog = '';

  // scrollHeight 読み取りは強制レイアウトを誘発する重い操作なので、ローテーションが
  // 発生する（＝スクロール位置の再計算が必要な）時だけ読むようにしてメモリ/CPU を節約する
  if (logLen <= LOG_MAX) {
    if (autoscroll) el.scrollTop = el.scrollHeight;
    syncScrollbar('log');
    return;
  }

  // ローテーションあり: 頭から削られた分だけ scrollTop を補正して表示位置を保つ
  const savedScrollTop = el.scrollTop;
  const heightBefore = el.scrollHeight;
  rotatePre(el, LOG_MAX, LOG_KEEP);
  logLen = getPreText(el).length;
  const heightAfter = el.scrollHeight;
  if (autoscroll) {
    el.scrollTop = heightAfter;
  } else {
    el.scrollTop = Math.max(0, savedScrollTop - (heightBefore - heightAfter));
  }
  syncScrollbar('log');
}
function appendLog(s) {
  if (!s) return;
  pendingLog += s;
  // 非アクティブタブで flush が遅延しても無制限に膨らまないよう上限でトリム
  if (pendingLog.length > LOG_MAX) pendingLog = pendingLog.slice(-LOG_KEEP);
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    requestAnimationFrame(flushLog);
  }
}

// SEND 行の出力。現在の Hex モードに合わせて受信と同じ書式で出し、受信との比較をしやすくする。
// hex-ascii-offset モードでは先頭行のオフセット欄を "SEND    " に置換する（8 文字で幅を合わせる）。
function emitSend(bytes, txt) {
  const hexMode = $('opt-hex').value;
  if (hexMode === 'hex') {
    emitLine('SEND  ' + toHex(bytes));
    return;
  }
  if (hexMode === 'hex-ascii') {
    const lines = toHexAscii(bytes);
    lines.forEach((line, i) => emitLine((i === 0 ? 'SEND  ' : '      ') + line));
    return;
  }
  if (hexMode === 'hex-ascii-offset') {
    const lines = toHexAscii(bytes, 0);
    if (lines.length > 0) lines[0] = 'SEND    ' + lines[0].slice(8);
    for (const line of lines) emitLine(line);
    return;
  }
  emitLine('[SEND] ' + JSON.stringify(txt));
}

function emitLine(line) {
  let prefix = '';
  if ($('opt-line-number').checked) prefix += lineNumPrefix(++serialLineNo);
  prefix += tsPrefix();
  appendLog(prefix + line + '\n');
}

// 非行バッファ時: チャンクが行をまたぐため、atLineStart を保持して行頭でのみ番号付与
let atLineStart = true;
function emitRaw(text) {
  const ts = tsPrefix();
  const ln = $('opt-line-number').checked;
  if (!ln) {
    appendLog(ts + text);
    return;
  }
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (atLineStart) {
      out += lineNumPrefix(++serialLineNo) + ts;
      atLineStart = false;
    }
    const nl = text.indexOf('\n', i);
    if (nl < 0) { out += text.slice(i); break; }
    out += text.slice(i, nl + 1);
    atLineStart = true;
    i = nl + 1;
  }
  appendLog(out);
}

function processIncoming(value) {
  bytesRx += value.length;

  const hexMode = $('opt-hex').value;
  if (hexMode === 'hex') {
    emitLine(toHex(value));
    return;
  }
  if (hexMode === 'hex-ascii') {
    for (const line of toHexAscii(value)) emitLine(line);
    return;
  }
  if (hexMode === 'hex-ascii-offset') {
    // 接続開始からの累積バイト数を offset に使う。bytesRx は processIncoming 冒頭で加算済みのため、今回チャンクの開始は bytesRx - value.length。
    const startOffset = bytesRx - value.length;
    for (const line of toHexAscii(value, startOffset)) emitLine(line);
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
  // バイナリ等で改行が来ない場合に lineBuffer が無限に膨らむのを防ぐ（4KB 超えたら確定出力）
  if (lineBuffer.length > 4096) {
    emitLine(lineBuffer);
    lineBuffer = '';
  }
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

// 直前に使ったポート参照（切断後も保持し、再接続でピッカーをスキップするため）
let lastPort = null;
let lastMode = '';

// 接続中ポートのラベル（vid/pid や productName）。COM 番号は Web Serial 仕様上取れない
function portLabel(p, mode) {
  const info = (p && p.getInfo) ? p.getInfo() : {};
  const vid = hex4(info.usbVendorId);
  const pid = hex4(info.usbProductId);
  const vidpid = `${vid}:${pid}`;
  if (mode === 'polyfill' && p && p.device_) {
    const name = p.device_.productName || '';
    return name ? `${name} [${vidpid}]` : vidpid;
  }
  return vidpid;
}

async function doConnect(useExisting) {
  const mode = resolveMode();
  const serial = getSerial();
  if (useExisting && lastPort) {
    port = lastPort;
    console.log('再接続: 既存ポートを再オープン');
  } else {
    console.log(`[${mode}] requestPort 呼び出し直前`);
    port = await serial.requestPort({});
    lastPort = port;
    console.log(`[${mode}] requestPort 成功:`, JSON.stringify(port.getInfo()));
  }
  const baud = parseInt($('baud').value, 10);
  console.log('port.open baudRate=', baud);
  await port.open({ baudRate: baud });
  console.log('port.open 成功');
  bytesRx = 0;
  bytesTx = 0;
  connectedAt = Date.now();
  lineBuffer = '';
  lastMode = mode;
  setStatus(`接続中 (${mode} / ${portLabel(port, mode)})`, 'connected');
  $('connect').disabled = true;
  $('disconnect').disabled = false;
  $('send').disabled = false;
  writer = port.writable.getWriter();
  abortRead = false;
  readLoop();
}

async function doDisconnect() {
  abortRead = true;
  try { if (reader) await reader.cancel(); } catch (e) { console.warn('reader cancel:', e); }
  try { if (writer) writer.releaseLock(); } catch (e) { console.warn('writer release:', e); }
  try { if (port) await port.close(); } catch (e) { console.warn('port close:', e); }
  port = null;
  reader = null;
  writer = null;
  // 切断後も、直前に接続していたポートの情報を状態欄に残しておく
  const label = lastPort ? ` (${lastMode} / ${portLabel(lastPort, lastMode)})` : '';
  setStatus('未接続' + label, 'disconnected');
  $('connect').disabled = false;
  $('disconnect').disabled = true;
  $('send').disabled = true;
}

$('connect').onclick = async () => {
  try { await doConnect(false); }
  catch (e) {
    console.error('connect 例外:', e);
    emitLine('[ERR] ' + e.name + ': ' + e.message);
    setStatus('エラー: ' + e.message, 'error');
  }
};

$('reconnect').onclick = async () => {
  try {
    if (port) await doDisconnect();
    await doConnect(true);
  } catch (e) {
    console.error('reconnect 例外:', e);
    emitLine('[ERR] ' + e.name + ': ' + e.message);
    setStatus('エラー: ' + e.message, 'error');
  }
};

$('disconnect').onclick = doDisconnect;

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

$('send').onclick = async () => {
  if (!writer) return;
  const eolMap = { crlf: '\r\n', lf: '\n', cr: '\r', none: '' };
  const eol = eolMap[$('send-eol').value] ?? '\r\n';
  const txt = $('send-text').value + eol;
  const bytes = new TextEncoder().encode(txt);
  await writer.write(bytes);
  bytesTx += bytes.length;
  emitSend(bytes, txt);
  $('send-text').value = '';
};

$('send-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('send').disabled) $('send').click();
});

$('clear').onclick = () => {
  clearPre($('log'));
  lineBuffer = '';
  pendingLog = '';
  logLen = 0;
  serialLineNo = 0;
  atLineStart = true;
  syncScrollbar('log');
};

// <pre> の内容をクリップボードへ。失敗時は選択範囲にしてフォールバック
async function copyPreToClipboard(btn, preEl) {
  const text = getPreText(preEl);
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1000);
  } catch (e) {
    console.warn('clipboard writeText:', e);
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(preEl);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}

$('copy-log').onclick = () => copyPreToClipboard($('copy-log'), $('log'));
$('copy-console').onclick = () => copyPreToClipboard($('copy-console'), $('console-log'));

$('opt-line-buffer').addEventListener('change', () => {
  flushLineBuffer();
});

// 行間切替（両 textarea に即反映）
function applyLineGap() {
  const v = $('opt-line-gap').value;
  $('log').style.lineHeight = v;
  $('console-log').style.lineHeight = v;
}
$('opt-line-gap').addEventListener('change', applyLineGap);
applyLineGap();
