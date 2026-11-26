import { JENIS_TRANSAKSI } from './config.js';
import { escapeHtml } from './utils.js';
import * as rekeningModel from './models/rekening.js';

const VOICE_KEYWORDS = {
  pengeluaran: ['pengeluaran', 'beli', 'bayar', 'belanja', 'jajan', 'ongkos', 'keluar', 'pulsa', 'makan'],
  pemasukan: ['pemasukan', 'gaji', 'terima', 'dapat', 'bunga', 'masuk', 'refund', 'kembalian'],
  pindahBuku: ['pindah buku', 'transfer', 'kirim', 'pindah', 'mutasi'],
  numbers: [
    'nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan',
    'sepuluh', 'sebelas', 'seratus', 'seribu', 'puluh', 'belas', 'ratus', 'ribu', 'juta',
    'miliar', 'milyar', 'rupiah', 'sebesar', 'nominal', 'harga', 'jumlah', 'senilai'
  ],
  preps: ['dari', 'ke', 'di', 'pakai', 'untuk', 'dengan', 'menggunakan', 'masuk']
};

const VOICE_STYLE_ID = 'kasin-voice-styles';

const VOICE_STYLES = `
  #voice-fab {
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    z-index: 1040;
    box-shadow: 0 4px 12px rgba(var(--primary-rgb, 4, 165, 229), 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.3rem;
    cursor: pointer;
    border: none;
    background: linear-gradient(135deg, var(--primary-color, #04a5e5), var(--primary-color-alt, #209fb5));
    color: var(--white-color, #fbfbfb);
    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
  }

  #voice-fab:hover {
    transform: translateY(-3px) scale(1.05);
    box-shadow: 0 6px 16px rgba(var(--primary-rgb, 4, 165, 229), 0.45);
  }

  #voice-fab:active {
    transform: translateY(1px) scale(0.98);
  }

  #voice-fab.listening {
    background: linear-gradient(135deg, var(--red-color, #d20f39), var(--tertiary-color-alt, #e64553));
    box-shadow: 0 0 0 0 rgba(var(--red-rgb, 210, 15, 57), 0.7);
    animation: kasin-pulse-red 1.5s infinite;
  }

  @media (orientation: portrait) {
    #voice-fab {
      bottom: 112px;
    }
  }

  @keyframes kasin-pulse-red {
    0% {
      transform: scale(0.95);
      box-shadow: 0 0 0 0 rgba(var(--red-rgb, 210, 15, 57), 0.7);
    }
    70% {
      transform: scale(1);
      box-shadow: 0 0 0 15px rgba(var(--red-rgb, 210, 15, 57), 0);
    }
    100% {
      transform: scale(0.95);
      box-shadow: 0 0 0 0 rgba(var(--red-rgb, 210, 15, 57), 0);
    }
  }

  .voice-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(15, 15, 18, 0.75);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    z-index: 1060;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 1;
    transition: opacity 0.3s ease;
  }

  .voice-overlay.hide,
  #voice-feedback.hide,
  #voice-actions.hide,
  #voice-wave-container.hide {
    display: none !important;
  }

  .voice-overlay .voice-card {
    background: linear-gradient(145deg, rgba(40, 42, 50, 0.92), rgba(25, 26, 30, 0.96));
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-top: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 24px;
    padding: 28px;
    width: 92%;
    max-width: 420px;
    color: #fff;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .voice-overlay .voice-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .voice-overlay #voice-title {
    font-weight: 600;
    letter-spacing: 0.5px;
    background: linear-gradient(90deg, #fff, #aaa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .voice-overlay .voice-wave-container {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 8px;
    height: 70px;
    cursor: pointer;
    border-radius: 16px;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.05);
    transition: transform 0.2s cubic-bezier(0.25, 0.8, 0.25, 1), background-color 0.2s ease;
    padding: 10px;
    margin-top: 16px;
    margin-bottom: 4px;
  }

  .voice-overlay .voice-wave-container:hover {
    background: rgba(255, 255, 255, 0.05);
    transform: scale(1.02);
  }

  .voice-overlay .voice-wave-container.listening .voice-wave-bar {
    animation: kasin-voice-wave 1.2s infinite ease-in-out;
    box-shadow: 0 0 10px rgba(var(--primary-rgb, 4, 165, 229), 0.6);
  }

  .voice-overlay .voice-wave-bar {
    width: 6px;
    height: 12px;
    background-color: var(--primary-color, #04a5e5);
    border-radius: 6px;
    transition: height 0.3s ease, background-color 0.3s ease;
  }

  .voice-overlay .voice-wave-bar:nth-child(2) { animation-delay: 0.15s; }
  .voice-overlay .voice-wave-bar:nth-child(3) { animation-delay: 0.3s; }
  .voice-overlay .voice-wave-bar:nth-child(4) { animation-delay: 0.45s; }
  .voice-overlay .voice-wave-bar:nth-child(5) { animation-delay: 0.6s; }

  .voice-overlay .voice-transcript-container {
    background: rgba(0, 0, 0, 0.25);
    border-radius: 16px;
    min-height: 70px;
    max-height: 130px;
    overflow-y: auto;
    font-size: 1.1rem;
    line-height: 1.6;
    text-align: center;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: inset 0 4px 10px rgba(0, 0, 0, 0.1);
    position: relative;
  }

  .voice-overlay #voice-transcript {
    font-weight: 300;
    letter-spacing: 0.3px;
  }

  .voice-overlay .voice-status-feedback {
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    margin-top: 16px;
    max-height: 300px;
    overflow-y: auto;
  }

  .voice-overlay #voice-actions {
    margin-top: 20px;
  }

  .voice-overlay #voice-actions button {
    border-radius: 50rem;
    padding: 10px 20px;
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: 0.5px;
    transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .voice-overlay #voice-btn-cancel {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: #ddd;
  }

  .voice-overlay #voice-btn-cancel:hover {
    background: rgba(255, 255, 255, 0.2);
    color: #fff;
  }

  .voice-overlay #voice-btn-ok {
    background: linear-gradient(135deg, var(--green-color, #40a02b), #20c997);
    border: none;
    box-shadow: 0 6px 15px rgba(var(--green-rgb, 64, 160, 43), 0.3);
  }

  .voice-overlay #voice-btn-ok:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(var(--green-rgb, 64, 160, 43), 0.4);
  }

  @keyframes kasin-voice-wave {
    0%, 100% {
      height: 12px;
    }
    50% {
      height: 45px;
      background-color: var(--primary-color-alt, #209fb5);
    }
  }
`;

