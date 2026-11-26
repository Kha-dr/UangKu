import { escapeHtml, formatIDR, showAlert } from '../utils.js';
import * as wishlistModel from '../models/wishlist.js';

export const title = 'Wishlist';

let isMounted = false;
let rootContainer = null;
let dbUpdatedHandler = null;
let itemsCache = [];

function isSafeHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function closeDialog() {
  const dialogEl = rootContainer?.querySelector('#wishlist-dialog');
  if (dialogEl?.open) {
    try {
      dialogEl.close();
    } catch {
      // Ignore dialog close errors
    }
  }
}

function openWishlistModal(item = null, prefill = null) {
  const dialogEl = rootContainer?.querySelector('#wishlist-dialog');
  const form = rootContainer?.querySelector('#form');
  const titleEl = rootContainer?.querySelector('#wishlist-modal-title');
  const submitBtn = rootContainer?.querySelector('#btn-submit');
  const deleteBtn = rootContainer?.querySelector('#btn-delete');
  const hrDelete = rootContainer?.querySelector('#hr-delete');
  if (!dialogEl || !form) return;

  form.reset();

  const data = item || prefill || {};
  form.querySelector('#wish-id').value = item ? String(item.id) : '';
  form.querySelector('#wish-nama').value = data.nama ?? '';
  form.querySelector('#wish-harga').value =
    data.harga_estimasi !== null && data.harga_estimasi !== undefined && data.harga_estimasi !== ''
      ? String(data.harga_estimasi)
      : '';
  form.querySelector('#wish-link').value = data.link ?? '';
  form.querySelector('#wish-catatan').value = data.catatan ?? '';

  if (titleEl) {
    titleEl.textContent = item ? 'Edit Wishlist' : 'Tambah Wishlist';
  }
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.value = item ? 'Simpan' : 'Tambah';
  }
  if (deleteBtn) deleteBtn.classList.toggle('hide', !item);
  if (hrDelete) hrDelete.classList.toggle('hide', !item);

  if (typeof dialogEl.showModal === 'function' && !dialogEl.open) {
    dialogEl.showModal();
  }
}

