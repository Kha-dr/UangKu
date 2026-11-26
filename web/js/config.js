export const APP_VERSION = '2.0.0-alpha.0';

export const DATATABLE_PAGE_LENGTH = 10;
export const DATATABLE_LENGTH_MENU = [10, 25, 50, 100];

export const APP_CONFIG = {
  name: 'KasIn',
  repo: 'https://github.com/kha-dr/Uangku',
  repoSlug: 'kha-dr/Uangku',
  appUrl: 'https://kasin.khadr.dev',
  datatable: {
    pageLength: DATATABLE_PAGE_LENGTH,
    lengthMenu: DATATABLE_LENGTH_MENU
  }
};

if (typeof window !== 'undefined') {
  window.KASIN_CONFIG = APP_CONFIG;
}

export const JENIS_TRANSAKSI = ['Pengeluaran', 'Pemasukan', 'Pindah Buku'];

export const JENIS_UANG = ['Uang Hijau', 'Uang Biru', 'Uang Merah'];

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';

export const DEFAULT_GOOGLE_CLIENT_ID = '';

const GOOGLE_CLIENT_ID_STORAGE_KEY = 'kasin_google_client_id';

/**
 * Retrieve the configured Google OAuth Client ID from localStorage,
 * falling back to DEFAULT_GOOGLE_CLIENT_ID.
 * @returns {string}
 */
export function getGoogleClientId() {
  try {
    return localStorage.getItem(GOOGLE_CLIENT_ID_STORAGE_KEY) || DEFAULT_GOOGLE_CLIENT_ID;
  } catch {
    return DEFAULT_GOOGLE_CLIENT_ID;
  }
}

/**
 * Persist or clear the Google OAuth Client ID in localStorage.
 * @param {string} id
 */
export function setGoogleClientId(id) {
  try {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (trimmed) {
      localStorage.setItem(GOOGLE_CLIENT_ID_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(GOOGLE_CLIENT_ID_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}