let voiceCallback = null;
let pendingVoiceData = null;
let cachedAccounts = [];
let sortedAccountsCache = [];
let descriptionStopWordsRegex = null;
let initialized = false;

/**
 * Convert Indonesian spoken number words into a numeric value.
 * @param {string} text
 * @returns {number}
 */
export function parseIndonesianWordsToNumber(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  function parseSubThousand(subWords) {
    const units = {
      nol: 0,
      satu: 1,
      dua: 2,
      tiga: 3,
      empat: 4,
      lima: 5,
      enam: 6,
      tujuh: 7,
      delapan: 8,
      sembilan: 9,
      sepuluh: 10,
      sebelas: 11,
      seratus: 100,
      seribu: 1000
    };

    let val = 0;
    for (let i = 0; i < subWords.length; i++) {
      const w = subWords[i];
      if (units[w] !== undefined) {
        val += units[w];
      } else if (w === 'puluh') {
        const lastToken = subWords[i - 1];
        if (lastToken && units[lastToken] !== undefined && units[lastToken] < 10) {
          val -= units[lastToken];
          val += units[lastToken] * 10;
        } else {
          val += 10;
        }
      } else if (w === 'belas') {
        const lastToken = subWords[i - 1];
        if (lastToken && units[lastToken] !== undefined && units[lastToken] < 10) {
          val -= units[lastToken];
          val += units[lastToken] + 10;
        } else {
          val += 11;
        }
      } else if (w === 'ratus') {
        const lastToken = subWords[i - 1];
        if (lastToken && units[lastToken] !== undefined && units[lastToken] < 10) {
          val -= units[lastToken];
          val += units[lastToken] * 100;
        } else {
          val += 100;
        }
      }
    }
    return val;
  }

  let total = 0;
  let tempWords = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'miliar' || w === 'milyar') {
      total += (parseSubThousand(tempWords) || 1) * 1000000000;
      tempWords = [];
    } else if (w === 'juta') {
      total += (parseSubThousand(tempWords) || 1) * 1000000;
      tempWords = [];
    } else if (w === 'ribu') {
      total += (parseSubThousand(tempWords) || 1) * 1000;
      tempWords = [];
    } else {
      tempWords.push(w);
    }
  }
  total += parseSubThousand(tempWords);
  return total;
}

