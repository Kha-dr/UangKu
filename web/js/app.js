import { db } from './db/client.js';
import { enableLocalFileAutoSave, getConnectedLocalFile } from './db/local-file.js';
import * as rekeningModel from './models/rekening.js';
import * as gdrive from './sync/gdrive.js';
import { signInGoogleWithProtection } from './sync/guard.js';
import { registerWebMCP } from './webmcp.js';
import { initVoice } from './voice.js';
import { setLoading, showAlert } from './utils.js';

const earlyDbInit = db.init().catch((err) => err);

const DEFAULT_ROUTE = '/transactions';

const ROUTES = {
  '/onboarding': {
    title: 'Selamat Datang',
    load: () => import('./views/onboarding.js')
  },
  '/transactions': {
    title: 'Dashboard Transaksi',
    load: () => import('./views/transactions.js')
  },
  '/record': {
    title: 'Catat Transaksi',
    load: () => import('./views/record.js')
  },
  '/rekening': {
    title: 'Rekening',
    load: () => import('./views/rekening.js')
  },
  '/wishlist': {
    title: 'Wishlist',
    load: () => import('./views/wishlist.js')
  },
  '/analisis': {
    title: 'Analisis',
    load: () => import('./views/analisis.js')
  },
  '/databases': {
    title: 'Basis Data',
    load: () => import('./views/databases.js')
  },
  '/attachment': {
    title: 'Unggah Lampiran',
    load: () => import('./views/attachment.js')
  }
};

let activeView = null;
let currentRoutePath = DEFAULT_ROUTE;
let routeRenderToken = 0;
let deferredInstallPrompt = null;

/**
 * Parse window.location.hash into { path, params }.
 * @returns {{ path: string, params: URLSearchParams }}
 */
function parseHash() {
  const rawHash = window.location.hash || '';
  const cleaned = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  const [rawPath, rawQuery] = cleaned.split('?');
  const normalizedPath = rawPath && rawPath.startsWith('/') ? rawPath.toLowerCase() : `/${(rawPath || '').toLowerCase()}`;
  const path = ROUTES[normalizedPath] ? normalizedPath : DEFAULT_ROUTE;
  const params = new URLSearchParams(rawQuery || '');
  return { path, params };
}

/**
 * Collapse the bottom navbar drawer if currently open.
 */
function collapseNavbarMenu() {
  const menuEl = document.getElementById('navbarSupportedContent');
  if (!menuEl || !menuEl.classList.contains('show')) return;
  if (window.bootstrap?.Collapse) {
    const instance = window.bootstrap.Collapse.getOrCreateInstance(menuEl, { toggle: false });
    instance.hide();
  } else {
    menuEl.classList.remove('show');
  }
}

/**
 * Sync the #btn-google-auth label & avatar/icon at the top of the Menu drawer.
 */
async function syncGoogleAuthButton() {
  const btn = document.getElementById('btn-google-auth');
  if (!btn) return;

  const signedIn = gdrive.isSignedIn();
  if (signedIn) {
    const profile = gdrive.getUserProfile();
    const displayName = profile?.name || profile?.email || 'Google Drive';
    const nodes = [];
    if (profile?.picture) {
      const img = document.createElement('img');
      img.src = profile.picture;
      img.alt = displayName;
      img.referrerPolicy = 'no-referrer';
      img.style.cssText = 'width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex-shrink: 0;';
      nodes.push(img);
    } else {
      const icon = document.createElement('i');
      icon.className = 'fab fa-google-drive';
      nodes.push(icon);
    }
    const textWrap = document.createElement('span');
    textWrap.className = 'text-truncate';
    textWrap.textContent = displayName;
    const signoutHint = document.createElement('small');
    signoutHint.className = 'ms-auto opacity-75';
    signoutHint.textContent = 'Keluar';
    nodes.push(textWrap, signoutHint);
    btn.replaceChildren(...nodes);
    btn.setAttribute('aria-label', `Keluar dari ${displayName}`);
    return;
  }

  const localFile = await getConnectedLocalFile();
  if (localFile?.name) {
    const icon = document.createElement('i');
    icon.className = 'fas fa-database';
    const textWrap = document.createElement('span');
    textWrap.className = 'text-truncate';
    textWrap.textContent = localFile.name;
    const localBadge = document.createElement('small');
    localBadge.className = 'ms-auto opacity-75';
    localBadge.textContent = 'Lokal';
    btn.replaceChildren(icon, textWrap, localBadge);
    btn.setAttribute('aria-label', `File lokal ${localFile.name} — klik untuk masuk Google Drive`);
    return;
  }

  const icon = document.createElement('i');
  icon.className = 'fab fa-google';
  const label = document.createElement('span');
  label.textContent = 'Sign in with Google';
  btn.replaceChildren(icon, label);
  btn.setAttribute('aria-label', 'Sign in with Google');
}

