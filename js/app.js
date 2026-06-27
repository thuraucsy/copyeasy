'use strict';

// ── Config ─────────────────────────────────────────
const CHUNK_SIZE   = 64 * 1024;   // 64 KB per chunk (safe for all browsers incl. iOS Safari)
const HIGH_WATER   = 512 * 1024;  // pause sending when WebRTC buffer exceeds 512 KB
const LOW_WATER    = 128 * 1024;  // resume as soon as buffer drains to 128 KB

// ── State ──────────────────────────────────────────
let peer = null;
let conn = null;
const receiving = {};        // fileId → { meta, chunks[] }
let currentRecvId = null;    // which file binary chunks currently belong to

// ── Helpers ────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.style.display = 'none';
    s.classList.remove('screen--active');
  });
  const el = $(id);
  el.style.display = 'flex';
  el.classList.add('screen--active');
}

function setStatus(state, text) {
  const badge = $('status-badge');
  badge.className = `badge badge--${state}`;
  $('status-text').textContent = text;
}

function showToast(msg, duration = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('toast--show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => {
    t.classList.remove('toast--show');
    setTimeout(() => t.classList.add('hidden'), 250);
  }, duration);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i ? 1 : 0)} ${sizes[i]}`;
}

function fileExt(name) {
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop().slice(0, 4) : 'file';
}

function generateShortId() {
  // 6 char alphanumeric, easy to type
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ── Speed / ETA display ────────────────────────────
function buildStatusText(pct, bytesDone, totalBytes, startTime) {
  const elapsed = (Date.now() - startTime) / 1000;
  if (elapsed < 0.3 || bytesDone === 0) return `${pct}%`;
  const speed = bytesDone / elapsed;           // bytes/s
  const remaining = totalBytes - bytesDone;
  const eta = speed > 0 ? remaining / speed : 0;
  const etaStr = eta > 2
    ? (eta < 60 ? ` · ${Math.round(eta)}s left` : ` · ${Math.floor(eta / 60)}m ${Math.round(eta % 60)}s left`)
    : '';
  return `${pct}% · ${formatBytes(speed)}/s${etaStr}`;
}

// ── Flow control ───────────────────────────────────
// Uses the bufferedamountlow event so we resume the instant the buffer drains
// to LOW_WATER — no polling delay. Falls back to a 1s timeout for safety.
function waitForBuffer() {
  const dc = conn?.dataChannel;
  if (!dc || dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise(resolve => {
    dc.bufferedAmountLowThreshold = LOW_WATER;
    const onDrain = () => { cleanup(); resolve(); };
    const fallback = setTimeout(() => { cleanup(); resolve(); }, 1000);
    function cleanup() {
      dc.removeEventListener('bufferedamountlow', onDrain);
      clearTimeout(fallback);
    }
    dc.addEventListener('bufferedamountlow', onDrain, { once: true });
  });
}

// ── QR Code ────────────────────────────────────────
function renderQR(text) {
  const container = $('qr-container');
  container.innerHTML = '';
  try {
    // QRCode is globally available via CDN script
    /* global QRCode */
    new QRCode(container, {
      text,
      width: 180,
      height: 180,
      colorDark: '#0F172A',
      colorLight: '#FFFFFF',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (e) {
    container.textContent = text;
  }
}

// ── PeerJS init ────────────────────────────────────
function initPeer() {
  /* global Peer */
  peer = new Peer(generateShortId(), {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    },
  });

  peer.on('open', (id) => {
    $('my-id-text').textContent = id;
    renderQR(id);
    setStatus('ready', 'Ready');
    showScreen('screen-ready');
    detectDragSupport();
  });

  peer.on('connection', (incoming) => {
    if (conn && conn.open) {
      incoming.on('open', () => incoming.close());
      return;
    }
    setupConn(incoming);
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    const msg = err.type === 'peer-unavailable'
      ? 'Device not found. Check the ID and try again.'
      : err.message || 'Connection error';
    showConnectError(msg);
    setStatus('error', 'Error');
  });

  peer.on('disconnected', () => {
    setStatus('connecting', 'Reconnecting…');
    peer.reconnect();
  });
}

// ── Connection handling ────────────────────────────
function setupConn(c) {
  conn = c;

  conn.on('open', () => {
    setStatus('connected', 'Connected');
    showScreen('screen-transfer');
    showToast('Connected! You can now send files.');
  });

  conn.on('data', (data) => {
    handleData(data);
  });

  conn.on('close', () => {
    conn = null;
    setStatus('ready', 'Ready');
    showScreen('screen-ready');
    showToast('Disconnected from other device.');
  });

  conn.on('error', (err) => {
    console.error('Connection error:', err);
    showToast('Connection error: ' + err.message);
  });
}

function connectToPeer(peerId) {
  const id = peerId.trim().toUpperCase();
  if (!id) return;

  showConnectError('');
  setStatus('connecting', 'Connecting…');

  const c = peer.connect(id, { reliable: true, serialization: 'binary' });
  setupConn(c);
}

// ── Receiving data ─────────────────────────────────
// PeerJS binary serialization decodes ArrayBuffer → Uint8Array on the receive side.
// We also guard against Blob (older Android WebView) and raw ArrayBuffer.
function handleData(data) {
  if (data instanceof ArrayBuffer) {
    handleBinaryChunk(new Uint8Array(data));
    return;
  }
  // Uint8Array / Buffer / any TypedArray — what PeerJS actually delivers
  if (ArrayBuffer.isView(data) && !(data instanceof DataView)) {
    handleBinaryChunk(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return;
  }
  if (data instanceof Blob) {
    data.arrayBuffer().then(buf => handleBinaryChunk(new Uint8Array(buf)));
    return;
  }
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'file-start': {
      currentRecvId = data.fileId;
      receiving[data.fileId] = {
        name: data.name,
        size: data.size,
        mimeType: data.mimeType || 'application/octet-stream',
        totalChunks: data.totalChunks,
        chunks: [],
        received: 0,
        bytesReceived: 0,
        startTime: Date.now(),
      };
      addReceiveItem(data.fileId, data.name, data.size);
      break;
    }
    case 'file-end': {
      finalizeReceive(data.fileId);
      currentRecvId = null;
      break;
    }
  }
}

function handleBinaryChunk(uint8) {
  if (!currentRecvId) return;
  const f = receiving[currentRecvId];
  if (!f) return;
  f.chunks.push(uint8);
  f.received++;
  f.bytesReceived += uint8.byteLength;
  updateReceiveProgress(currentRecvId, f.bytesReceived, f.size, f.startTime);
}

// ── Sending files ──────────────────────────────────
async function sendFiles(files) {
  for (const file of files) {
    await sendOneFile(file);
  }
}

async function sendOneFile(file) {
  if (!conn || !conn.open) return;

  const fileId = Math.random().toString(36).slice(2);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const itemEl = addSendItem(fileId, file.name, file.size);
  const startTime = Date.now();
  let bytesSent = 0;

  // Metadata as JSON object (no base64, no binary overhead)
  conn.send({
    type: 'file-start',
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    totalChunks,
  });

  // Prefetch the first chunk immediately
  let nextRead = file.slice(0, CHUNK_SIZE).arrayBuffer();

  for (let i = 0; i < totalChunks; i++) {
    // Await the already-in-flight read for this chunk
    const buffer = await nextRead;

    // Kick off the NEXT read immediately — overlaps with buffer wait + send
    if (i + 1 < totalChunks) {
      const s = (i + 1) * CHUNK_SIZE;
      nextRead = file.slice(s, s + CHUNK_SIZE).arrayBuffer();
    }

    // Back off only if buffer is saturated — fires instantly via bufferedamountlow
    await waitForBuffer();

    conn.send(buffer);
    bytesSent += buffer.byteLength;
    updateSendProgress(itemEl, bytesSent, file.size, startTime);
  }

  conn.send({ type: 'file-end', fileId });
  markSendDone(itemEl);
}

// ── UI: Send items ─────────────────────────────────
function addSendItem(fileId, name, size) {
  const queue = $('send-queue');
  queue.classList.remove('hidden');

  const el = document.createElement('div');
  el.className = 'file-item';
  el.id = `send-${fileId}`;
  el.innerHTML = `
    <div class="file-icon">${fileExt(name)}</div>
    <div class="file-info">
      <div class="file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="file-size">${formatBytes(size)}</div>
      <div class="file-progress"><div class="file-progress__fill" style="width:0%"></div></div>
      <div class="file-status">Sending…</div>
    </div>
  `;
  queue.appendChild(el);
  return el;
}

function updateSendProgress(itemEl, bytesDone, totalBytes, startTime) {
  const pct = Math.round((bytesDone / totalBytes) * 100);
  const bar = itemEl.querySelector('.file-progress__fill');
  const status = itemEl.querySelector('.file-status');
  if (bar) bar.style.width = `${pct}%`;
  if (status) status.textContent = buildStatusText(pct, bytesDone, totalBytes, startTime);
}

function markSendDone(itemEl) {
  const bar = itemEl.querySelector('.file-progress__fill');
  const status = itemEl.querySelector('.file-status');
  if (bar) { bar.style.width = '100%'; bar.classList.add('file-progress__fill--done'); }
  if (status) status.textContent = 'Sent ✓';
}

// ── UI: Receive items ──────────────────────────────
function addReceiveItem(fileId, name, size) {
  $('no-files-hint').classList.add('hidden');
  const list = $('received-list');

  const el = document.createElement('div');
  el.className = 'file-item';
  el.id = `recv-${fileId}`;
  el.innerHTML = `
    <div class="file-icon">${fileExt(name)}</div>
    <div class="file-info">
      <div class="file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="file-size">${formatBytes(size)}</div>
      <div class="file-progress"><div class="file-progress__fill" style="width:0%"></div></div>
      <div class="file-status">Receiving…</div>
    </div>
  `;
  list.appendChild(el);
}

function updateReceiveProgress(fileId, bytesDone, totalBytes, startTime) {
  const el = $(`recv-${fileId}`);
  if (!el) return;
  const pct = Math.round((bytesDone / totalBytes) * 100);
  const bar = el.querySelector('.file-progress__fill');
  const status = el.querySelector('.file-status');
  if (bar) bar.style.width = `${pct}%`;
  if (status) status.textContent = buildStatusText(pct, bytesDone, totalBytes, startTime);
}

function finalizeReceive(fileId) {
  const f = receiving[fileId];
  if (!f) return;

  const blob = new Blob(f.chunks, { type: f.mimeType });
  const url = URL.createObjectURL(blob);

  const el = $(`recv-${fileId}`);
  if (el) {
    const bar = el.querySelector('.file-progress__fill');
    const status = el.querySelector('.file-status');
    if (bar) { bar.style.width = '100%'; bar.classList.add('file-progress__fill--done'); }
    if (status) status.textContent = '';

    const actionEl = document.createElement('div');
    actionEl.className = 'file-action';

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    if (isIOS) {
      // iOS Safari: open in new tab (no programmatic download)
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'btn--download';
      a.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Open
      `;
      actionEl.appendChild(a);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.className = 'btn--download';
      a.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Save
      `;
      actionEl.appendChild(a);
    }

    el.appendChild(actionEl);
  }

  delete receiving[fileId];
  showToast(`Received: ${f.name}`);
}

// ── Drag & drop ────────────────────────────────────
function detectDragSupport() {
  const isTouchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (isTouchOnly) {
    $('drop-zone-hint').classList.add('hidden');
  }
}

function initDropZone() {
  const zone = $('drop-zone');
  const input = $('file-input');

  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') input.click();
  });

  // Desktop drag-and-drop
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drop-zone--over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop-zone--over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drop-zone--over');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) sendFiles(files);
  });

  input.addEventListener('change', () => {
    const files = Array.from(input.files);
    if (files.length) {
      sendFiles(files);
      input.value = ''; // reset so same file can be re-sent
    }
  });
}

// ── Error display ──────────────────────────────────
function showConnectError(msg) {
  const el = $('connect-error');
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ── Clipboard fallback (works on plain HTTP) ───────
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); showToast('ID copied!'); }
  catch (e) { showToast('Long-press the ID to copy manually.'); }
  document.body.removeChild(ta);
}

// ── XSS guard ──────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Wire up buttons ────────────────────────────────
function initUI() {
  // Copy my ID
  $('btn-copy-id').addEventListener('click', () => {
    const id = $('my-id-text').textContent;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(id)
        .then(() => showToast('ID copied!'))
        .catch(() => fallbackCopy(id));
    } else {
      fallbackCopy(id);
    }
  });

  // Connect button
  $('btn-connect').addEventListener('click', () => {
    connectToPeer($('peer-id-input').value);
  });

  $('peer-id-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectToPeer($('peer-id-input').value);
  });

  // Disconnect
  $('btn-disconnect').addEventListener('click', () => {
    if (conn) conn.close();
  });

  // Drop zone
  initDropZone();
}

// ── Boot ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initUI();
  showScreen('screen-init');
  setStatus('connecting', 'Starting…');

  // Small delay so CDN scripts finish loading
  setTimeout(() => {
    if (typeof Peer === 'undefined') {
      setStatus('error', 'Error');
      showToast('Failed to load networking library. Check your connection.', 4000);
      return;
    }
    initPeer();
  }, 300);
});