function buildVoiceCaches(accounts = []) {
  const validAccounts = Array.isArray(accounts)
    ? accounts.filter((a) => a && typeof a.nama === 'string' && a.nama.trim())
    : [];

  const sorted = [...validAccounts].sort((a, b) => b.nama.length - a.nama.length);

  const stopWords = [
    ...VOICE_KEYWORDS.pengeluaran,
    ...VOICE_KEYWORDS.pemasukan,
    ...VOICE_KEYWORDS.pindahBuku,
    ...VOICE_KEYWORDS.numbers,
    ...VOICE_KEYWORDS.preps
  ];

  for (const acc of validAccounts) {
    stopWords.push(acc.nama.toLowerCase());
  }

  const escapedWords = stopWords.map((w) => w.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'));
  const regex = new RegExp(`\\b(${escapedWords.join('|')})\\b`, 'gi');

  return { sorted, regex };
}

function syncVoiceCachesFromState() {
  const { sorted, regex } = buildVoiceCaches(cachedAccounts);
  sortedAccountsCache = sorted;
  descriptionStopWordsRegex = regex;
}

async function refreshAccounts() {
  try {
    const rows = await rekeningModel.getAll();
    cachedAccounts = Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.warn('Voice: gagal memuat daftar rekening:', err);
    cachedAccounts = [];
  }
  syncVoiceCachesFromState();
}

/**
 * Parse a spoken Indonesian transaction phrase into structured fields.
 * @param {string} rawText
 * @param {Array} [accounts]
 */
export function parseVoiceInput(rawText, accounts) {
  let sortedAccounts = sortedAccountsCache;
  let stopWordsRegex = descriptionStopWordsRegex;

  if (Array.isArray(accounts)) {
    const built = buildVoiceCaches(accounts);
    sortedAccounts = built.sorted;
    stopWordsRegex = built.regex;
  } else if (!stopWordsRegex) {
    syncVoiceCachesFromState();
    sortedAccounts = sortedAccountsCache;
    stopWordsRegex = descriptionStopWordsRegex;
  }

  let text = String(rawText || '').toLowerCase().trim();

  // Pre-clean "rp" or "rp." that speech-to-text might glue to numbers
  text = text.replace(/\brp\s*\.?/gi, ' ');

  // 1. Transaction Type Detection
  let jenis = JENIS_TRANSAKSI[0]; // Default Pengeluaran
  if (VOICE_KEYWORDS.pindahBuku.some((k) => text.includes(k))) {
    jenis = JENIS_TRANSAKSI[2];
  } else if (VOICE_KEYWORDS.pemasukan.some((k) => text.includes(k))) {
    jenis = JENIS_TRANSAKSI[1];
  }

  // 2. Account Matching
  let rekSumber = null;
  let rekMasuk = null;

  if (sortedAccounts && sortedAccounts.length > 0) {
    if (jenis === JENIS_TRANSAKSI[2]) {
      const matchDari = text.match(/dari\s+([a-z0-9\s]+)/i);
      const matchKe = text.match(/(?:ke|masuk(?:\s+ke)?)\s+([a-z0-9\s]+)/i);

      if (matchDari) {
        rekSumber = sortedAccounts.find((r) => matchDari[1].includes(r.nama.toLowerCase())) || null;
      }
      if (matchKe) {
        rekMasuk = sortedAccounts.find((r) => matchKe[1].includes(r.nama.toLowerCase())) || null;
      }

      if (!rekSumber || !rekMasuk) {
        const foundAccounts = sortedAccounts.filter((r) => text.includes(r.nama.toLowerCase()));
        if (!rekSumber && foundAccounts.length >= 1) rekSumber = foundAccounts[0];
        if (!rekMasuk && foundAccounts.length >= 2) rekMasuk = foundAccounts[1];
      }
    } else {
      const matchedRek = sortedAccounts.find((r) => text.includes(r.nama.toLowerCase())) || null;
      if (matchedRek) {
        if (jenis === JENIS_TRANSAKSI[1]) {
          rekMasuk = matchedRek;
        } else {
          rekSumber = matchedRek;
        }
      }
    }
  }

  // 3. Amount / Nominal Extraction
  let nominalVal = 0;
  const digitRegex = /(\d+(?:[.,]\d+)*)\s*(ribu|juta|miliar|milyar)?/gi;
  let match;
  let lastDigitMatch = null;

  while ((match = digitRegex.exec(text)) !== null) {
    lastDigitMatch = match;
  }

  if (lastDigitMatch) {
    let parsedVal = parseFloat(lastDigitMatch[1].replace(/\./g, '').replace(',', '.'));
    const multiplier = lastDigitMatch[2]?.toLowerCase();

    if (multiplier) {
      if (multiplier === 'ribu') parsedVal *= 1000;
      else if (multiplier === 'juta') parsedVal *= 1000000;
      else if (multiplier === 'miliar' || multiplier === 'milyar') parsedVal *= 1000000000;
    }

    if (!Number.isNaN(parsedVal) && parsedVal > 0) {
      nominalVal = parsedVal;
    }
  }

  if (!nominalVal) {
    nominalVal = parseIndonesianWordsToNumber(text) || 0;
  }

  // 4. Rutin and Kelompok Extraction
  const isRutin = text.includes('rutin') && !text.includes('non rutin');
  let kelompok = null;

  const kelompokMatch = text.match(/\bkelompok\s+([a-z0-9\s]+)/i);
  if (kelompokMatch) {
    kelompok = kelompokMatch[1].trim();
    text = text.replace(kelompokMatch[0], '');
  } else if (isRutin) {
    const rutinMatch = text.match(/\brutin\s+([a-z0-9]+\s+[a-z0-9]+|[a-z0-9]+)\b/i);
    if (rutinMatch) {
      const candidate = rutinMatch[1].trim();
      const isStopWord = [
        ...VOICE_KEYWORDS.pengeluaran,
        ...VOICE_KEYWORDS.pemasukan,
        ...VOICE_KEYWORDS.preps
      ].some((w) => candidate.includes(w));

      if (!isStopWord) {
        kelompok = candidate;
        text = text.replace(kelompok, '');
      }
    }
  }

  text = text.replace(/non rutin|rutin/gi, '');

  // 5. Description (Barang) Extraction
  let barang = text;
  if (stopWordsRegex) {
    barang = barang.replace(stopWordsRegex, '');
  }

  barang = barang.replace(/(\d+(?:[.,]\d+)*)\s*(ribu|juta|miliar|milyar)?/gi, '');
  barang = barang.replace(/\s+/g, ' ').trim();
  barang = barang.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');

  if (barang.length > 0) {
    barang = barang.charAt(0).toUpperCase() + barang.slice(1);
  } else {
    barang = jenis === JENIS_TRANSAKSI[2] ? 'Pindah Buku' : jenis;
  }

  return {
    jenis,
    barang,
    nominal: nominalVal,
    rekSumber,
    rekMasuk,
    isRutin,
    kelompok
  };
}

/**
 * Show or hide the Voice Input FAB (only visible on #/record when SpeechRecognition is supported).
 * @param {boolean} visible
 */
export function setVoiceVisible(visible) {
  const fab = document.getElementById('voice-fab');
  const overlay = document.getElementById('voice-overlay');
  const supported = Boolean(
    typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)
  );
  if (fab) {
    fab.classList.toggle('d-none', !(visible && supported));
  }
  if (!visible && overlay) {
    overlay.classList.add('hide');
  }
}

