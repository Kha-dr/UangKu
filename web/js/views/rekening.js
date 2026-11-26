import { JENIS_UANG, DATATABLE_PAGE_LENGTH, DATATABLE_LENGTH_MENU } from '../config.js';
import {
  escapeHtml,
  formatIDR,
  formatDBDate,
  toDateShortMonth,
  showAlert
} from '../utils.js';
import * as rekeningModel from '../models/rekening.js';

export const title = 'Rekening';

let isMounted = false;
let rootContainer = null;
let dtTable = null;
let cashFlowChart = null;
let datePicker = null;
let accountModal = null;
let dbUpdatedHandler = null;

let accountsCache = [];
let currentStartDate = '';
let currentEndDate = '';

function getDefaultDateRange() {
  const now = new Date();
  return {
    start: `${now.getFullYear()}-01-01`,
    end: formatDBDate(now)
  };
}

function getJenisUangMeta(jenis) {
  switch (jenis) {
    case 'Uang Hijau':
      return { borderClass: 'border-success', textClass: 'text-success', icon: 'fas fa-shield-alt' };
    case 'Uang Merah':
      return { borderClass: 'border-danger', textClass: 'text-danger', icon: 'fas fa-bolt' };
    case 'Uang Biru':
      return { borderClass: 'border-primary', textClass: 'text-primary', icon: 'fas fa-piggy-bank' };
    default:
      return { borderClass: 'border-secondary', textClass: 'text-secondary', icon: 'fas fa-wallet' };
  }
}

function formatForeignBalance(saldoAsing, currencyCode) {
  const num = Number(saldoAsing ?? 0);
  const formatted = num.toLocaleString('id-ID', { maximumFractionDigits: 4 });
  return currencyCode ? `${formatted} ${currencyCode}` : formatted;
}

function getDaysUntilDayOfMonth(targetDay) {
  const day = Number(targetDay);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysInThisMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  let candidate = new Date(today.getFullYear(), today.getMonth(), Math.min(day, daysInThisMonth));
  if (candidate < today) {
    const daysInNextMonth = new Date(today.getFullYear(), today.getMonth() + 2, 0).getDate();
    candidate = new Date(today.getFullYear(), today.getMonth() + 1, Math.min(day, daysInNextMonth));
  }
  return Math.round((candidate - today) / 86400000);
}

function renderHutangMetaHtml(acc, saldo) {
  const isHutang = Boolean(acc.hutang) || (!acc.harta && saldo < 0);
  if (!isHutang) return '';
  const parts = [];
  const limitKredit = Number(acc.limit_kredit ?? 0);
  if (Number.isFinite(limitKredit) && limitKredit > 0) {
    const used = Math.max(0, -saldo);
    const sisa = Math.max(0, limitKredit - used);
    const utilPct = (used / limitKredit) * 100;
    const barPct = Math.min(100, Math.round(utilPct));
    const barClass = utilPct >= 80 ? 'bg-danger' : utilPct >= 50 ? 'bg-warning' : 'bg-success';
    parts.push(
      `<div class="mt-1">` +
      `<div class="progress" style="height: 6px;"><div class="progress-bar ${barClass}" style="width: ${barPct}%"></div></div>` +
      `<div class="small text-muted mt-1">Limit: ${escapeHtml(formatIDR(limitKredit))} / Sisa: ${escapeHtml(formatIDR(sisa))}</div>` +
      `</div>`
    );
  }
  const tglJatuhTempo = Number(acc.tgl_jatuh_tempo ?? 0);
  if (Number.isInteger(tglJatuhTempo) && tglJatuhTempo >= 1 && tglJatuhTempo <= 31) {
    const days = getDaysUntilDayOfMonth(tglJatuhTempo);
    const badgeClass = days !== null && days <= 3 ? 'text-bg-danger' : days !== null && days <= 7 ? 'text-bg-warning' : 'text-bg-secondary';
    const text = days === 0 ? `Jatuh tempo hari ini (tgl ${tglJatuhTempo})` : `Jatuh tempo tgl ${tglJatuhTempo} (${days} hr lagi)`;
    parts.push(`<div class="mt-1"><span class="badge ${badgeClass}">${escapeHtml(text)}</span></div>`);
  }
  return parts.join('');
}