/**
 * Update the Drive sync status pill in the header.
 * @param {string} text
 * @param {string} [variant='secondary'] Bootstrap color variant (secondary, success, warning, danger, info)
 */
export function setDriveStatus(text, variant = 'secondary') {
  const pill = document.getElementById('drive-status-pill');
  if (pill) {
    pill.className = `badge rounded-pill text-bg-${variant}`;
    const icon = document.createElement('i');
    icon.className = variant === 'success' ? 'fab fa-google-drive me-1' : 'fas fa-hard-drive me-1';
    pill.replaceChildren(icon, document.createTextNode(String(text || 'Local Mode')));
  }
  syncGoogleAuthButton();
}

/**
 * Navigate programmatically to a hash route (e.g. '/record' or '/wishlist?action=add').
 * @param {string} route
 */
export function navigate(route) {
  const target = route.startsWith('#') ? route : `#${route.startsWith('/') ? route : '/' + route}`;
  if (window.location.hash === target) {
    renderCurrentRoute();
  } else {
    window.location.hash = target;
  }
}

/**
 * Get the currently active route path.
 * @returns {string}
 */
export function getCurrentRoute() {
  return currentRoutePath;
}

async function renderCurrentRoute() {
  const container = document.getElementById('app-view');
  if (!container) return;

  collapseNavbarMenu();

  const token = ++routeRenderToken;
  const { path, params } = parseHash();
  const routeConfig = ROUTES[path] || ROUTES[DEFAULT_ROUTE];

  if (activeView && typeof activeView.unmount === 'function') {
    try {
      activeView.unmount();
    } catch (err) {
      console.error('Error unmounting view:', err);
    }
    activeView = null;
  }

  container.innerHTML = '';

  try {
    const viewModule = await routeConfig.load();
    if (token !== routeRenderToken) return;

    currentRoutePath = path;
    activeView = viewModule;

    const subtitleEl = document.getElementById('page-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = viewModule.title || routeConfig.title || '';
    }

    if (typeof viewModule.mount === 'function') {
      await viewModule.mount(container, params);
    }
  } catch (err) {
    if (token !== routeRenderToken) return;
    console.error('Failed to render route:', path, err);
    showAlert(`Gagal memuat halaman: ${err?.message || 'Kesalahan tidak diketahui'}`, 'danger');
  }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    console.log('Service Worker registered with scope:', registration.scope);
  } catch (error) {
    console.error('Service Worker registration failed:', error);
  }
}

function initNavbarOutsideClick() {
  const menuEl = document.getElementById('navbarSupportedContent');
  if (!menuEl) return;

  menuEl.addEventListener('click', (event) => {
    const rect = menuEl.getBoundingClientRect();
    const isInside =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (!isInside) {
      collapseNavbarMenu();
    }
  });
}