function renderItems(items) {
  const listEl = rootContainer?.querySelector('#wishlist-list');
  const countEl = rootContainer?.querySelector('#wishlist-count');
  const totalEl = rootContainer?.querySelector('#wishlist-total-estimasi');
  if (!listEl) return;

  const totalEstimasi = items.reduce((sum, item) => sum + (Number(item.harga_estimasi) || 0), 0);
  if (countEl) countEl.textContent = `${items.length} item`;
  if (totalEl) totalEl.textContent = formatIDR(totalEstimasi);

  if (!items.length) {
    listEl.innerHTML = `
      <div class="col-12">
        <div class="card border-0 shadow-sm rounded-4">
          <div class="card-body text-center text-muted py-5">
            <i class="fas fa-star fa-2x mb-2 opacity-50" style="color: var(--primary-color);"></i>
            <p class="mb-2">Belum ada item di wishlist.</p>
            <button type="button" class="btn btn-sm rounded-pill px-3" id="btn-empty-add-wish" style="background-color: var(--primary-color); color: var(--white-color); border: none;">
              <i class="fas fa-plus me-1"></i>Tambah Sekarang
            </button>
          </div>
        </div>
      </div>
    `;
    const emptyBtn = listEl.querySelector('#btn-empty-add-wish');
    if (emptyBtn) {
      emptyBtn.addEventListener('click', () => openWishlistModal(null));
    }
    return;
  }

  listEl.innerHTML = items.map((item) => {
    const harga = Number(item.harga_estimasi || 0);
    const hasLink = Boolean(item.link && String(item.link).trim());
    const safeLinkHtml = hasLink
      ? (isSafeHttpUrl(item.link)
          ? `<a href="${escapeHtml(item.link.trim())}" target="_blank" rel="noopener noreferrer" class="small text-decoration-none text-truncate d-inline-block wish-external-link" style="max-width: 100%; color: var(--primary-color);">
               <i class="fas fa-external-link-alt me-1"></i>${escapeHtml(item.link.trim())}
             </a>`
          : `<div class="small text-muted text-truncate"><i class="fas fa-link me-1"></i>${escapeHtml(item.link.trim())}</div>`)
      : '';

    const catatanHtml = item.catatan
      ? `<p class="card-text small text-secondary mb-2 text-break">${escapeHtml(item.catatan)}</p>`
      : '';

    const dateLabel = item.updated_at || item.created_at || '';

    return `
      <div class="col-12 col-md-6 col-lg-4">
        <div class="card border-0 shadow-sm rounded-4 h-100 wishlist-card" data-id="${escapeHtml(item.id)}" style="border: 1px solid color-mix(in srgb, var(--primary-color) 18%, transparent) !important;">
          <div class="card-body d-flex flex-column">
            <div class="d-flex justify-content-between align-items-start gap-2 mb-1">
              <h6 class="fw-bold mb-0 text-break" style="color: var(--black-color);">${escapeHtml(item.nama)}</h6>
              <span class="badge text-nowrap" style="background-color: color-mix(in srgb, var(--primary-color) 14%, transparent); color: var(--primary-color);">${escapeHtml(formatIDR(harga))}</span>
            </div>
            ${catatanHtml}
            ${safeLinkHtml ? `<div class="mb-2">${safeLinkHtml}</div>` : ''}
            <div class="mt-auto pt-2 border-top d-flex justify-content-between align-items-center">
              <span class="small text-muted">${escapeHtml(dateLabel)}</span>
              <div class="btn-group btn-group-sm" role="group" aria-label="Aksi Wishlist">
                <button type="button" class="btn btn-outline-primary btn-share-wish" data-id="${escapeHtml(item.id)}" title="Bagikan" style="color: var(--primary-color); border-color: var(--primary-color);">
                  <i class="fas fa-share-alt"></i>
                </button>
                <button type="button" class="btn btn-outline-secondary btn-edit-wish" data-id="${escapeHtml(item.id)}" title="Edit">
                  <i class="fas fa-pen"></i>
                </button>
                <button type="button" class="btn btn-outline-danger btn-delete-wish" data-id="${escapeHtml(item.id)}" title="Hapus" style="color: var(--red-color); border-color: var(--red-color);">
                  <i class="fas fa-trash"></i>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function handleShare(item) {
  const shareTitle = item.nama || 'Wishlist KasIn';
  const hargaStr = item.harga_estimasi ? `Estimasi: ${formatIDR(item.harga_estimasi)}` : '';
  const textParts = [shareTitle, hargaStr, item.catatan || ''].filter(Boolean);
  const text = textParts.join('\n');
  const url = isSafeHttpUrl(item.link) ? item.link.trim() : undefined;

  if (navigator.share) {
    try {
      await navigator.share({ title: shareTitle, text, ...(url ? { url } : {}) });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }

  const fallbackText = url ? `${text}\n${url}` : text;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(fallbackText);
      showAlert('Detail wishlist disalin ke clipboard.', 'success');
      return;
    } catch {
      // Fall through to warning
    }
  }

  showAlert('Fitur share tidak tersedia di browser ini.', 'warning');
}

async function handleDelete(item) {
  let confirmed = false;
  const dialogEl = rootContainer?.querySelector('#wishlist-dialog');

  if (window.Swal?.fire) {
    const result = await window.Swal.fire({
      title: 'Hapus Wishlist?',
      text: `Item "${item.nama}" akan dihapus permanen.`,
      icon: 'warning',
      target: dialogEl?.open ? dialogEl : document.body,
      showCancelButton: true,
      confirmButtonColor: '#d20f39',
      cancelButtonColor: '#6c757d',
      confirmButtonText: 'Ya, Hapus',
      cancelButtonText: 'Batal'
    });
    confirmed = Boolean(result.isConfirmed);
  } else {
    confirmed = window.confirm(`Hapus wishlist "${item.nama}"?`);
  }

  if (!confirmed || !isMounted) return;

  try {
    await wishlistModel.deleteWishlist(item.id);
    closeDialog();
    showAlert('Item wishlist berhasil dihapus.', 'success');
    window.dispatchEvent(new CustomEvent('kasin:db-updated', { detail: { source: 'wishlist' } }));
  } catch (err) {
    console.error('Failed deleting wishlist:', err);
    showAlert(`Gagal menghapus wishlist: ${err.message || err}`, 'danger');
  }
}

async function handleFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitBtn = form.querySelector('#btn-submit');

  const id = form.querySelector('#wish-id').value.trim();
  const nama = form.querySelector('#wish-nama').value.trim();
  if (!nama) {
    showAlert('Nama item wishlist wajib diisi.', 'warning');
    return;
  }

  const rawHarga = form.querySelector('#wish-harga').value.trim();
  const hargaEstimasi = rawHarga === '' ? 0 : Number(rawHarga);

  const payload = {
    nama,
    harga_estimasi: Number.isFinite(hargaEstimasi) ? hargaEstimasi : 0,
    link: form.querySelector('#wish-link').value.trim() || null,
    catatan: form.querySelector('#wish-catatan').value.trim() || null
  };

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.value = 'Menyimpan...';
  }
  try {
    if (id) {
      await wishlistModel.updateWishlist(Number(id), payload);
      showAlert('Wishlist berhasil diperbarui.', 'success');
    } else {
      await wishlistModel.insertWishlist(payload);
      showAlert('Wishlist baru berhasil ditambahkan.', 'success');
    }

    closeDialog();
    window.dispatchEvent(new CustomEvent('kasin:db-updated', { detail: { source: 'wishlist' } }));
  } catch (err) {
    console.error('Failed saving wishlist:', err);
    showAlert(`Gagal menyimpan wishlist: ${err.message || err}`, 'danger');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.value = id ? 'Simpan' : 'Tambah';
    }
  }
}

async function refreshData() {
  if (!isMounted || !rootContainer) return;

  try {
    const items = await wishlistModel.getAll();
    if (!isMounted) return;

    itemsCache = items || [];
    renderItems(itemsCache);
  } catch (err) {
    console.error('Failed loading wishlist:', err);
    showAlert(`Gagal memuat wishlist: ${err.message || err}`, 'danger');
  }
}

async function consumeSharedWishlistTarget() {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open('shared-files');
    const response = await cache.match('./pwa-share-wishlist');
    if (!response) return null;

    const data = await response.json().catch(() => null);
    await cache.delete('./pwa-share-wishlist');

    if (!data || typeof data !== 'object') return null;
    return {
      nama: data.title ? String(data.title) : '',
      catatan: data.text ? String(data.text) : '',
      link: data.url ? String(data.url) : ''
    };
  } catch (err) {
    console.warn('Unable to read shared-files cache:', err);
    return null;
  }
}

function buildSkeletonHtml() {
  return `
    <div class="container py-3 pb-5">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h5 class="fw-bold m-0" style="color: var(--primary-color); font-family: var(--font-head);">Daftar Wishlist</h5>
          <div class="small text-muted">
            <span id="wishlist-count">0 item</span> &middot; Total Estimasi: <strong id="wishlist-total-estimasi" style="color: var(--primary-color);">Rp 0</strong>
          </div>
        </div>
        <button type="button" id="btn-add-wishlist" class="btn rounded-circle d-inline-flex align-items-center justify-content-center" style="width: 3em; height: 3em; background-color: var(--primary-color); color: var(--white-color); border: none;" title="Tambah Wishlist">
          <i class="fas fa-plus"></i>
        </button>
      </div>

      <div id="wishlist-list" class="row g-3"></div>
    </div>

    <dialog id="wishlist-dialog" class="p-2" style="width: min(88dvw, 520px); max-width: 95vw;">
      <div class="dialog-header mb-2">
        <h4 class="fw-bold w-100 text-center" id="wishlist-modal-title">Tambah Wishlist</h4>
        <form method="dialog">
          <button type="submit" aria-label="Tutup"><i class="fas fs-4 fw-bold fa-times"></i></button>
        </form>
      </div>
      <div class="dialog-body">
        <form id="form">
          <input type="hidden" id="wish-id">
          <div class="form-group">
            <label for="wish-nama">Nama Barang</label>
            <input type="text" id="wish-nama" class="form-control" required maxlength="150" placeholder="Nama Barang">
          </div>
          <div class="form-group">
            <label for="wish-harga">Estimasi Harga</label>
            <div class="input-group">
              <span class="input-group-text">Rp.</span>
              <input type="number" id="wish-harga" class="form-control" min="0" step="1000" placeholder="0" inputmode="numeric">
            </div>
          </div>
          <div class="form-group">
            <label for="wish-link">Link</label>
            <input type="url" id="wish-link" class="form-control" placeholder="Link Produk (opsional)">
          </div>
          <div class="form-group">
            <label for="wish-catatan">Catatan</label>
            <textarea id="wish-catatan" class="form-control" rows="3" placeholder="Catatan, alasan, pertimbangan..."></textarea>
          </div>
          <input type="submit" class="btn w-100 fw-bold" value="Tambah" id="btn-submit">
          <hr id="hr-delete" class="hide">
          <button type="button" class="btn w-100 fw-bold hide" style="--primary-color:var(--red-color)" id="btn-delete">
            <i class="fas fa-trash-alt me-1"></i>Hapus
          </button>
        </form>
      </div>
    </dialog>
  `;
}

export async function mount(container, params) {
  isMounted = true;
  rootContainer = container;
  container.innerHTML = buildSkeletonHtml();

  const addBtn = container.querySelector('#btn-add-wishlist');
  if (addBtn) {
    addBtn.addEventListener('click', () => openWishlistModal(null));
  }

  const listEl = container.querySelector('#wishlist-list');
  if (listEl) {
    listEl.addEventListener('click', (event) => {
      const shareBtn = event.target.closest('.btn-share-wish');
      if (shareBtn) {
        const item = itemsCache.find((i) => String(i.id) === String(shareBtn.getAttribute('data-id')));
        if (item) handleShare(item);
        return;
      }

      const editBtn = event.target.closest('.btn-edit-wish');
      if (editBtn) {
        const item = itemsCache.find((i) => String(i.id) === String(editBtn.getAttribute('data-id')));
        if (item) openWishlistModal(item);
        return;
      }

      const deleteBtn = event.target.closest('.btn-delete-wish');
      if (deleteBtn) {
        const item = itemsCache.find((i) => String(i.id) === String(deleteBtn.getAttribute('data-id')));
        if (item) handleDelete(item);
      }
    });
  }

  const dialogEl = container.querySelector('#wishlist-dialog');
  if (dialogEl) {
    dialogEl.addEventListener('click', (event) => {
      const rect = dialogEl.getBoundingClientRect();
      const isInDialog =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!isInDialog) dialogEl.close();
    });
  }

  const form = container.querySelector('#form');
  if (form) {
    form.addEventListener('submit', handleFormSubmit);
  }

  const deleteBtn = container.querySelector('#btn-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const targetId = form?.querySelector('#wish-id')?.value;
      const item = itemsCache.find((i) => String(i.id) === String(targetId));
      if (item) handleDelete(item);
    });
  }

  dbUpdatedHandler = () => {
    refreshData();
  };
  window.addEventListener('kasin:db-updated', dbUpdatedHandler);

  await refreshData();
  if (!isMounted) return;

  const sharedPrefill = await consumeSharedWishlistTarget();
  if (!isMounted) return;

  if (sharedPrefill) {
    openWishlistModal(null, sharedPrefill);
  } else if (params?.get('action') === 'add') {
    openWishlistModal(null);
  }
}

export function unmount() {
  isMounted = false;
  if (dbUpdatedHandler) {
    window.removeEventListener('kasin:db-updated', dbUpdatedHandler);
    dbUpdatedHandler = null;
  }
  closeDialog();
  itemsCache = [];
  rootContainer = null;
}