function destroyChart() {
  if (cashFlowChart) {
    try {
      cashFlowChart.destroy();
    } catch {
      // Ignore
    }
    cashFlowChart = null;
  }
}

function destroyDatePicker() {
  if (datePicker) {
    try {
      datePicker.destroy();
    } catch {
      // Ignore
    }
    datePicker = null;
  }
}

function destroyModal() {
  const dialogEl = rootContainer?.querySelector('#rekening-dialog');
  if (dialogEl?.open) {
    try {
      dialogEl.close();
    } catch {
      // Ignore
    }
  }
  accountModal = null;
}

function renderSummarySection(summary, jenisRows) {
  const netWorthEl = rootContainer?.querySelector('#rekening-net-worth');
  const liquidEl = rootContainer?.querySelector('#rekening-liquid-cash');
  const debtEl = rootContainer?.querySelector('#rekening-total-debt');
  const hartaEl = rootContainer?.querySelector('#rekening-total-harta');

  if (netWorthEl) netWorthEl.textContent = formatIDR(summary?.net_worth ?? 0);
  if (liquidEl) liquidEl.textContent = formatIDR(summary?.liquid_cash ?? 0);
  if (debtEl) debtEl.textContent = formatIDR(summary?.total_debt ?? 0);
  if (hartaEl) hartaEl.textContent = formatIDR(summary?.total_harta ?? 0);

  const jenisContainer = rootContainer?.querySelector('#rekening-jenis-uang-cards');
  if (!jenisContainer) return;

  const saldoByJenis = new Map();
  for (const row of jenisRows || []) {
    if (row.jenis_uang) {
      saldoByJenis.set(row.jenis_uang, Number(row.saldo ?? row.total_saldo ?? 0));
    }
  }

  jenisContainer.innerHTML = JENIS_UANG.map((jenis) => {
    const meta = getJenisUangMeta(jenis);
    const amount = saldoByJenis.get(jenis) ?? 0;
    return `
      <div class="col-12 col-md-4">
        <div class="card border-0 border-start border-4 ${meta.borderClass} shadow-sm rounded-4 h-100">
          <div class="card-body py-3 px-3 d-flex align-items-center justify-content-between">
            <div>
              <div class="small text-muted fw-semibold">${escapeHtml(jenis)}</div>
              <div class="fs-5 fw-bold ${meta.textClass}">${escapeHtml(formatIDR(amount))}</div>
            </div>
            <div class="fs-3 ${meta.textClass} opacity-75">
              <i class="${meta.icon}"></i>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function renderCashFlowChart() {
  const chartContainer = rootContainer?.querySelector('#arusRekeningChart');
  if (!chartContainer) return;

  if (!window.Highcharts) {
    chartContainer.innerHTML = '<div class="text-center text-muted py-4">Highcharts tidak tersedia.</div>';
    return;
  }

  const [allFlowRows, perAccountRows] = await Promise.all([
    rekeningModel.allCashFlowGraph(currentStartDate, currentEndDate),
    rekeningModel.cashFlowGraph(currentStartDate, currentEndDate)
  ]);

  if (!isMounted) return;
  destroyChart();

  const selectedRows = dtTable ? dtTable.rows({ selected: true }).data().toArray() : [];
  const selectedIds = new Set(selectedRows.map((r) => String(r.id)));
  const series = [];

  if (selectedIds.size === 0) {
    const totalPoints = (allFlowRows || []).map((row) => [
      Date.parse(`${row.tanggal}T00:00:00Z`),
      Number(row.saldo ?? 0)
    ]);
    if (totalPoints.length > 0) {
      series.push({
        name: 'Total Saldo Liquid',
        data: totalPoints,
        color: '#04a5e5',
        lineWidth: 3
      });
    }
  } else {
    const byAccount = new Map();
    for (const row of perAccountRows || []) {
      const key = String(row.id);
      if (!selectedIds.has(key)) continue;
      if (!byAccount.has(key)) {
        byAccount.set(key, { name: row.nama || `Rekening #${key}`, data: [] });
      }
      byAccount.get(key).data.push([
        Date.parse(`${row.tanggal}T00:00:00Z`),
        Number(row.saldo ?? 0)
      ]);
    }
    for (const accSeries of byAccount.values()) {
      if (accSeries.data.length > 0) {
        series.push({
          name: accSeries.name,
          data: accSeries.data,
          lineWidth: 2.25
        });
      }
    }
  }

  if (series.length === 0) {
    chartContainer.innerHTML = '<div class="text-center text-muted py-5">Tidak ada data arus kas pada rentang tanggal ini.</div>';
    return;
  }

  cashFlowChart = window.Highcharts.chart(chartContainer, {
    chart: { type: 'spline', backgroundColor: 'transparent', height: 340 },
    title: { text: null },
    credits: { enabled: false },
    xAxis: { type: 'datetime', labels: { format: '{value:%d %b %Y}' } },
    yAxis: {
      title: { text: 'Saldo (IDR)' },
      labels: {
        formatter() {
          return formatIDR(this.value);
        }
      }
    },
    tooltip: { shared: true, xDateFormat: '%d %b %Y', valuePrefix: 'Rp ' },
    series
  });
}