function initGoogleAuthButton() {
  const btn = document.getElementById('btn-google-auth');
  if (!btn) return;

  syncGoogleAuthButton();

  btn.addEventListener('click', async () => {
    collapseNavbarMenu();

    if (gdrive.isSignedIn()) {
      gdrive.signOut();
      syncGoogleAuthButton();
      showAlert('Berhasil keluar dari Google Drive.', 'info');
      return;
    }

    if (!gdrive.isConfigured()) {
      navigate('/databases');
      showAlert('Masukkan Google Client ID terlebih dahulu di menu Basis Data.', 'info');
      return;
    }

    btn.disabled = true;
    try {
      const res = await signInGoogleWithProtection();
      await syncGoogleAuthButton();
      if (res?.action !== 'cancelled') {
        showAlert('Berhasil masuk dan sinkronisasi Google Drive.', 'success');
      }
    } catch (err) {
      await syncGoogleAuthButton();
      showAlert(err?.message || 'Gagal masuk ke Google Drive.', 'danger');
    } finally {
      btn.disabled = false;
    }
  });

  window.addEventListener('kasin:db-updated', syncGoogleAuthButton);
}

function setupPwaInstall() {
  const banner = document.getElementById('pwa-install-banner');
  const installBtn = document.getElementById('btn-pwa-install');
  const dismissBtn = document.getElementById('btn-pwa-install-dismiss');
  if (!banner || !installBtn) return;

  const setBannerVisible = (visible) => {
    banner.classList.toggle('d-none', !visible);
  };

  if (window.matchMedia('(display-mode: standalone)').matches) {
    return;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    deferredInstallPrompt = e;
    if (sessionStorage.getItem('kasin_install_dismissed') !== '1') {
      setBannerVisible(true);
    }
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    setBannerVisible(false);
  });

  dismissBtn?.addEventListener('click', () => {
    sessionStorage.setItem('kasin_install_dismissed', '1');
    setBannerVisible(false);
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    setBannerVisible(false);
  });
}

function initThemeToggle() {
  const btn = document.getElementById('btn-theme-toggle');
  const metaTheme = document.getElementById('meta-theme-color');
  const THEME_KEY = 'kasin_theme';
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  const applyTheme = (theme) => {
    const isDark = theme === 'dark';
    document.documentElement.setAttribute('data-bs-theme', isDark ? 'dark' : 'light');
    if (metaTheme) {
      metaTheme.setAttribute('content', isDark ? '#1e1e2e' : '#04a5e5');
    }
    if (btn) {
      const label = isDark ? 'Mode Terang' : 'Mode Gelap';
      btn.innerHTML = `<i class="fas ${isDark ? 'fa-sun' : 'fa-moon'}"></i>`;
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label);
    }
  };

  const getCurrentTheme = () => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return mq.matches ? 'dark' : 'light';
  };

  applyTheme(getCurrentTheme());

  btn?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  mq.addEventListener('change', () => {
    if (!localStorage.getItem(THEME_KEY)) {
      applyTheme(mq.matches ? 'dark' : 'light');
    }
  });
}

async function bootstrap() {
  initNavbarOutsideClick();
  initThemeToggle();
  setupPwaInstall();
  registerWebMCP();

  const initResult = await earlyDbInit;
  if (initResult instanceof Error) {
    console.error('Database initialization failed:', initResult);
    showAlert(`Gagal menginisialisasi basis data lokal: ${initResult?.message || 'Kesalahan tidak diketahui'}`, 'danger');
  } else if (initResult?.schema?.newerThanSupported) {
    showAlert('Basis data menggunakan skema lebih baru dari versi aplikasi ini. Silakan perbarui / muat ulang KasIn.', 'warning');
  }

  initVoice();
  gdrive.enableAutoSave();
  enableLocalFileAutoSave();
  initGoogleAuthButton();

  if (!localStorage.getItem('kasin_onboarded')) {
    try {
      const existingAccounts = await rekeningModel.getAll();
      if (existingAccounts.length === 0 && !gdrive.isSignedIn()) {
        window.location.replace('#/onboarding');
      } else {
        localStorage.setItem('kasin_onboarded', '1');
      }
    } catch {
      // Ignore check errors
    }
  }

  if (!window.location.hash) {
    window.location.replace(`#${DEFAULT_ROUTE}`);
  }

  await renderCurrentRoute();
  setLoading(false);
  registerServiceWorker();
}

window.KasInApp = {
  setDriveStatus,
  navigate,
  getCurrentRoute
};

document.addEventListener('DOMContentLoaded', bootstrap);
window.addEventListener('hashchange', renderCurrentRoute);
