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

// 画面内コンソール: シリアルテスト自身のログだけを #console-log に出す（Android リモートデバッグ無しでも
// 本機能の動作確認ができるように）。グローバル console.* はフックしない（index.html に埋め込んだ場合に
// nakama 等の無関係ログが混入するのを防ぐため）。ブラウザの devtools にも同じ内容が出るよう、
// slog/swarn/serror から origLog/origWarn/origError を同時に呼ぶ。
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);
const fmtArgs = (args) => Array.from(args).map((a) => {
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
  if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
  return String(a);
}).join(' ');
// コンソールログもバッチ化（高頻度呼び出しでメインスレッドを止めないため）。1フレーム毎に flush
let pendingConsole = '';
let consoleFlushScheduled = false;
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
  pendingConsole += `${linePrefix}[${ts}][${tag}] ${fmtArgs(args)}\n`;
  if (pendingConsole.length > CONSOLE_MAX) pendingConsole = pendingConsole.slice(-CONSOLE_KEEP);
  if (!consoleFlushScheduled) {
    consoleFlushScheduled = true;
    requestAnimationFrame(flushConsole);
  }
};
// モジュールローカルのログ関数。これ以降 slog/warn/error の呼び出しはすべて slog/swarn/serror に置換。
function slog(...args)   { writeToConsole('LOG',  args); origLog(...args); }
function swarn(...args)  { writeToConsole('WARN', args); origWarn(...args); }
function serror(...args) { writeToConsole('ERR',  args); origError(...args); }
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('clear-console');
  if (btn) btn.onclick = () => {
    clearPre(document.getElementById('console-log'));
    consoleLineNo = 0; consoleLen = 0;
    syncScrollbar('console-log');
  };
});

// 環境情報を起動時に出す
slog('UA:', navigator.userAgent);
slog('serial in navigator:', 'serial' in navigator);
slog('usb in navigator:', 'usb' in navigator);
slog('isSecureContext:', window.isSecureContext);

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
    slog('Native: 既に許可済みのポート数:', ports.length);
    ports.forEach((p, i) => slog(`  native[${i}]: ${dumpNativePort(p)}`));
  }).catch((e) => { nativeAuthorizedCount = -1; swarn('Native getPorts:', e); });
} else {
  nativeAuthorizedCount = 0;
}
polyfillSerial.getPorts().then((ports) => {
  polyfillAuthorizedCount = ports.length;
  slog('Polyfill: 既に許可済みのポート数:', ports.length);
  ports.forEach((p, i) => slog(`  polyfill[${i}]: ${dumpPolyfillPort(p)}`));
}).catch((e) => { polyfillAuthorizedCount = -1; swarn('Polyfill getPorts:', e); });

let port = null;
let reader = null;
let writer = null;
let abortRead = false;
let lineBuffer = '';
let bytesRx = 0;
let bytesTx = 0;
let connectedAt = 0;

// SerialReversiAdapter 向けの行通知。UI 用の opt-line-buffer 設定とは独立に、
// 受信ストリームを CR/LF/CRLF で分割して登録リスナに渡す (RUP v0.2 §5 受信側)。
const adapterLineListeners = new Set();
let adapterLineBuf = '';
let adapterFeedTimer = null; // §5 文字間 100ms タイムアウト用
function adapterFeed(text) {
  if (adapterLineListeners.size === 0) { adapterLineBuf = ''; return; }
  adapterLineBuf += text;
  // 文字間タイムアウト 100ms: 新しい文字が来るたびタイマー再セット。
  // 時間内に改行が来なかった分はパーサリセットとして破棄する (§5)
  if (adapterFeedTimer !== null) clearTimeout(adapterFeedTimer);
  adapterFeedTimer = setTimeout(() => {
    if (adapterLineBuf.length > 0) adapterLineBuf = '';
    adapterFeedTimer = null;
  }, 100);
  const parts = adapterLineBuf.split(/\r\n|\r|\n/);
  adapterLineBuf = parts.pop() ?? '';
  // バイナリ等で改行が来ない場合の暴走防止（80 バイト超で破棄・§6 の RX バッファ推奨値）
  if (adapterLineBuf.length > 256) adapterLineBuf = '';
  for (const line of parts) {
    if (line.length === 0) continue;
    for (const cb of adapterLineListeners) {
      try { cb(line); } catch (e) { swarn('adapter onLine cb:', e); }
    }
  }
}

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