function syncHutangFieldsVisibility(form) {
  const hutangCheckbox = form?.querySelector('#rek-hutang');
  const fieldsEl = form?.querySelector('#rek-hutang-fields');
  if (!hutangCheckbox || !fieldsEl) return;
  fieldsEl.classList.toggle('d-none', !hutangCheckbox.checked);
}

function openRekeningModal(account = null) {
  const dialogEl = rootContainer?.querySelector('#rekening-dialog');
  const form = rootContainer?.querySelector('#rekening-dialog form#form');
  const titleEl = rootContainer?.querySelector('#rekening-modal-title');
  if (!dialogEl || !form) return;

  form.reset();
  form.querySelector('#rek-id').value = account?.id ?? '';
  form.querySelector('#rek-nama').value = account?.nama ?? '';
  form.querySelector('#rek-no-asli').value = account?.no_asli ?? '';
  form.querySelector('#rek-jenis-uang').value = account?.jenis_uang ?? JENIS_UANG[0];
  form.querySelector('#rek-nominal-asing').value = account?.nominal_asing ?? '';
  form.querySelector('#rek-harta').checked = Boolean(account?.harta);
  form.querySelector('#rek-hutang').checked = Boolean(account?.hutang);
  form.querySelector('#rek-limit-kredit').value = account?.limit_kredit ?? 0;
  form.querySelector('#rek-tgl-tagihan').value = account?.tgl_tagihan ?? '';
  form.querySelector('#rek-tgl-jatuh-tempo').value = account?.tgl_jatuh_tempo ?? '';
  const isAktif = account ? Boolean(account.aktif) : true;
  form.querySelector('#rek-aktif').checked = isAktif;
  form.querySelector('#rek-tgl-dibuat').value = account?.tgl_dibuat ?? formatDBDate(new Date());
  const tglDitutupEl = form.querySelector('#rek-tgl-ditutup');
  tglDitutupEl.value = account?.tgl_ditutup ?? '';
  tglDitutupEl.disabled = isAktif;
  tglDitutupEl.required = !isAktif;
  form.querySelector('#rek-keterangan').value = account?.keterangan ?? '';
  syncHutangFieldsVisibility(form);

  if (titleEl) {
    titleEl.textContent = account ? `Edit Rekening: ${account.nama}` : 'Tambah Rekening Baru';
  }

  const submitBtn = form.querySelector('#btn-submit-rekening');
  if (submitBtn) {
    submitBtn.value = account ? 'Perbarui Rekening' : 'Tambah Rekening';
  }

  if (!dialogEl.open) {
    dialogEl.showModal();
  }
}

