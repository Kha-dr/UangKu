import { APP_CONFIG } from '../config.js';
import { showAlert } from '../utils.js';
import { db } from '../db/client.js';
import * as gdrive from '../sync/gdrive.js';
import { signInGoogleWithProtection } from '../sync/guard.js';
import {
  isFileSystemAccessSupported,
  isSaveFilePickerSupported,
  connectLocalSqliteFile,
  createLocalSqliteFile
} from '../db/local-file.js';

export const title = 'Selamat Datang';

export const ONBOARDED_KEY = 'kasin_onboarded';

const STYLE_ID = 'kasin-onboarding-styles';
const ONBOARDING_CSS = `
  body.onboard-mode {
    background-color: var(--primary-color) !important;
  }
  .onboard-wrapper .main-logo {
    width: 100%;
    min-height: 46dvh;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .onboard-wrapper .main-logo img {
    padding: 1em;
    width: 22dvw;
    pointer-events: none;
  }
  @media (orientation: portrait) {
    .onboard-wrapper .main-logo img {
      width: 65dvw;
    }
  }
  .onboard-sheet {
    min-height: 54dvh;
    padding: 1.5rem 2rem 2rem;
    width: 44%;
    margin-inline: auto;
    border-radius: 6em 6em 0 0;
    box-shadow: color-mix(in srgb, var(--black-color) 25%, transparent) 0px -12.5px 30px;
    background-color: var(--white-color);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
  }
  @media (orientation: portrait) {
    .onboard-sheet {
      width: 94%;
      border-radius: 4.5em 4.5em 0 0;
    }
  }
  .onboard-title {
    color: var(--primary-color);
    font-family: var(--font-head);
    font-weight: 700;
  }
  .onboard-btn-primary {
    background-color: var(--primary-color);
    color: var(--white-color);
    border: none;
  }
  .onboard-btn-primary:hover,
  .onboard-btn-primary:focus {
    background-color: var(--primary-color-alt);
    color: var(--white-color);
  }
  .onboard-btn-outline {
    background-color: transparent;
    color: var(--primary-color);
    border: 1.5px solid var(--primary-color);
  }
  .onboard-btn-outline:hover,
  .onboard-btn-outline:focus {
    background-color: color-mix(in srgb, var(--primary-color) 10%, transparent);
    color: var(--primary-color-alt);
  }
  .onboard-btn-subtle {
    background-color: var(--white-color-0);
    color: var(--black-color);
    border: 1px solid var(--white-color-1);
  }
  .onboard-btn-subtle:hover,
  .onboard-btn-subtle:focus {
    background-color: var(--white-color-1);
    color: var(--black-color);
  }
`;

let abortController = null;

function setChromeHidden(hidden) {
  document.body.classList.toggle('onboard-mode', hidden);
  const header = document.querySelector('header');
  const nav = document.querySelector('nav.container-full');
  if (header) header.classList.toggle('d-none', hidden);
  if (nav) nav.classList.toggle('d-none', hidden);
}