/**
 * Register or clear the active voice callback (used by the record view).
 * Automatically shows the Voice FAB when registered and hides it when cleared.
 * @param {((parsed: object) => void | Promise<void>) | null} fn
 */
export function setVoiceCallback(fn) {
  voiceCallback = typeof fn === 'function' ? fn : null;
  setVoiceVisible(Boolean(voiceCallback));
}

/**
 * Consume and clear any pending voice data captured before navigating to #/record.
 * @returns {object | null}
 */
export function consumePendingVoiceData() {
  const data = pendingVoiceData;
  pendingVoiceData = null;
  return data;
}

function injectVoiceDOM() {
  if (!document.getElementById(VOICE_STYLE_ID)) {
    const styleEl = document.createElement('style');
    styleEl.id = VOICE_STYLE_ID;
    styleEl.textContent = VOICE_STYLES;
    document.head.appendChild(styleEl);
  }

  if (!document.getElementById('voice-fab')) {
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'voice-fab';
    fab.className = 'btn btn-primary d-none';
    fab.title = 'Input Suara';
    fab.setAttribute('aria-label', 'Input Suara');
    fab.innerHTML = '<i class="fas fa-microphone"></i>';
    document.body.appendChild(fab);
  }

  if (!document.getElementById('voice-overlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'voice-overlay';
    overlay.className = 'voice-overlay hide';
    overlay.innerHTML = `
      <div class="voice-card">
        <div class="voice-header">
          <h5 class="mb-0" id="voice-title">Mendengarkan...</h5>
          <button type="button" id="voice-close" class="btn-close btn-close-white" aria-label="Tutup" style="opacity: 0.7;"></button>
        </div>

        <div class="voice-transcript-container p-3">
          <p id="voice-transcript" class="mb-0 text-muted fst-italic">Mulai berbicara...</p>
        </div>

        <div class="voice-status-feedback hide p-3" id="voice-feedback"></div>

        <div class="voice-wave-container" id="voice-wave-container" title="Klik untuk lanjut, klik ganda untuk ulang">
          <div class="voice-wave-bar"></div>
          <div class="voice-wave-bar"></div>
          <div class="voice-wave-bar"></div>
          <div class="voice-wave-bar"></div>
          <div class="voice-wave-bar"></div>
        </div>

        <div id="voice-actions" class="d-flex justify-content-between gap-3 hide">
          <button type="button" id="voice-btn-cancel" class="btn w-50">
            <i class="fas fa-times"></i> Batal
          </button>
          <button type="button" id="voice-btn-ok" class="btn w-50 text-white">
            <i class="fas fa-check"></i> Terapkan
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
}

/**
 * Initialize the Voice Input FAB, overlay, SpeechRecognition handler, and account cache.
 */
export function initVoice() {
  if (initialized) return;
  initialized = true;

  injectVoiceDOM();
  refreshAccounts();
  window.addEventListener('kasin:db-updated', refreshAccounts);

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voiceFab = document.querySelector('#voice-fab');
  const voiceOverlay = document.querySelector('#voice-overlay');
  const voiceClose = document.querySelector('#voice-close');
  const voiceTranscript = document.querySelector('#voice-transcript');
  const voiceFeedback = document.querySelector('#voice-feedback');
  const voiceTitle = document.querySelector('#voice-title');
  const voiceWaveContainer = document.querySelector('#voice-wave-container');
  const voiceActions = document.querySelector('#voice-actions');
  const voiceBtnCancel = document.querySelector('#voice-btn-cancel');
  const voiceBtnOk = document.querySelector('#voice-btn-ok');

  if (!voiceFab || !voiceOverlay) return;

  if (!SpeechRecognition) {
    voiceFab.classList.add('d-none');
    return;
  }
  setVoiceVisible(Boolean(voiceCallback));

  let recognizing = false;
  let isStarting = false;
  let lastParsedData = null;
  let accumulatedTranscript = '';
  let sessionFinalTranscript = '';

  const recognition = new SpeechRecognition();
  recognition.lang = 'id-ID';
  recognition.continuous = false;
  recognition.interimResults = true;

  function startRecognition() {
    if (recognizing || isStarting) return;
    try {
      isStarting = true;
      recognition.start();
    } catch (err) {
      console.error('Voice recognition start error:', err);
      isStarting = false;
    }
  }

  function stopRecognition() {
    try {
      recognition.stop();
    } catch {
      // Ignore stop errors when not active
    }
    recognizing = false;
    isStarting = false;
  }

  function showParsedFeedback(parsed) {
    if (!parsed) return;

    const formatRow = (icon, iconColor, label, val, { isHighlight = false, isTrustedHtml = false } = {}) => {
      if (!val) return '';
      const valStyle = isHighlight
        ? 'color: var(--primary-color, #04a5e5); font-weight: 800; font-size: 1.15rem; text-shadow: 0 0 10px rgba(var(--primary-rgb, 4, 165, 229), 0.3);'
        : 'color: #f8f9fa; font-weight: 500; font-size: 0.95rem;';
      const safeVal = isTrustedHtml ? val : escapeHtml(val);

      return `
        <div class="d-flex justify-content-between align-items-center bg-dark p-2 px-3 rounded-3" style="background: rgba(0,0,0,0.3) !important;">
          <div class="text-white-50 small d-flex align-items-center gap-2" style="font-size: 0.85rem;">
            <i class="fas ${icon} fa-fw text-${iconColor}"></i> ${escapeHtml(label)}
          </div>
          <div class="text-end text-wrap text-break" style="${valStyle} max-width: 60%; line-height: 1.2;">
            ${safeVal}
          </div>
        </div>
      `;
    };

    const formatAccountRow = (icon, label, rek) => {
      if (rek && rek.nama) {
        return formatRow(icon, 'secondary', label, rek.nama.toUpperCase());
      }
      const warningHtml = '<span class="text-danger fst-italic" style="font-size: 0.85rem;"><i class="fas fa-exclamation-triangle"></i> Belum disebutkan</span>';
      return formatRow(icon, 'danger', label, warningHtml, { isTrustedHtml: true });
    };

    let html = `
      <div class="d-flex align-items-center mb-3 pb-2" style="border-bottom: 1px solid rgba(255,255,255,0.08);">
        <i class="fas fa-bolt text-warning me-2 fs-5"></i>
        <h6 class="mb-0 fw-bold text-white" style="letter-spacing: 0.5px;">Hasil Deteksi</h6>
      </div>
      <div class="d-flex flex-column gap-2">
    `;

    const typeColor = parsed.jenis === JENIS_TRANSAKSI[1]
      ? 'success'
      : parsed.jenis === JENIS_TRANSAKSI[2]
        ? 'warning'
        : 'danger';
    const typeIcon = parsed.jenis === JENIS_TRANSAKSI[1]
      ? 'fa-arrow-circle-down'
      : parsed.jenis === JENIS_TRANSAKSI[2]
        ? 'fa-exchange-alt'
        : 'fa-arrow-circle-up';

    html += formatRow(typeIcon, typeColor, 'Tipe', parsed.jenis);
    html += formatRow('fa-tag', 'info', 'Barang', parsed.barang);

    if (parsed.nominal > 0) {
      const formattedNominal = new Intl.NumberFormat('id-ID').format(parsed.nominal);
      html += formatRow('fa-money-bill-wave', 'success', 'Nominal', `Rp. ${formattedNominal}`, { isHighlight: true });
    }

    if (parsed.jenis === JENIS_TRANSAKSI[2]) {
      html += formatAccountRow('fa-wallet', 'Sumber', parsed.rekSumber);
      html += formatAccountRow('fa-piggy-bank', 'Masuk', parsed.rekMasuk);
    } else if (parsed.jenis === JENIS_TRANSAKSI[1]) {
      html += formatAccountRow('fa-piggy-bank', 'Masuk Ke', parsed.rekMasuk);
    } else {
      html += formatAccountRow('fa-wallet', 'Sumber', parsed.rekSumber);
    }

    if (parsed.isRutin) {
      html += formatRow('fa-sync-alt', 'primary', 'Rutin', 'Ya');
    }
    if (parsed.kelompok) {
      html += formatRow('fa-folder-open', 'primary', 'Kelompok', parsed.kelompok);
    }

    html += '</div>';

    voiceFeedback.innerHTML = html;
    voiceFeedback.classList.remove('hide');
  }

  function resetVoiceUI() {
    voiceTitle.textContent = 'Mendengarkan...';
    voiceTranscript.textContent = 'Mulai berbicara...';
    voiceTranscript.classList.add('text-muted');
    voiceFeedback.innerHTML = '';
    voiceFeedback.classList.add('hide');
    voiceActions.classList.add('hide');
    voiceWaveContainer.classList.remove('hide');
    lastParsedData = null;
    accumulatedTranscript = '';
    sessionFinalTranscript = '';
  }

  let voicePopover = null;
  if (window.bootstrap?.Popover) {
    voicePopover = new window.bootstrap.Popover(voiceFab, {
      trigger: 'hover',
      placement: 'left',
      html: true,
      title: 'Format Input Suara',
      content: `
        <div style="font-size: 0.85rem; line-height: 1.4; max-width: 250px;">
          Coba ucapkan:<br>
          &bull; <strong>Pengeluaran:</strong> <em>"beli kopi lima belas ribu pakai gopay"</em><br>
          &bull; <strong>Pemasukan:</strong> <em>"gaji bulanan lima juta masuk mandiri"</em><br>
          &bull; <strong>Pindah Buku:</strong> <em>"transfer dari gopay ke dompet seratus ribu"</em>
        </div>
      `
    });
  }

  recognition.onstart = () => {
    recognizing = true;
    isStarting = false;
    if (voicePopover) voicePopover.hide();
    voiceFab.classList.add('listening');
    voiceOverlay.classList.remove('hide');
    voiceWaveContainer.classList.add('listening');
    voiceTitle.textContent = 'Mendengarkan...';
  };

  recognition.onerror = (event) => {
    console.error('Voice recognition error:', event.error);
    isStarting = false;
    if (event.error === 'not-allowed') {
      voiceTranscript.textContent = 'Izin mikrofon ditolak.';
    } else if (event.error === 'no-speech') {
      voiceTranscript.textContent = 'Tidak terdengar suara.';
    } else {
      voiceTranscript.textContent = `Kesalahan: ${event.error}`;
    }
    setTimeout(() => {
      if (!lastParsedData && !recognizing) {
        voiceOverlay.classList.add('hide');
        voiceFab.classList.remove('listening');
      }
    }, 2000);
  };

  recognition.onend = () => {
    recognizing = false;
    isStarting = false;
    voiceFab.classList.remove('listening');
    voiceWaveContainer.classList.remove('listening');

    accumulatedTranscript = `${accumulatedTranscript} ${sessionFinalTranscript}`.replace(/\s+/g, ' ').trim();
    sessionFinalTranscript = '';

    if (lastParsedData) {
      voiceTitle.textContent = 'Hasil Analisis';
    } else {
      voiceTitle.textContent = 'Bicara Terhenti (Klik wave untuk lanjut)';
    }
  };

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = 0; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    sessionFinalTranscript = finalTranscript;

    const currentText = `${accumulatedTranscript} ${finalTranscript} ${interimTranscript}`.replace(/\s+/g, ' ').trim();
    voiceTranscript.textContent = currentText || 'Mendengarkan...';
    voiceTranscript.classList.remove('text-muted');

    if (currentText) {
      lastParsedData = parseVoiceInput(currentText);
      showParsedFeedback(lastParsedData);
      voiceActions.classList.remove('hide');
    }
  };

  voiceWaveContainer.addEventListener('click', () => {
    startRecognition();
  });

  voiceWaveContainer.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    stopRecognition();
    resetVoiceUI();
    setTimeout(() => {
      startRecognition();
    }, 300);
  });

  voiceFab.addEventListener('click', () => {
    if (voicePopover) voicePopover.hide();
    if (recognizing || isStarting) {
      stopRecognition();
    } else {
      if (voiceOverlay.classList.contains('hide')) {
        resetVoiceUI();
      }
      startRecognition();
    }
  });

  voiceClose.addEventListener('click', () => {
    stopRecognition();
    voiceOverlay.classList.add('hide');
  });

  voiceOverlay.addEventListener('click', (e) => {
    if (e.target === voiceOverlay) {
      stopRecognition();
      voiceOverlay.classList.add('hide');
    }
  });

  voiceBtnOk.addEventListener('click', async () => {
    if (!lastParsedData) return;
    const payload = lastParsedData;
    stopRecognition();
    voiceOverlay.classList.add('hide');

    if (typeof voiceCallback === 'function') {
      await voiceCallback(payload);
    } else {
      pendingVoiceData = payload;
      window.location.hash = '#/record';
    }
  });

  voiceBtnCancel.addEventListener('click', () => {
    stopRecognition();
    voiceOverlay.classList.add('hide');
  });
}