async function handleFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitBtn = form.querySelector('#btn-submit-rekening');
  const origVal = submitBtn?.value || 'Simpan';

  const id = form.querySelector('#rek-id').value.trim();
  const nama = form.querySelector('#rek-nama').value.trim();
  if (!nama) {
    showAlert('Nama rekening wajib diisi.', 'warning');
    return;
  }

  const isHarta = form.querySelector('#rek-harta').checked;
  const isHutang = !isHarta && form.querySelector('#rek-hutang').checked;

  const parseDay = (val) => {
    const trimmed = String(val || '').trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
  };

  const payload = {
    nama,
    no_asli: form.querySelector('#rek-no-asli').value.trim() || null,
    jenis_uang: form.querySelector('#rek-jenis-uang').value || JENIS_UANG[0],
    nominal_asing: form.querySelector('#rek-nominal-asing').value.trim().toUpperCase() || null,
    harta: isHarta,
    hutang: isHutang,
    limit_kredit: isHutang ? Math.max(0, Number(form.querySelector('#rek-limit-kredit').value) || 0) : 0,
    tgl_tagihan: isHutang ? parseDay(form.querySelector('#rek-tgl-tagihan').value) : null,
    tgl_jatuh_tempo: isHutang ? parseDay(form.querySelector('#rek-tgl-jatuh-tempo').value) : null,
    tgl_dibuat: form.querySelector('#rek-tgl-dibuat').value.trim() || null,
    aktif: form.querySelector('#rek-aktif').checked,
    tgl_ditutup: form.querySelector('#rek-aktif').checked ? null : (form.querySelector('#rek-tgl-ditutup').value.trim() || null),
    keterangan: form.querySelector('#rek-keterangan').value.trim() || null
  };

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.value = 'Memproses...';
  }
  try {
    if (id) {
      await rekeningModel.updateRekening(Number(id), payload);
      showAlert('Rekening berhasil diperbarui.', 'success');
    } else {
      await rekeningModel.insertRekening(payload);
      showAlert('Rekening baru berhasil ditambahkan.', 'success');
    }
    rootContainer?.querySelector('#rekening-dialog')?.close();
    window.dispatchEvent(new CustomEvent('kasin:db-updated', { detail: { source: 'rekening' } }));
  } catch (err) {
    console.error('Failed saving rekening:', err);
    showAlert(`Gagal menyimpan rekening: ${err.message || err}`, 'danger');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.value = origVal;
    }
  }
}

async function refreshData() {
  if (!isMounted || !rootContainer) return;

  try {
    const [summary, jenisRows, accounts] = await Promise.all([
      rekeningModel.getSaldoSummary(),
      rekeningModel.getSaldoByJenisUang(),
      rekeningModel.getAll()
    ]);

    if (!isMounted) return;

    accountsCache = accounts || [];
    renderSummarySection(summary, jenisRows);
    if (dtTable) {
      dtTable.clear().rows.add(accountsCache).draw(false);
      dtTable.responsive?.recalc();
    }
    await renderCashFlowChart();
  } catch (err) {
    console.error('Failed loading rekening view:', err);
    showAlert(`Gagal memuat data rekening: ${err.message || err}`, 'danger');
  }
}

