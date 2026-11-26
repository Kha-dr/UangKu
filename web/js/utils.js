const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/**
 * Escape HTML special characters for safe DOM insertion.
 * @param {*} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * Format a numeric amount as Indonesian Rupiah (e.g. "Rp 1.500.000").
 * @param {number|string} num
 * @returns {string}
 */
export function formatIDR(num) {
  const parsed = Number(num || 0);
  const safeNum = Number.isFinite(parsed) ? parsed : 0;
  return 'Rp ' + safeNum.toLocaleString('id-ID');
}

/**
 * Format a numeric string/value using Indonesian thousands/decimal separators (1.250,50).
 * @param {number|string} val
 * @returns {string}
 */
export function formatID(val) {
  if (val === null || val === undefined || val === '') return '';
  const parts = String(val).replace(/[^0-9,]/g, '').split(',');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return parts.length > 1 ? `${parts[0]},${parts[1].substring(0, 4)}` : parts[0];
}

/**
 * Convert an Indonesian-formatted number string (e.g. "1.250,50") to a JS float.
 * @param {number|string} str
 * @returns {number}
 */
export function parseIDNumber(str) {
  if (typeof str === 'number') return Number.isFinite(str) ? str : 0;
  if (!str) return 0;
  const raw = String(str).trim().replace(/\./g, '').replace(',', '.');
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num : 0;
}

function normalizeDateInput(date) {
  if (date instanceof Date) return Number.isNaN(date.getTime()) ? null : date;
  if (typeof date === 'string' || typeof date === 'number') {
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Format a Date into YYYY-MM-DD (database format).
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatDBDate(date) {
  const d = normalizeDateInput(date);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/**
 * Format a Date in Indonesian locale with weekday and numeric date.
 * @param {Date|string|number} date
 * @returns {string}
 */
export function toDateShortMonth(date) {
  const d = normalizeDateInput(date);
  if (!d) return '';
  return new Intl.DateTimeFormat('id', {
    weekday: 'long',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric'
  }).format(d);
}

/**
 * Format a Date to day-of-month numeric string in Indonesian locale.
 * @param {Date|string|number} date
 * @returns {string}
 */
export function toDate(date) {
  const d = normalizeDateInput(date);
  if (!d) return '';
  return new Intl.DateTimeFormat('id', {
    day: 'numeric'
  }).format(d);
}

/**
 * Display a Bootstrap toast notification using #toast-template into #toast-container.
 * Safely escapes title and message unless options.isHtml is true.
 * @param {string} message
 * @param {string} [type='primary']
 * @param {string|null} [title=null]
 * @param {{ isHtml?: boolean }} [options={}]
 */
export function showAlert(message, type = 'primary', title = null, options = {}) {
  const defaultTitles = {
    warning: 'Perhatian !',
    success: 'Berhasil',
    danger: 'Peringatan !!'
  };

  const template = document.querySelector('#toast-template');
  const container = document.querySelector('#toast-container');
  if (!template || !container) return;

  const toast = template.cloneNode(true);
  toast.id = '';
  toast.classList.remove('hide');
  toast.classList.add(`border-${type}`);

  const headerEl = toast.querySelector('.toast-header');
  if (headerEl) headerEl.classList.add(`bg-${type}`);

  const titleText = title ?? defaultTitles[type] ?? 'Pemberitahuan';
  const strongEl = toast.querySelector('strong');
  if (strongEl) {
    if (options?.isHtml) {
      strongEl.innerHTML = titleText;
    } else {
      strongEl.textContent = String(titleText);
    }
  }

  const bodyEl = toast.querySelector('.toast-body');
  if (bodyEl) {
    if (options?.isHtml) {
      bodyEl.innerHTML = message ?? '';
    } else {
      bodyEl.textContent = String(message ?? '');
    }
  }

  container.prepend(toast);

  if (window.bootstrap?.Toast) {
    const bsToast = window.bootstrap.Toast.getOrCreateInstance(toast);
    toast.addEventListener('hidden.bs.toast', () => toast.remove(), { once: true });
    bsToast.show();
  }
}

/**
 * Toggle the full-page loading overlay.
 * @param {boolean} visible
 */
export function setLoading(visible) {
  const el = document.querySelector('.loading-Page');
  if (!el) return;
  el.style.display = visible ? 'flex' : 'none';
}

/**
 * Parse a single CSV line respecting quoted fields and escaped double quotes.
 * @param {string} line
 * @param {string} [delimiter=',']
 * @returns {string[]}
 */
export function parseCSVLine(line, delimiter = ',') {
  if (typeof line !== 'string') return [];
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function isValidCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Parse a date string from various spreadsheet locales into YYYY-MM-DD,
 * or return null if unrecognized/invalid.
 * @param {string} value
 * @returns {string|null}
 */
export function parseFlexibleDate(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    return isValidCalendarDate(year, month, day) ? trimmed : null;
  }

  const flexMatch = /^(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{1,4})$/.exec(trimmed);
  if (flexMatch) {
    const [, rawA, rawB, rawC] = flexMatch;
    let year;
    let month;
    let day;

    if (rawA.length === 4) {
      year = parseInt(rawA, 10);
      month = parseInt(rawB, 10);
      day = parseInt(rawC, 10);
    } else {
      const a = parseInt(rawA, 10);
      const b = parseInt(rawB, 10);
      year = parseInt(rawC, 10);
      if (a > 12) {
        day = a;
        month = b;
      } else if (b > 12) {
        month = a;
        day = b;
      } else {
        day = a;
        month = b;
      }
    }

    if (!isValidCalendarDate(year, month, day)) return null;
    const yyyy = String(year).padStart(4, '0');
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

let pdfJsPromise = null;
let slimSelectPromise = null;

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.crossOrigin = 'anonymous';
    script.async = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = '1';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.head.appendChild(script);
  });
}

function loadExternalStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
}

/**
 * Lazy-load PDF.js on demand when rendering PDF previews.
 */
export async function ensurePdfJs() {
  if (window.pdfjsLib) {
    if (window.pdfjsLib.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
    }
    return window.pdfjsLib;
  }
  if (!pdfJsPromise) {
    pdfJsPromise = loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js')
      .then(() => {
        if (window.pdfjsLib?.GlobalWorkerOptions) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
        }
        return window.pdfjsLib || null;
      })
      .catch((err) => {
        pdfJsPromise = null;
        throw err;
      });
  }
  return pdfJsPromise;
}

/**
 * Lazy-load SlimSelect CSS & JS on demand when mounting the Record view.
 */
export async function ensureSlimSelect() {
  if (window.SlimSelect) return window.SlimSelect;
  if (!slimSelectPromise) {
    loadExternalStylesheet('https://unpkg.com/slim-select@3/dist/slimselect.css');
    slimSelectPromise = loadExternalScript('https://unpkg.com/slim-select@3/dist/slimselect.js')
      .then(() => window.SlimSelect || null)
      .catch((err) => {
        slimSelectPromise = null;
        throw err;
      });
  }
  return slimSelectPromise;
}