// PI/PO 除外フィルタ。opt-replay-skip-pipo が ON なら text (ASCII) の先頭 2 文字が PI/PO の行を抑止。
// 以前は replay モード限定だったが、hex 系モードでも PI/PO の hex ダンプを抑止するため全モード共通化した。
function shouldSkipPipo(text) {
  if (!$('opt-replay-skip-pipo') || !$('opt-replay-skip-pipo').checked) return false;
  const head = text.slice(0, 2).toUpperCase();
  return head === 'PI' || head === 'PO';
}
// RX チャンクが単体で "PI\n" / "PO\n" のときだけ弾く簡易版。1 Hz ハートビートは単独チャンクで来るので実用上十分。
function shouldSkipPipoChunk(value) {
  if (!$('opt-replay-skip-pipo') || !$('opt-replay-skip-pipo').checked) return false;
  return value.length === 3 && value[0] === 0x50 && value[2] === 0x0a
         && (value[1] === 0x49 || value[1] === 0x4f);
}

// Replay モード: reversi_cpu.py --replay 用の "TX/RX <ascii>" 形式で 1 メッセージ 1 行を追記する。
// タイムスタンプは opt-timestamp 設定に従う (なし/時刻/相対)。行番号は常になし。
// reversi_cpu.py --replay 側でも 先頭の `[HH:MM:SS.mmm] ` を読み飛ばすのでそのまま貼って再生可能。
function emitReplayLine(kind, text) {
  if (!text) return;
  if (shouldSkipPipo(text)) return;
  appendLog(`${tsPrefix()}${kind} ${text}\n`);
}

// TX 行の出力。現在の Hex モードに合わせて受信と同じ書式で出し、受信との比較をしやすくする。
// hex-ascii-offset モードでは先頭行のオフセット欄を "TX      " に置換する（8 文字で幅を合わせる）。
// ラベルは replay モードの "TX"/"RX" と統一（2 文字 + 4 スペース = 6 文字幅で継続行と揃える）。
function emitSend(bytes, txt) {
  const hexMode = $('opt-hex').value;
  // PI/PO 除外は全モード共通で送信ログ抑止。実送信バイトは既に writer へ出てるので表示のみ抑える。
  if (shouldSkipPipo(txt)) return;
  if (hexMode === 'replay') {
    emitReplayLine('TX', txt.replace(/[\r\n]+$/g, ''));
    return;
  }
  if (hexMode === 'hex') {
    emitLine('TX    ' + toHex(bytes));
    return;
  }
  if (hexMode === 'hex-ascii') {
    const lines = toHexAscii(bytes);
    lines.forEach((line, i) => emitLine((i === 0 ? 'TX    ' : '      ') + line));
    return;
  }
  if (hexMode === 'hex-ascii-offset') {
    const lines = toHexAscii(bytes, 0);
    if (lines.length > 0) lines[0] = 'TX      ' + lines[0].slice(8);
    for (const line of lines) emitLine(line);
    return;
  }
  emitLine('[TX] ' + JSON.stringify(txt));
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
  const text = new TextDecoder().decode(value);
  emitIncomingLines(value);
  // Adapter への行通知は emitIncomingLines の後、盤面表示の前に挟む。
  // こうすると 「RX 行 → Adapter の # OK → 盤面」の順で出せる。
  if (adapterLineListeners.size > 0) {
    adapterFeed(text);
  }
  // 盤面表示は最後。Hex モードでも動くよう独立バッファで検出。
  checkBoardDisplay(text);
}