export async function mount(container) {
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const { signal } = abortController;

  if (!document.getElementById(STYLE_ID)) {
    const styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = ONBOARDING_CSS;
    document.head.appendChild(styleEl);
  }

  setChromeHidden(true);

  const fsSupported = isFileSystemAccessSupported();

  container.innerHTML = `
    <div class="onboard-wrapper">
      <div class="main-logo">
        <img src="./assets/img/logo.png" alt="KasIn Logo">
      </div>
      <div class="onboard-sheet">
        <div class="onboard-title mb-1"><i class="fa-solid fa-caret-up"></i></div>
        <h5 class="onboard-title mb-2 text-center">Start</h5>

        <div class="w-100 d-flex flex-column gap-2" style="max-width: 360px;">
          <button type="button" id="btn-onboard-local-file" class="btn onboard-btn-primary w-100 rounded-3 py-2 fw-semibold">
            <i class="fas fa-database me-2"></i>${fsSupported ? 'Connect Local DB' : 'Import Local DB'}
          </button>
          <input type="file" id="onboard-sqlite-input" accept=".sqlite,.sqlite3,.db" class="d-none">

          <button type="button" id="btn-onboard-google" class="btn onboard-btn-outline w-100 rounded-3 py-2 fw-semibold">
            <i class="fab fa-google me-2"></i>Connect Google
          </button>

          <button type="button" id="btn-onboard-new" class="btn onboard-btn-subtle w-100 rounded-3 py-2 fw-semibold">
            <i class="fas fa-plus-circle me-2"></i>Start New
          </button>
        </div>

        <div class="d-flex align-items-center gap-3 mt-2 small">
          <a href="./privacy.html" class="text-decoration-none" style="color: var(--primary-color);">
            <i class="fas fa-shield-alt me-1"></i>Privasi
          </a>
          <span class="text-muted">&middot;</span>
          <a href="${APP_CONFIG.repo}" target="_blank" rel="noopener noreferrer" class="text-decoration-none" style="color: var(--primary-color);">
            <i class="fab fa-github me-1"></i>GitHub
          </a>
        </div>
      </div>
    </div>
  `;

  const btnLocalFile = container.querySelector('#btn-onboard-local-file');
  const fileInput = container.querySelector('#onboard-sqlite-input');
  const btnGoogle = container.querySelector('#btn-onboard-google');
  const btnNew = container.querySelector('#btn-onboard-new');

  const finishOnboarding = (targetHash) => {
    localStorage.setItem(ONBOARDED_KEY, '1');
    setChromeHidden(false);
    window.location.hash = targetHash;
  };

  btnLocalFile?.addEventListener('click', async () => {
    if (!fsSupported) {
      fileInput?.click();
      return;
    }
    btnLocalFile.disabled = true;
    try {
      const res = await connectLocalSqliteFile();
      showAlert(`Terhubung ke file lokal: ${res.name}`, 'success');
      finishOnboarding('#/transactions');
    } catch (err) {
      if (err?.name !== 'AbortError' && !String(err?.message || '').includes('dibatalkan')) {
        showAlert(err?.message || 'Gagal menghubungkan file SQLite lokal.', 'danger');
      }
      btnLocalFile.disabled = false;
    }
  }, { signal });

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    btnLocalFile.disabled = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await db.importDb(bytes);
      showAlert(`Basis data "${file.name}" berhasil dimuat.`, 'success');
      finishOnboarding('#/transactions');
    } catch (err) {
      showAlert(err?.message || 'Gagal mengimpor file SQLite.', 'danger');
      btnLocalFile.disabled = false;
    }
  }, { signal });

  btnGoogle?.addEventListener('click', async () => {
    if (!gdrive.isConfigured()) {
      localStorage.setItem(ONBOARDED_KEY, '1');
      setChromeHidden(false);
      showAlert('Atur Google Client ID terlebih dahulu untuk masuk ke Google Drive.', 'info');
      window.location.hash = '#/databases';
      return;
    }
    btnGoogle.disabled = true;
    try {
      const res = await signInGoogleWithProtection();
      if (res?.action === 'cancelled') {
        btnGoogle.disabled = false;
        return;
      }
      showAlert('Berhasil masuk dan sinkronisasi Google Drive.', 'success');
      finishOnboarding('#/transactions');
    } catch (err) {
      showAlert(err?.message || 'Gagal masuk ke Google Drive.', 'danger');
      btnGoogle.disabled = false;
    }
  }, { signal });

  btnNew?.addEventListener('click', async () => {
    if (!isSaveFilePickerSupported()) {
      finishOnboarding('#/rekening');
      return;
    }
    btnNew.disabled = true;
    try {
      const res = await createLocalSqliteFile('kasin.sqlite');
      window.dispatchEvent(new CustomEvent('kasin:db-updated', { detail: { source: 'local-file' } }));
      showAlert(`Database baru dibuat & terhubung: ${res.name}`, 'success');
      finishOnboarding('#/rekening');
    } catch (err) {
      if (err?.name !== 'AbortError' && !String(err?.message || '').includes('dibatalkan')) {
        showAlert(err?.message || 'Gagal membuat file SQLite lokal.', 'danger');
      }
      btnNew.disabled = false;
    }
  }, { signal });
}

export function unmount() {
  setChromeHidden(false);
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}