function parseLocalDate(str) {
  if (!str) return new Date();
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function initDatePicker() {
  const startInput = rootContainer?.querySelector('#startDate');
  const endInput = rootContainer?.querySelector('#endDate');
  if (!startInput || !endInput || !window.flatpickr) return;

  destroyDatePicker();
  const plugins = window.rangePlugin ? [new window.rangePlugin({ input: endInput })] : [];
  datePicker = window.flatpickr(startInput, {
    disableMobile: true,
    plugins,
    maxDate: 'today',
    dateFormat: 'd M Y',
    defaultDate: [parseLocalDate(currentStartDate), parseLocalDate(currentEndDate)],
    onChange(selectedDates) {
      if (!selectedDates || selectedDates.length === 0) return;
      const start = selectedDates[0];
      const end = selectedDates[1] || start;
      currentStartDate = formatDBDate(start);
      currentEndDate = formatDBDate(end);
      if (selectedDates.length === 2 || plugins.length === 0) {
        renderCashFlowChart();
      }
    }
  });
}

function buildSkeletonHtml() {
  const jenisOptions = JENIS_UANG.map(
    (j) => `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`
  ).join('');

  return `
    <div class="container py-2">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h5 class="fw-bold mb-0"><i class="fas fa-wallet me-2" style="color: var(--primary-color);"></i>Rekening</h5>
        <button type="button" id="btn-add-rekening" class="btn btn-sm rounded-pill px-3 fw-semibold" style="background-color: var(--primary-color); border-color: var(--primary-color); color: var(--white-color);">
          <i class="fas fa-plus me-1"></i>Tambah Rekening
        </button>
      </div>

      <div class="card border-0 shadow-sm rounded-4 mb-3 text-white" style="background-color: var(--primary-color);">
        <div class="card-body p-4 text-center">
          <div class="text-uppercase small fw-bold opacity-75 mb-1">$ Net Worth $</div>
          <h2 id="rekening-net-worth" class="fw-bold mb-3">Rp 0</h2>
          <div class="row g-2 text-start">
            <div class="col-12 col-md-4">
              <div class="bg-white bg-opacity-10 rounded-3 p-2 px-3">
                <div class="small opacity-75">Liquid Cash</div>
                <div id="rekening-liquid-cash" class="fw-bold">Rp 0</div>
              </div>
            </div>
            <div class="col-12 col-md-4">
              <div class="bg-white bg-opacity-10 rounded-3 p-2 px-3">
                <div class="small opacity-75">Total Hutang / CC</div>
                <div id="rekening-total-debt" class="fw-bold">Rp 0</div>
              </div>
            </div>
            <div class="col-12 col-md-4">
              <div class="bg-white bg-opacity-10 rounded-3 p-2 px-3">
                <div class="small opacity-75">Aset / Harta</div>
                <div id="rekening-total-harta" class="fw-bold">Rp 0</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div id="rekening-jenis-uang-cards" class="row g-3 mb-4"></div>

      <div class="table-wrapper">
        <table data-label="List Rekening" class="table table-responsive myTable border-bottom" id="FormatTable">
          <thead class="sticky-top">
            <tr>
              <th scope="col" class="no-sort no-search"></th>
              <th scope="col" class="no-sort no-search"></th>
              <th scope="col" class="no-sort no-search">ID</th>
              <th scope="col" class="no-sort">Nama</th>
              <th scope="col" class="no-sort">Saldo</th>
              <th scope="col" class="no-sort">Jenis Uang</th>
              <th scope="col" class="no-sort">Keterangan</th>
              <th scope="col" class="no-sort"></th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="card rounded mb-4">
        <div class="card-body">
          <div class="date-range input-group">
            <input class="form-control" id="startDate" type="text" placeholder="Mulai" readonly>
            <span class="input-group-text">s/d</span>
            <input class="form-control" id="endDate" type="text" placeholder="Akhir" readonly>
          </div>
          <h5 class="mt-2 text-center fw-bolder card-title">Cashflow</h5>
          <div id="arusRekeningChart"></div>
        </div>
      </div>
    </div>

    <dialog id="rekening-dialog" style="width: min(88dvw, 560px); max-width: 95vw;">
      <div class="dialog-header mb-2">
        <h4 class="fw-bold w-100 text-center" id="rekening-modal-title">Tambah Rekening</h4>
        <form method="dialog">
          <button type="submit" aria-label="Tutup"><i class="fas fs-4 fw-bold fa-times"></i></button>
        </form>
      </div>
      <div class="dialog-body">
        <form id="form">
          <input type="hidden" id="rek-id">
          <div class="form-group">
            <label for="rek-nama">Nama Rekening</label>
            <input type="text" id="rek-nama" class="form-control" required maxlength="100" placeholder="Nama Rekening">
          </div>
          <div class="form-group">
            <label for="rek-no-asli">Ref Rekening Sebenarnya</label>
            <input type="text" id="rek-no-asli" class="form-control" maxlength="100" placeholder="Ref Rekening Sebenarnya">
            <span class="info"><small>Referensi / No. Rekening yang sebenarnya</small></span>
          </div>
          <div class="p-3 mb-4 border-bottom border-top border-2 border-primary form-check form-switch d-flex justify-content-between ps-0" style="font-size: .75em;font-weight: 600;">
            <label class="form-check-label text-primary w-100" for="rek-harta">Rekening Harta / Properti</label>
            <input class="form-check-input" type="checkbox" id="rek-harta">
          </div>
          <div class="p-3 mb-4 border-bottom border-top border-2 border-primary form-check form-switch d-flex justify-content-between ps-0" style="font-size: .75em;font-weight: 600;">
            <label class="form-check-label text-primary w-100" for="rek-hutang">Kartu Kredit / Pinjaman</label>
            <input class="form-check-input" type="checkbox" id="rek-hutang">
          </div>
          <div id="rek-hutang-fields" class="row g-2 mb-3 d-none">
            <div class="col-md-4 form-group mb-0">
              <label for="rek-limit-kredit">Limit Kredit</label>
              <input type="number" id="rek-limit-kredit" class="form-control" min="0" step="1000" value="0">
            </div>
            <div class="col-md-4 form-group mb-0">
              <label for="rek-tgl-tagihan">Tgl Tagihan</label>
              <input type="number" id="rek-tgl-tagihan" class="form-control" min="1" max="31" placeholder="1-31">
            </div>
            <div class="col-md-4 form-group mb-0">
              <label for="rek-tgl-jatuh-tempo">Tgl Jatuh Tempo</label>
              <input type="number" id="rek-tgl-jatuh-tempo" class="form-control" min="1" max="31" placeholder="1-31">
            </div>
          </div>
          <div class="form-group center-input">
            <label for="rek-jenis-uang">Jenis Uang</label>
            <select id="rek-jenis-uang" class="form-control">
              ${jenisOptions}
            </select>
          </div>
          <div class="form-group">
            <label for="rek-nominal-asing">Nominal Asing</label>
            <input type="text" id="rek-nominal-asing" class="form-control" maxlength="20" placeholder="USD, SGD, GRAM (opsional)">
            <span class="info"><small>Jika nilai/saldo Rekening tidak menggunakan Rupiah(Rp.)</small></span>
          </div>
          <div class="form-group">
            <label for="rek-tgl-dibuat">Tanggal Dibuat</label>
            <input type="date" id="rek-tgl-dibuat" class="form-control date-format">
          </div>
          <div class="p-3 mb-4 border-bottom border-top border-2 border-primary form-check form-switch d-flex justify-content-between ps-0" style="font-size: .75em;font-weight: 600;">
            <label class="form-check-label text-primary w-100" for="rek-aktif">Rekening Aktif</label>
            <input class="form-check-input" type="checkbox" id="rek-aktif" checked>
          </div>
          <div class="form-group">
            <label for="rek-tgl-ditutup">Tanggal Ditutup</label>
            <input type="date" id="rek-tgl-ditutup" class="form-control date-format" disabled>
          </div>
          <div class="form-group">
            <label for="rek-keterangan">Keterangan</label>
            <textarea id="rek-keterangan" class="form-control" rows="3" placeholder="Keterangan"></textarea>
          </div>
          <div class="form-group mb-0">
            <input type="submit" class="btn w-100 fw-bold" value="Tambah Rekening" id="btn-submit-rekening">
          </div>
        </form>
      </div>
    </dialog>
  `;
}

export async function mount(container, _params) {
  isMounted = true;
  rootContainer = container;

  const range = getDefaultDateRange();
  currentStartDate = range.start;
  currentEndDate = range.end;

  container.innerHTML = buildSkeletonHtml();

  const tableEl = container.querySelector('#FormatTable');
  if (window.DataTable && tableEl) {
    dtTable = new window.DataTable(tableEl, {
      dom: 'ftpl',
      pageLength: DATATABLE_PAGE_LENGTH,
      lengthMenu: DATATABLE_LENGTH_MENU,
      language: {
        lengthMenu: 'Per _MENU_ Data',
        zeroRecords: 'Tidak ada rekening',
        infoEmpty: 'Tidak ada rekening',
        search: '',
        paginate: {
          first: '⇚',
          last: '⇛',
          next: '⇒',
          previous: '⇐'
        }
      },
      bInfo: false,
      responsive: true,
      select: {
        style: 'multi',
        selector: 'td.dt-select'
      },
      order: [],
      columnDefs: [
        { targets: 'no-search', searchable: false },
        { targets: 'no-sort', orderable: false },
        { targets: [1], render: window.DataTable.render.select(), orderable: false },
        { responsivePriority: 1, targets: [2, 5, 6] },
        { responsivePriority: 0, targets: [0, 1, 3, 4, 7] }
      ],
      columns: [
        { className: 'dtr-control', data: null, defaultContent: '', title: '' },
        { data: 'id', title: '' },
        { data: 'id', title: 'ID', width: '5%' },
        {
          width: '30%',
          title: 'Nama',
          data: 'nama',
          render: (_item, _type, row) => {
            const saldo = Number(row.saldo ?? 0);
            const hartaBadge = row.harta ? '<span class="badge rounded-pill bg-danger ms-1">Properti</span>' : '';
            const hutangBadge = (!row.harta && (row.hutang || saldo < 0))
              ? '<span class="badge rounded-pill bg-warning text-dark ms-1">Hutang/CC</span>'
              : '';
            const inactiveBadge = !row.aktif ? '<span class="badge rounded-pill bg-secondary ms-1">Nonaktif</span>' : '';
            const noAsli = row.no_asli ? `<div class="kuitansi small fst-italic">No./Ref. Sebenarnya : ${escapeHtml(row.no_asli)}</div>` : '';
            const dibuat = row.tgl_dibuat ? `<div class="kuitansi small fst-italic">Dibuat : ${escapeHtml(toDateShortMonth(row.tgl_dibuat))}</div>` : '';
            const ditutup = !row.aktif && row.tgl_ditutup ? `<div class="kuitansi small fst-italic">Ditutup : ${escapeHtml(toDateShortMonth(row.tgl_ditutup))}</div>` : '';
            return `
              <div><strong>${escapeHtml(String(row.nama || '').toUpperCase())}&nbsp;${hartaBadge}${hutangBadge}${inactiveBadge}</strong></div>
              ${noAsli}
              ${dibuat}
              ${ditutup}
              ${renderHutangMetaHtml(row, saldo)}
            `;
          }
        },
        {
          width: '20%',
          title: 'Saldo',
          data: 'saldo',
          render: (val, type, row) => {
            const saldo = Number(val ?? 0);
            if (type === 'sort' || type === 'type') return saldo;
            const idrFmt = saldo.toLocaleString('id-ID');
            const nominalAsing = row.nominal_asing || '';
            if (nominalAsing.length > 0) {
              const asingFmt = Number(row.saldo_asing ?? 0).toLocaleString('id-ID');
              return `
                <span class="nominal fw-bold text-primary">${escapeHtml(asingFmt)} ${escapeHtml(nominalAsing)}</span><br>
                <span class="small text-secondary">Rp.&nbsp;${escapeHtml(idrFmt)},-</span>
              `;
            }
            return `<span class="nominal fw-bold text-primary">Rp.&nbsp;${escapeHtml(idrFmt)},-</span>`;
          }
        },
        {
          width: '20%',
          data: 'jenis_uang',
          title: 'Jenis Uang',
          render: (val) => {
            const colorMap = {
              'Uang Hijau': 'text-success',
              'Uang Merah': 'text-danger',
              'Uang Biru': 'text-primary'
            };
            const jenis = val || '';
            const colorClass = colorMap[jenis] || 'text-secondary';
            return `<span class="${colorClass}">${escapeHtml(jenis || 'Tidak Ditentukan')}</span>`;
          }
        },
        {
          data: 'keterangan',
          title: 'Keterangan',
          render: (val) => escapeHtml(val || '-')
        },
        {
          data: 'id',
          title: '',
          render: (id) => `<a href="#/transactions?rekening=${encodeURIComponent(id)}" class="btn btn-sm btn-link" title="Mutasi Rekening"><i class="fas fa-exchange-alt"></i></a>`
        }
      ],
      initComplete() {
        const input = container.querySelector('#FormatTable_wrapper .dt-search input');
        if (input) {
          input.placeholder = '🔍 Cari Disini...';
        }
      },
      createdRow(rowEl, rowData) {
        rowEl.setAttribute('data-id', String(rowData.id));
        rowEl.setAttribute('title', 'Klik 2x untuk melakukan edit');
        rowEl.querySelectorAll('td').forEach((td, index) => {
          const header = this.api().column(index).header();
          td.setAttribute('data-label', header.textContent);
        });
      }
    });

    dtTable.on('select deselect', () => {
      renderCashFlowChart();
    });
  }

  container.querySelector('#btn-add-rekening')?.addEventListener('click', () => openRekeningModal(null));

  const tbody = container.querySelector('#FormatTable tbody');
  if (tbody) {
    tbody.addEventListener('click', (event) => {
      const btn = event.target.closest('.btn-edit-rekening');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const account = accountsCache.find((a) => String(a.id) === String(id));
      if (account) openRekeningModal(account);
    });

    tbody.addEventListener('dblclick', (event) => {
      if (event.target.closest('a, button, input, td.dt-select, td.dtr-control')) return;
      const row = event.target.closest('tr[data-id]');
      if (!row) return;
      const id = row.getAttribute('data-id');
      const account = accountsCache.find((a) => String(a.id) === String(id));
      if (account) openRekeningModal(account);
    });
  }

  const dialogEl = container.querySelector('#rekening-dialog');
  dialogEl?.addEventListener('click', (e) => {
    if (e.target === dialogEl) dialogEl.close();
  });

  const form = container.querySelector('#rekening-dialog form#form');
  if (form) {
    form.addEventListener('submit', handleFormSubmit);
    const aktifSwitch = form.querySelector('#rek-aktif');
    const tglDitutup = form.querySelector('#rek-tgl-ditutup');
    if (aktifSwitch && tglDitutup) {
      aktifSwitch.addEventListener('change', () => {
        tglDitutup.disabled = aktifSwitch.checked;
        tglDitutup.required = !aktifSwitch.checked;
      });
    }
    const hartaSwitch = form.querySelector('#rek-harta');
    const hutangSwitch = form.querySelector('#rek-hutang');
    if (hartaSwitch && hutangSwitch) {
      hartaSwitch.addEventListener('change', () => {
        if (hartaSwitch.checked) hutangSwitch.checked = false;
        syncHutangFieldsVisibility(form);
      });
      hutangSwitch.addEventListener('change', () => {
        if (hutangSwitch.checked) hartaSwitch.checked = false;
        syncHutangFieldsVisibility(form);
      });
    }
  }

  initDatePicker();

  dbUpdatedHandler = () => {
    refreshData();
  };
  window.addEventListener('kasin:db-updated', dbUpdatedHandler);

  await refreshData();
}

export function unmount() {
  isMounted = false;
  if (dbUpdatedHandler) {
    window.removeEventListener('kasin:db-updated', dbUpdatedHandler);
    dbUpdatedHandler = null;
  }
  if (dtTable) {
    try {
      dtTable.destroy();
    } catch {
      // Ignore
    }
    dtTable = null;
  }
  destroyChart();
  destroyDatePicker();
  destroyModal();
  accountsCache = [];
  rootContainer = null;
}