// ST BO<64char> を受信したら盤面を ASCII 表示する。表示オプション opt-board-display に従う。
// 0=空(.), 1=黒(B), 2=白(W)、64 文字 row-major (a1..h1, a2..h8) — 61-UARTプロトコル仕様.md §7
// 出力行は replay コメント形式 ("# " 接頭辞)。タイムスタンプ・行番号は付けない。
let boardLineBuf = '';
function checkBoardDisplay(text) {
  const cb = $('opt-board-display');
  if (!cb || !cb.checked) { boardLineBuf = ''; return; }
  boardLineBuf += text;
  const parts = boardLineBuf.split(/\r?\n/);
  boardLineBuf = parts.pop() ?? '';
  if (boardLineBuf.length > 512) boardLineBuf = '';
  for (const line of parts) {
    // §6.2 #11 BS<64char> が本流。ST BO<64> は v0.1 レガシー形式として受理。
    const mBs = line.match(/^BS([0-2]{64})$/);
    if (mBs) { renderBoardAscii(mBs[1]); continue; }
    const mLegacy = line.match(/ST\s+BO([0-2]{64})\b/);
    if (mLegacy) renderBoardAscii(mLegacy[1]);
  }
}

function renderBoardAscii(bo) {
  // opt-board-piece: 'bw' (黒=B / 白=W) または 'xo' (黒=X / 白=O)。空マスは常に '.'
  const pieceSel = $('opt-board-piece');
  const mode = pieceSel ? pieceSel.value : 'xo';
  const black = mode === 'bw' ? 'B' : 'X';
  const white = mode === 'bw' ? 'W' : 'O';
  appendLog('#     a b c d e f g h\n');
  for (let r = 0; r < 8; r++) {
    const cells = [];
    for (let c = 0; c < 8; c++) {
      const v = bo.charCodeAt(r * 8 + c) - 48; // '0'..'2'
      cells.push(v === 1 ? black : v === 2 ? white : '.');
    }
    appendLog(`#   ${r + 1} ${cells.join(' ')}\n`);
  }
}

function emitIncomingLines(value) {
  const hexMode = $('opt-hex').value;
  // PI/PO 除外は hex 系モードでも有効。単体チャンクが PI\n / PO\n のときに抑止する。
  // (1 Hz ハートビートは通常単独チャンクで到着するので実用上これで十分)
  if (shouldSkipPipoChunk(value)) return;
  if (hexMode === 'replay') {
    // 1 メッセージ 1 行 (LF 区切り)。複数行が 1 チャンクで来た場合も必ず分割する。
    lineBuffer += new TextDecoder().decode(value);
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    if (lineBuffer.length > 4096) lineBuffer = '';
    for (const line of lines) emitReplayLine('RX', line);
    return;
  }
  if (hexMode === 'hex') {
    emitLine('RX    ' + toHex(value));
    return;
  }
  if (hexMode === 'hex-ascii') {
    const lines = toHexAscii(value);
    lines.forEach((line, i) => emitLine((i === 0 ? 'RX    ' : '      ') + line));
    return;
  }
  if (hexMode === 'hex-ascii-offset') {
    // 接続開始からの累積バイト数を offset に使う。bytesRx は processIncoming 冒頭で加算済みのため、今回チャンクの開始は bytesRx - value.length。
    const startOffset = bytesRx - value.length;
    const lines = toHexAscii(value, startOffset);
    if (lines.length > 0) lines[0] = 'RX      ' + lines[0].slice(8);
    for (const line of lines) emitLine(line);
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
    emitLine('[RX] ' + JSON.stringify(lineBuffer));
    lineBuffer = '';
  }
  // split で \n が落ちているので JSON 表示時は付け直す（§4 送信側は LF のみ想定）
  for (const line of lines) emitLine('[RX] ' + JSON.stringify(line + '\n'));
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
    slog('再接続: 既存ポートを再オープン');
  } else {
    slog(`[${mode}] requestPort 呼び出し直前`);
    port = await serial.requestPort({});
    lastPort = port;
    slog(`[${mode}] requestPort 成功:`, JSON.stringify(port.getInfo()));
  }
  const baud = parseInt($('baud').value, 10);
  slog('port.open baudRate=', baud);
  await port.open({ baudRate: baud });
  slog('port.open 成功');
  bytesRx = 0;
  bytesTx = 0;
  connectedAt = Date.now();
  lineBuffer = '';
  adapterLineBuf = '';
  lastMode = mode;
  setStatus(`接続中 (${mode} / ${portLabel(port, mode)})`, 'connected');
  $('connect').disabled = true;
  $('disconnect').disabled = false;
  $('send').disabled = false;
  if ($('send-qt')) $('send-qt').disabled = false;
  writer = port.writable.getWriter();
  abortRead = false;
  readLoop();
}

async function doDisconnect() {
  abortRead = true;
  try { if (reader) await reader.cancel(); } catch (e) { swarn('reader cancel:', e); }
  try { if (writer) writer.releaseLock(); } catch (e) { swarn('writer release:', e); }
  try { if (port) await port.close(); } catch (e) { swarn('port close:', e); }
  port = null;
  reader = null;
  writer = null;
  // 切断後も、直前に接続していたポートの情報を状態欄に残しておく
  const label = lastPort ? ` (${lastMode} / ${portLabel(lastPort, lastMode)})` : '';
  setStatus('未接続' + label, 'disconnected');
  $('connect').disabled = false;
  $('disconnect').disabled = true;
  $('send').disabled = true;
  if ($('send-qt')) $('send-qt').disabled = true;
}

$('connect').onclick = async () => {
  try { await doConnect(false); }
  catch (e) {
    serror('connect 例外:', e);
    emitLine('[ERR] ' + e.name + ': ' + e.message);
    setStatus('エラー: ' + e.message, 'error');
  }
};

$('reconnect').onclick = async () => {
  try {
    if (port) await doDisconnect();
    await doConnect(true);
  } catch (e) {
    serror('reconnect 例外:', e);
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
    try { reader.releaseLock(); } catch (e) { swarn('reader release:', e); }
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

// QT (終了) ボタン: "QT\r\n" を送信して reversi_cpu.py の参考実装限定 QT ハンドラを発火させる
// (RUP プロトコル仕様には載らない参考実装限定コマンド)
if ($('send-qt')) {
  $('send-qt').onclick = async () => {
    if (!writer) return;
    const txt = 'QT\r\n';
    const bytes = new TextEncoder().encode(txt);
    await writer.write(bytes);
    bytesTx += bytes.length;
    emitSend(bytes, txt);
  };
}

// SerialReversiAdapter 用ブリッジ。接続中のシリアルポートへ任意文字列を送る最小 API。
// writer は接続/切断で差し替わるので毎回現在値を参照する。
// 改行は CR+LF (\r\n) を必須とする (RUP v0.2 §5)。
// 受信は onLine(cb) で 1 行ずつ受け取れる。UI の表示オプションに依存しない独立経路。
// Adapter から受信処理の結果 (OK/NG+理由) をログに差し込むためのフック。
// 全 Hex モードで "# ..." (コメント) として出す。reversi_cpu.py --replay 側で skip される書式なので、
// ログをそのままシナリオファイルに流用しても破綻しない。タイムスタンプ・行番号は付けない。
function emitAdapterStatus(text) {
  if (!text) return;
  appendLog('# ' + text + '\n');
}

window.__serialTestBridge = {
  isConnected() { return writer !== null; },
  async sendLine(text) {
    if (!writer) throw new Error('serial not connected');
    const txt = text + '\r\n';
    const bytes = new TextEncoder().encode(txt);
    await writer.write(bytes);
    bytesTx += bytes.length;
    emitSend(bytes, txt);
  },
  onLine(cb)  { if (typeof cb === 'function') adapterLineListeners.add(cb); },
  offLine(cb) { adapterLineListeners.delete(cb); },
  emitStatus(text) { emitAdapterStatus(text); },
};
// 後から起動するモジュール (SerialReversiAdapter) が attach できるよう通知
window.dispatchEvent(new Event('serialtestbridge-ready'));

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
    swarn('clipboard writeText:', e);
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
