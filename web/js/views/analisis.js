import { escapeHtml, formatIDR, formatDBDate, showAlert } from '../utils.js';
import * as transaksiModel from '../models/transaksi.js';

const PRESET_STORAGE_KEY = 'kasin_analisis_presets_v1';
const DEFAULT_CHART_TARGET = 'chart';
const STYLE_ID = 'kasin-analisis-styles';
const ANALISIS_CSS = `
  .analisis-title {
    color: var(--primary-color);
    font-family: var(--font-head);
  }
  .analisis-card {
    border: 1px solid color-mix(in srgb, var(--primary-color) 22%, transparent);
    border-radius: 12px;
    background-color: var(--bg-color);
    box-shadow: 0 2px 10px color-mix(in srgb, var(--shadow-color, var(--black-color)) 8%, transparent);
  }
  .analisis-btn-primary {
    background-color: var(--primary-color);
    color: var(--white-color);
    border: none;
  }
  .analisis-btn-primary:hover,
  .analisis-btn-primary:focus {
    background-color: var(--primary-color-alt);
    color: var(--white-color);
  }
  .analisis-btn-primary:disabled {
    background-color: var(--primary-color);
    color: var(--white-color);
    opacity: 0.6;
  }
  .analisis-btn-outline {
    background-color: transparent;
    color: var(--primary-color);
    border: 1.5px solid var(--primary-color);
  }
  .analisis-btn-outline:hover,
  .analisis-btn-outline:focus {
    background-color: color-mix(in srgb, var(--primary-color) 10%, transparent);
    color: var(--primary-color-alt);
  }
  .analisis-btn-outline:disabled {
    color: var(--primary-color);
    border-color: var(--primary-color);
    opacity: 0.5;
  }
  .analisis-btn-danger {
    background-color: transparent;
    color: var(--red-color);
    border: 1.5px solid var(--red-color);
  }
  .analisis-btn-danger:hover,
  .analisis-btn-danger:focus {
    background-color: var(--red-color);
    color: var(--white-color);
  }
  .analisis-btn-danger:disabled {
    color: var(--red-color);
    border-color: var(--red-color);
    opacity: 0.5;
  }
  .analisis-status-bar {
    background-color: var(--white-color-0);
    border-left: 3px solid var(--primary-color);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
  }
`;
const WEBMCP_ANALISIS_TOOL_NAMES = [
  'get_raw_transactions',
  'transform_data',
  'update_chart_config',
  'delete_chart'
];

let isMounted = false;
let rootContainer = null;
let datePicker = null;
let kelompokChart = null;
let rutinChart = null;
let dailyTrendChart = null;
let viewAbortController = null;

let currentStartDate = '';
let currentEndDate = '';

// Dynamic WebMCP chart engine state
let currentRawData = [];
let currentGraphData = null;
let lastTransformCode = null;
let dynamicCharts = {}; // containerId -> { target, code, optionsBuilder, options, instance }

function getDefaultMonthRange() {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    start: formatDBDate(firstOfMonth),
    end: formatDBDate(now)
  };
}

function isValidYmdDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return false;
  }
  const [y, m, d] = value.trim().split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
}

function getRowAmount(row) {
  const nominal = Number(row.nominal) || 0;
  const qty = row.kuantitas !== null && row.kuantitas !== undefined ? Number(row.kuantitas) : 1;
  return nominal * (Number.isFinite(qty) ? qty : 1);
}

function mapRawRow(row) {
  const nominal = Number(row.nominal) || 0;
  const rawQty = row.kuantitas !== null && row.kuantitas !== undefined ? Number(row.kuantitas) : 1;
  const kuantitas = Number.isFinite(rawQty) ? rawQty : 1;
  const total = nominal * kuantitas;

  let rekening = '';
  if (row.jenis_transaksi === 'Pindah Buku') {
    rekening = [row.nama_rekening_sumber, row.nama_rekening_masuk].filter(Boolean).join(' -> ');
  } else if (row.jenis_transaksi === 'Pemasukan') {
    rekening = row.nama_rekening_masuk || row.nama_rekening_sumber || '';
  } else {
    rekening = row.nama_rekening_sumber || row.nama_rekening_masuk || '';
  }

  return {
    id: row.id,
    jenis_transaksi: row.jenis_transaksi || '',
    barang: row.barang || '',
    rekening,
    nominal,
    kuantitas,
    total,
    rutin: Boolean(row.rutin),
    kelompok: row.kelompok || '',
    tanggal: row.tanggal || '',
    keterangan: row.keterangan || ''
  };
}

function destroyCharts() {
  for (const chart of [kelompokChart, rutinChart, dailyTrendChart]) {
    if (chart) {
      try {
        chart.destroy();
      } catch {
        // Ignore Highcharts destroy errors
      }
    }
  }
  kelompokChart = null;
  rutinChart = null;
  dailyTrendChart = null;
}

function containerIdFor(target) {
  const t = (target && String(target).trim()) || DEFAULT_CHART_TARGET;
  if (t === DEFAULT_CHART_TARGET) return DEFAULT_CHART_TARGET;
  const safe = t
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `chart-${safe || 'extra'}`;
}

function getChartsContainerEl() {
  return rootContainer?.querySelector('#charts-container') || null;
}

function getOrCreateChartContainer(target) {
  const container = getChartsContainerEl();
  const id = containerIdFor(target);
  if (!container) return id;

  let el = container.querySelector(`#${CSS.escape(id)}`);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    if (id !== DEFAULT_CHART_TARGET) {
      el.className = 'mt-3';
    }
    container.appendChild(el);
  }
  return id;
}

function removeChartContainer(id) {
  const container = getChartsContainerEl();
  if (!container) return;
  const el = container.querySelector(`#${CSS.escape(id)}`);
  if (!el) return;
  if (id === DEFAULT_CHART_TARGET) {
    el.innerHTML = '';
  } else {
    el.remove();
  }
}

function resetChartsContainer() {
  const container = getChartsContainerEl();
  if (!container) return;
  container.innerHTML = `<div id="${DEFAULT_CHART_TARGET}"></div>`;
}

function destroyDynamicCharts({ resetDom = false } = {}) {
  for (const id of Object.keys(dynamicCharts)) {
    const entry = dynamicCharts[id];
    if (entry?.instance) {
      try {
        entry.instance.destroy();
      } catch {
        // Ignore Highcharts destroy errors
      }
    }
  }
  dynamicCharts = {};
  if (resetDom) {
    resetChartsContainer();
  }
}

function destroyDatePicker() {
  if (datePicker) {
    try {
      datePicker.destroy();
    } catch {
      // Ignore Flatpickr destroy errors
    }
    datePicker = null;
  }
}

function setAiStatus(text, isError = false) {
  const statusEl = rootContainer?.querySelector('#analisis-ai-status');
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('text-danger', Boolean(isError));
  statusEl.classList.toggle('text-muted', !isError);
}

function updatePresetButtons() {
  const selectEl = rootContainer?.querySelector('#preset-select');
  const loadBtn = rootContainer?.querySelector('#preset-load');
  const deleteBtn = rootContainer?.querySelector('#preset-delete');
  const saveBtn = rootContainer?.querySelector('#preset-save');

  const hasSelection = Boolean(selectEl?.value);
  if (loadBtn) loadBtn.disabled = !hasSelection;
  if (deleteBtn) deleteBtn.disabled = !hasSelection;
  if (saveBtn) saveBtn.disabled = Object.keys(dynamicCharts).length === 0;
}

function renderLog() {
  const logEl = rootContainer?.querySelector('#analisis-transform-log');
  if (!logEl) return;

  const ids = Object.keys(dynamicCharts);
  if (ids.length === 0) {
    logEl.textContent = lastTransformCode
      ? `// Step 2: transform_data (belum dipakai di grafik manapun)\n${lastTransformCode.trim()}`
      : 'Belum ada transformasi yang dijalankan.';
    return;
  }

  logEl.textContent = ids
    .map((id) => {
      const c = dynamicCharts[id];
      const parts = [`// Grafik "${c.target}" (#${id})`];
      if (c.code) {
        parts.push(`// Step 2: transform_data\n${c.code.trim()}`);
      }
      parts.push(
        c.optionsBuilder
          ? `// Step 3: update_chart_config (optionsBuilder, auto-refresh aktif)\n${c.optionsBuilder.trim()}`
          : `// Step 3: update_chart_config (options statis, tidak auto-refresh)\n${JSON.stringify(c.options, null, 2)}`
      );
      return parts.join('\n');
    })
    .join('\n\n---\n\n');
}

function getPresets() {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function savePresets(presets) {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
  } catch (err) {
    console.error('Failed saving analisis presets:', err);
    showAlert(`Gagal menyimpan preset: ${err.message || err}`, 'danger');
  }
}

function refreshPresetSelect(selectedName = '') {
  const selectEl = rootContainer?.querySelector('#preset-select');
  if (!selectEl) return;

  const presets = getPresets();
  const names = Object.keys(presets);
  selectEl.innerHTML =
    '<option value="">Preset tersimpan...</option>' +
    names
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
      .join('');

  if (selectedName && Object.hasOwn(presets, selectedName)) {
    selectEl.value = selectedName;
  }
  updatePresetButtons();
}

function refreshDynamicCharts() {
  if (!window.Highcharts) return 0;

  let refreshed = 0;
  for (const id of Object.keys(dynamicCharts)) {
    const c = dynamicCharts[id];
    if (!c || !c.optionsBuilder) continue;

    try {
      const graphData = c.code ? new Function('rawData', c.code)(currentRawData) : null;
      if (c.code) {
        currentGraphData = graphData;
      }
      const options = new Function('graphData', 'rawData', c.optionsBuilder)(graphData, currentRawData);
      if (!options || typeof options !== 'object') {
        throw new Error('optionsBuilder harus mengembalikan objek Highcharts.Options.');
      }
      const targetId = getOrCreateChartContainer(c.target);
      try {
        c.instance?.destroy();
      } catch {
        // Ignore Highcharts destroy errors
      }
      c.instance = window.Highcharts.chart(targetId, options);
      c.options = options;
      refreshed += 1;
    } catch (err) {
      setAiStatus(`Gagal memperbarui grafik "${c.target}" setelah ganti tanggal: ${err.message || err}`, true);
    }
  }

  if (refreshed > 0) {
    renderLog();
  }
  return refreshed;
}

async function promptPresetName() {
  if (window.Swal && typeof window.Swal.fire === 'function') {
    const result = await window.Swal.fire({
      title: 'Simpan Preset Grafik',
      input: 'text',
      inputLabel: 'Nama preset',
      inputPlaceholder: 'Misal: Ringkasan Bulanan',
      showCancelButton: true,
      confirmButtonText: 'Simpan',
      cancelButtonText: 'Batal',
      inputValidator: (value) => {
        if (!value || !String(value).trim()) {
          return 'Nama preset tidak boleh kosong.';
        }
        return null;
      }
    });
    if (!result.isConfirmed) return null;
    return String(result.value || '').trim();
  }

  const raw = window.prompt('Nama preset:');
  if (raw === null) return null;
  return String(raw).trim();
}

async function confirmPresetDelete(name) {
  if (window.Swal && typeof window.Swal.fire === 'function') {
    const result = await window.Swal.fire({
      title: 'Hapus Preset?',
      text: `Hapus preset "${name}"?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Hapus',
      cancelButtonText: 'Batal',
      confirmButtonColor: '#d20f39'
    });
    return Boolean(result.isConfirmed);
  }
  return window.confirm(`Hapus preset "${name}"?`);
}

async function handlePresetSave() {
  const ids = Object.keys(dynamicCharts);
  if (ids.length === 0) return;

  const name = await promptPresetName();
  if (!name) return;

  const presets = getPresets();
  presets[name] = {
    charts: ids.map((id) => ({
      target: dynamicCharts[id].target,
      code: dynamicCharts[id].code,
      optionsBuilder: dynamicCharts[id].optionsBuilder,
      options: dynamicCharts[id].options
    }))
  };
  savePresets(presets);
  refreshPresetSelect(name);
  setAiStatus(`Preset "${name}" disimpan (${ids.length} grafik).`);
}

function handlePresetLoad() {
  const selectEl = rootContainer?.querySelector('#preset-select');
  const name = selectEl?.value;
  if (!name) return;

  if (!window.Highcharts) {
    setAiStatus('Highcharts tidak tersedia untuk memuat preset.', true);
    return;
  }

  const preset = getPresets()[name];
  if (!preset) return;

  // Backward-compatible with single-chart presets ({ code, options })
  const chartList =
    Array.isArray(preset.charts) && preset.charts.length > 0
      ? preset.charts
      : preset.options || preset.optionsBuilder
        ? [
            {
              target: DEFAULT_CHART_TARGET,
              code: preset.code || null,
              optionsBuilder: preset.optionsBuilder || null,
              options: preset.options || null
            }
          ]
        : [];

  if (chartList.length === 0) return;

  try {
    destroyDynamicCharts({ resetDom: true });

    for (const c of chartList) {
      let graphData = null;
      if (currentRawData.length > 0 && c.code) {
        try {
          graphData = new Function('rawData', c.code)(currentRawData);
          currentGraphData = graphData;
        } catch {
          // Keep graphData null if transform fails on current range
        }
      }

      let resolvedOptions = c.options;
      if (c.optionsBuilder) {
        try {
          const built = new Function('graphData', 'rawData', c.optionsBuilder)(graphData, currentRawData);
          if (built && typeof built === 'object') {
            resolvedOptions = built;
          }
        } catch {
          resolvedOptions = c.options;
        }
      }

      if (!resolvedOptions || typeof resolvedOptions !== 'object') {
        throw new Error(`Konfigurasi grafik "${c.target || DEFAULT_CHART_TARGET}" tidak valid.`);
      }

      const target = (c.target && String(c.target).trim()) || DEFAULT_CHART_TARGET;
      const id = getOrCreateChartContainer(target);
      const instance = window.Highcharts.chart(id, resolvedOptions);
      dynamicCharts[id] = {
        target,
        code: c.code || null,
        optionsBuilder: c.optionsBuilder || null,
        options: resolvedOptions,
        instance
      };
      if (c.code) {
        lastTransformCode = c.code;
      }
    }

    updatePresetButtons();
    renderLog();
    setAiStatus(`Preset "${name}" dimuat (${chartList.length} grafik).`);
  } catch (err) {
    setAiStatus(`Gagal memuat preset: ${err.message || err}`, true);
  }
}

async function handlePresetDelete() {
  const selectEl = rootContainer?.querySelector('#preset-select');
  const name = selectEl?.value;
  if (!name) return;

  const confirmed = await confirmPresetDelete(name);
  if (!confirmed || !isMounted) return;

  const presets = getPresets();
  delete presets[name];
  savePresets(presets);
  refreshPresetSelect();
  setAiStatus(`Preset "${name}" dihapus.`);
}

function renderSummaryKpis(rows) {
  let totalMasuk = 0;
  let totalKeluar = 0;
  let countKeluar = 0;

  for (const row of rows) {
    if (Boolean(row.harta)) continue;
    const amount = getRowAmount(row);
    if (row.jenis_transaksi === 'Pemasukan') {
      totalMasuk += amount;
    } else if (row.jenis_transaksi === 'Pengeluaran') {
      totalKeluar += amount;
      countKeluar += 1;
    }
  }

  const net = totalMasuk - totalKeluar;
  const masukEl = rootContainer?.querySelector('#analisis-total-masuk');
  const keluarEl = rootContainer?.querySelector('#analisis-total-keluar');
  const netEl = rootContainer?.querySelector('#analisis-net-cashflow');
  const countEl = rootContainer?.querySelector('#analisis-tx-count');

  if (masukEl) masukEl.textContent = formatIDR(totalMasuk);
  if (keluarEl) keluarEl.textContent = formatIDR(totalKeluar);
  if (netEl) {
    netEl.textContent = formatIDR(net);
    netEl.className = `fs-5 fw-bold ${net >= 0 ? 'text-success' : 'text-danger'}`;
  }
  if (countEl) countEl.textContent = `${countKeluar} pengeluaran / ${rows.length} total`;
}

function renderKelompokChart(spendingRows) {
  const el = rootContainer?.querySelector('#analisis-kelompok-chart');
  if (!el) return;

  if (!window.Highcharts) {
    el.innerHTML = '<div class="text-center text-muted py-4">Highcharts tidak tersedia.</div>';
    return;
  }

  const totals = new Map();
  for (const row of spendingRows) {
    const key = row.kelompok && String(row.kelompok).trim() ? String(row.kelompok).trim() : 'Lainnya';
    totals.set(key, (totals.get(key) || 0) + getRowAmount(row));
  }

  const data = Array.from(totals.entries())
    .map(([name, y]) => ({ name, y }))
    .filter((d) => d.y > 0)
    .sort((a, b) => b.y - a.y);

  if (data.length === 0) {
    el.innerHTML = '<div class="text-center text-muted py-5">Tidak ada data pengeluaran pada rentang ini.</div>';
    return;
  }

  kelompokChart = window.Highcharts.chart(el, {
    chart: {
      type: 'pie',
      backgroundColor: 'transparent',
      height: 320
    },
    title: { text: null },
    credits: { enabled: false },
    tooltip: {
      pointFormatter() {
        return `<span style="color:${this.color}">\u25CF</span> <b>${formatIDR(this.y)}</b> (${this.percentage.toFixed(1)}%)<br/>`;
      }
    },
    plotOptions: {
      pie: {
        innerSize: '52%',
        allowPointSelect: true,
        cursor: 'pointer',
        dataLabels: {
          enabled: true,
          format: '<b>{point.name}</b>: {point.percentage:.1f}%'
        }
      }
    },
    series: [{
      name: 'Pengeluaran',
      data
    }]
  });
}

function renderRutinChart(cashRows) {
  const el = rootContainer?.querySelector('#analisis-rutin-chart');
  if (!el) return;

  if (!window.Highcharts) {
    el.innerHTML = '<div class="text-center text-muted py-4">Highcharts tidak tersedia.</div>';
    return;
  }

  let keluarRutin = 0;
  let keluarNonRutin = 0;
  let masukRutin = 0;
  let masukNonRutin = 0;

  for (const row of cashRows) {
    const amount = getRowAmount(row);
    const isRutin = Boolean(row.rutin);
    if (row.jenis_transaksi === 'Pengeluaran') {
      if (isRutin) keluarRutin += amount;
      else keluarNonRutin += amount;
    } else if (row.jenis_transaksi === 'Pemasukan') {
      if (isRutin) masukRutin += amount;
      else masukNonRutin += amount;
    }
  }

  if (keluarRutin + keluarNonRutin + masukRutin + masukNonRutin === 0) {
    el.innerHTML = '<div class="text-center text-muted py-5">Tidak ada data transaksi pada rentang ini.</div>';
    return;
  }

  rutinChart = window.Highcharts.chart(el, {
    chart: {
      type: 'column',
      backgroundColor: 'transparent',
      height: 320
    },
    title: { text: null },
    credits: { enabled: false },
    xAxis: {
      categories: ['Pengeluaran', 'Pemasukan']
    },
    yAxis: {
      min: 0,
      title: { text: 'Nominal (IDR)' },
      labels: {
        formatter() {
          return formatIDR(this.value);
        }
      }
    },
    tooltip: {
      shared: true,
      valuePrefix: 'Rp '
    },
    series: [
      {
        name: 'Rutin',
        data: [keluarRutin, masukRutin],
        color: '#04a5e5'
      },
      {
        name: 'Non-Rutin',
        data: [keluarNonRutin, masukNonRutin],
        color: '#fe640b'
      }
    ]
  });
}

function renderDailyTrendChart(cashRows) {
  const el = rootContainer?.querySelector('#analisis-trend-chart');
  if (!el) return;

  if (!window.Highcharts) {
    el.innerHTML = '<div class="text-center text-muted py-4">Highcharts tidak tersedia.</div>';
    return;
  }

  const byDate = new Map();
  for (const row of cashRows) {
    if (!row.tanggal) continue;
    if (row.jenis_transaksi !== 'Pemasukan' && row.jenis_transaksi !== 'Pengeluaran') continue;

    if (!byDate.has(row.tanggal)) {
      byDate.set(row.tanggal, { masuk: 0, keluar: 0 });
    }
    const entry = byDate.get(row.tanggal);
    const amount = getRowAmount(row);
    if (row.jenis_transaksi === 'Pemasukan') {
      entry.masuk += amount;
    } else {
      entry.keluar += amount;
    }
  }

  const sortedDates = Array.from(byDate.keys()).sort();
  if (sortedDates.length === 0) {
    el.innerHTML = '<div class="text-center text-muted py-5">Tidak ada tren harian pada rentang ini.</div>';
    return;
  }

  const masukData = sortedDates.map((d) => [Date.parse(`${d}T00:00:00Z`), byDate.get(d).masuk]);
  const keluarData = sortedDates.map((d) => [Date.parse(`${d}T00:00:00Z`), byDate.get(d).keluar]);

  dailyTrendChart = window.Highcharts.chart(el, {
    chart: {
      type: 'areaspline',
      backgroundColor: 'transparent',
      height: 300
    },
    title: { text: null },
    credits: { enabled: false },
    xAxis: {
      type: 'datetime',
      labels: { format: '{value:%d %b}' }
    },
    yAxis: {
      min: 0,
      title: { text: 'Nominal (IDR)' },
      labels: {
        formatter() {
          return formatIDR(this.value);
        }
      }
    },
    tooltip: {
      shared: true,
      xDateFormat: '%d %b %Y',
      valuePrefix: 'Rp '
    },
    plotOptions: {
      areaspline: {
        fillOpacity: 0.15
      }
    },
    series: [
      {
        name: 'Pengeluaran',
        data: keluarData,
        color: '#d20f39'
      },
      {
        name: 'Pemasukan',
        data: masukData,
        color: '#40a02b'
      }
    ]
  });
}

function renderTopItemsTable(spendingRows) {
  const tbody = rootContainer?.querySelector('#analisis-top-items-body');
  if (!tbody) return;

  const topItems = [...spendingRows]
    .map((row) => ({
      ...row,
      totalAmount: getRowAmount(row)
    }))
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, 10);

  if (topItems.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="text-center text-muted py-4">Tidak ada pengeluaran pada rentang tanggal ini.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = topItems
    .map((item, idx) => {
      const rutinBadge = Boolean(item.rutin)
        ? '<span class="badge text-bg-info ms-1">Rutin</span>'
        : '<span class="badge text-bg-light text-dark border ms-1">Non-Rutin</span>';
      const kelompok = item.kelompok && String(item.kelompok).trim() ? item.kelompok : 'Lainnya';

      return `
      <tr>
        <td class="text-muted fw-semibold">${idx + 1}</td>
        <td>
          <div class="fw-semibold">${escapeHtml(item.barang || '-')}</div>
          <div class="small text-muted">${escapeHtml(item.tanggal || '')}${rutinBadge}</div>
        </td>
        <td><span class="badge text-bg-secondary">${escapeHtml(kelompok)}</span></td>
        <td class="text-end fw-bold text-danger text-nowrap">${escapeHtml(formatIDR(item.totalAmount))}</td>
      </tr>
    `;
    })
    .join('');
}

async function refreshData() {
  if (!isMounted || !rootContainer) return;

  setAiStatus('Memuat data transaksi...');
  try {
    const rows = await transaksiModel.getInRange(currentStartDate, currentEndDate);
    if (!isMounted) return;

    const safeRows = rows || [];
    currentRawData = safeRows.map(mapRawRow);
    currentGraphData = null;

    const cashRows = safeRows.filter((r) => !Boolean(r.harta));
    const spendingRows = cashRows.filter((r) => r.jenis_transaksi === 'Pengeluaran');

    destroyCharts();
    renderSummaryKpis(safeRows);
    renderKelompokChart(spendingRows);
    renderRutinChart(cashRows);
    renderDailyTrendChart(cashRows);
    renderTopItemsTable(spendingRows);

    const refreshed = refreshDynamicCharts();
    setAiStatus(
      refreshed > 0
        ? `Data siap: ${currentRawData.length} transaksi. ${refreshed} grafik dinamis diperbarui otomatis.`
        : `Data siap: ${currentRawData.length} transaksi. Minta AI (WebMCP) atau muat preset untuk grafik dinamis.`
    );
  } catch (err) {
    console.error('Failed loading analisis view:', err);
    setAiStatus(`Gagal memuat data: ${err.message || err}`, true);
    showAlert(`Gagal memuat analisis: ${err.message || err}`, 'danger');
  }
}

function initDatePicker() {
  const input = rootContainer?.querySelector('#analisis-date-range');
  if (!input || !window.flatpickr) return;

  destroyDatePicker();
  datePicker = window.flatpickr(input, {
    disableMobile: true,
    mode: 'range',
    dateFormat: 'Y-m-d',
    altInput: true,
    altFormat: 'd M Y',
    altInputClass: 'form-control',
    defaultDate: [currentStartDate, currentEndDate],
    onClose(selectedDates) {
      if (selectedDates.length === 2) {
        currentStartDate = formatDBDate(selectedDates[0]);
        currentEndDate = formatDBDate(selectedDates[1]);
        refreshData();
      }
    }
  });
}

function bindDynamicChartEvents(signal) {
  const toggleLogBtn = rootContainer?.querySelector('#btn-toggle-log');
  const logEl = rootContainer?.querySelector('#analisis-transform-log');
  const presetSelect = rootContainer?.querySelector('#preset-select');
  const presetLoadBtn = rootContainer?.querySelector('#preset-load');
  const presetSaveBtn = rootContainer?.querySelector('#preset-save');
  const presetDeleteBtn = rootContainer?.querySelector('#preset-delete');

  if (toggleLogBtn && logEl) {
    toggleLogBtn.addEventListener(
      'click',
      () => {
        const isHidden = logEl.classList.contains('d-none');
        logEl.classList.toggle('d-none', !isHidden);
        toggleLogBtn.textContent = isHidden ? 'Sembunyikan Log Transformasi' : 'Log Transformasi';
      },
      { signal }
    );
  }

  if (presetSelect) {
    presetSelect.addEventListener('change', () => updatePresetButtons(), { signal });
  }

  if (presetLoadBtn) {
    presetLoadBtn.addEventListener('click', () => handlePresetLoad(), { signal });
  }

  if (presetSaveBtn) {
    presetSaveBtn.addEventListener('click', () => handlePresetSave(), { signal });
  }

  if (presetDeleteBtn) {
    presetDeleteBtn.addEventListener('click', () => handlePresetDelete(), { signal });
  }
}

function createWebMCPAnalyticsTools() {
  const ensureMounted = () => {
    if (!isMounted || !rootContainer) {
      return {
        success: false,
        error: 'Halaman Analisis sedang tidak aktif. Buka halaman Analisis terlebih dahulu.'
      };
    }
    return null;
  };

  return [
    {
      name: 'get_raw_transactions',
      description:
        'Langkah 1: Mendapatkan baris data transaksi mentah sesuai rentang tanggal aktif di halaman Analisis. Kirim startDate & endDate (format YYYY-MM-DD) untuk mengubah periode dan memuat ulang data.',
      inputSchema: {
        type: 'object',
        properties: {
          startDate: {
            type: 'string',
            description: 'Format YYYY-MM-DD, opsional. Jika diisi bersama endDate, memperbarui periode aktif.'
          },
          endDate: {
            type: 'string',
            description: 'Format YYYY-MM-DD, opsional.'
          }
        }
      },
      execute: async (params = {}) => {
        const guardError = ensureMounted();
        if (guardError) return guardError;

        if (params && (params.startDate || params.endDate)) {
          if (!isValidYmdDate(params.startDate) || !isValidYmdDate(params.endDate)) {
            return {
              success: false,
              error: 'startDate dan endDate harus berformat YYYY-MM-DD yang valid.'
            };
          }
          currentStartDate = params.startDate.trim();
          currentEndDate = params.endDate.trim();
          if (datePicker && typeof datePicker.setDate === 'function') {
            try {
              datePicker.setDate([currentStartDate, currentEndDate], false);
            } catch {
              // Ignore Flatpickr setDate errors
            }
          }
        }

        await refreshData();
        if (!isMounted) {
          return {
            success: false,
            error: 'Halaman Analisis ditutup saat memuat data.'
          };
        }

        return {
          success: true,
          startDate: currentStartDate,
          endDate: currentEndDate,
          count: currentRawData.length,
          data: currentRawData
        };
      }
    },
    {
      name: 'transform_data',
      description:
        'Langkah 2: Menjalankan kode JavaScript dengan parameter `rawData` untuk mentransformasi transaksi mentah menjadi data grafik. Wajib menggunakan `return`.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Body fungsi JS menerima `rawData` dan mengembalikan hasil transformasi.'
          }
        },
        required: ['code']
      },
      execute: async (params = {}) => {
        const guardError = ensureMounted();
        if (guardError) return guardError;

        if (!params || typeof params.code !== 'string' || !params.code.trim()) {
          return {
            success: false,
            error: 'Parameter "code" (string) wajib diisi.'
          };
        }

        try {
          const transformFn = new Function('rawData', params.code);
          const data = transformFn(currentRawData);
          currentGraphData = data;
          lastTransformCode = params.code;
          renderLog();
          setAiStatus('Transformasi data berhasil dijalankan oleh AI.');
          return {
            success: true,
            data
          };
        } catch (err) {
          setAiStatus(`Transformasi data gagal: ${err.message || err}`, true);
          return {
            success: false,
            error: err.message || String(err)
          };
        }
      }
    },
    {
      name: 'update_chart_config',
      description:
        'Langkah 3: Merender grafik Highcharts dinamis di halaman Analisis. Mendukung multi-grafik via parameter "target". Direkomendasikan mengirim "optionsBuilder" agar otomatis diperbarui saat periode tanggal berubah.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Nama target grafik (opsional, default: "chart").'
          },
          options: {
            type: 'object',
            description: 'Objek Highcharts.Options statis.'
          },
          optionsBuilder: {
            type: 'string',
            description:
              'Body fungsi JS menerima `(graphData, rawData)` dan mengembalikan objek Highcharts.Options.'
          }
        }
      },
      execute: async (params = {}) => {
        const guardError = ensureMounted();
        if (guardError) return guardError;

        if (!window.Highcharts) {
          return {
            success: false,
            error: 'Highcharts tidak tersedia di halaman ini.'
          };
        }

        if (!params || (!params.options && !params.optionsBuilder)) {
          return {
            success: false,
            error: 'Wajib mengisi salah satu: "options" atau "optionsBuilder".'
          };
        }

        try {
          const target = (params.target && String(params.target).trim()) || DEFAULT_CHART_TARGET;
          const containerId = getOrCreateChartContainer(target);

          let resolvedOptions = params.options;
          if (params.optionsBuilder) {
            if (typeof params.optionsBuilder !== 'string') {
              return {
                success: false,
                error: 'Parameter "optionsBuilder" harus berupa string kode JS.'
              };
            }
            resolvedOptions = new Function('graphData', 'rawData', params.optionsBuilder)(
              currentGraphData,
              currentRawData
            );
          }

          if (!resolvedOptions || typeof resolvedOptions !== 'object') {
            return {
              success: false,
              error: 'Konfigurasi Highcharts harus berupa objek yang valid.'
            };
          }

          if (dynamicCharts[containerId]?.instance) {
            try {
              dynamicCharts[containerId].instance.destroy();
            } catch {
              // Ignore Highcharts destroy errors
            }
          }

          const instance = window.Highcharts.chart(containerId, resolvedOptions);
          dynamicCharts[containerId] = {
            target,
            code: lastTransformCode,
            optionsBuilder: params.optionsBuilder || null,
            options: resolvedOptions,
            instance
          };

          updatePresetButtons();
          renderLog();
          setAiStatus(`Grafik "${target}" berhasil dirender oleh AI.`);

          return {
            success: true,
            target,
            containerId,
            autoRefresh: Boolean(params.optionsBuilder && lastTransformCode),
            activeCharts: Object.values(dynamicCharts).map((c) => c.target)
          };
        } catch (err) {
          setAiStatus(`Render grafik gagal: ${err.message || err}`, true);
          return {
            success: false,
            error: err.message || String(err)
          };
        }
      }
    },
    {
      name: 'delete_chart',
      description:
        'Menghapus grafik dinamis dengan "target" tertentu, atau menghapus semua grafik dinamis jika "target" dikosongkan.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Nama target grafik yang dihapus. Kosongkan untuk menghapus semua grafik dinamis.'
          }
        }
      },
      execute: async (params = {}) => {
        const guardError = ensureMounted();
        if (guardError) return guardError;

        const rawTarget = params && params.target !== undefined && params.target !== null
          ? String(params.target).trim()
          : '';

        if (!rawTarget) {
          destroyDynamicCharts({ resetDom: true });
          updatePresetButtons();
          renderLog();
          setAiStatus('Semua grafik dinamis dihapus.');
          return {
            success: true,
            activeCharts: []
          };
        }

        const id = containerIdFor(rawTarget);
        if (!dynamicCharts[id]) {
          return {
            success: false,
            error: `Grafik dengan target "${rawTarget}" tidak ditemukan.`
          };
        }

        try {
          dynamicCharts[id].instance?.destroy();
        } catch {
          // Ignore Highcharts destroy errors
        }
        delete dynamicCharts[id];
        removeChartContainer(id);

        updatePresetButtons();
        renderLog();
        setAiStatus(`Grafik "${rawTarget}" dihapus.`);

        return {
          success: true,
          activeCharts: Object.values(dynamicCharts).map((c) => c.target)
        };
      }
    }
  ];
}

function registerWebMCPAnalytics() {
  const tools = createWebMCPAnalyticsTools();

  const mc =
    (typeof navigator !== 'undefined' && navigator.modelContext) ||
    (typeof document !== 'undefined' && document.modelContext) ||
    null;

  if (mc && typeof mc.registerTool === 'function') {
    for (const tool of tools) {
      try {
        mc.registerTool(tool);
      } catch (err) {
        console.warn('WebMCP analytics tool registration failed:', err);
      }
    }
  }

  if (typeof window !== 'undefined' && window.webmcp && typeof window.webmcp.registerTool === 'function') {
    for (const tool of tools) {
      try {
        window.webmcp.registerTool(tool);
      } catch {
        // Ignore registration errors
      }
    }
  }
}

function unregisterWebMCPAnalytics() {
  const mc =
    (typeof navigator !== 'undefined' && navigator.modelContext) ||
    (typeof document !== 'undefined' && document.modelContext) ||
    null;

  if (mc && typeof mc.unregisterTool === 'function') {
    for (const name of WEBMCP_ANALISIS_TOOL_NAMES) {
      try {
        mc.unregisterTool(name);
      } catch {
        // Ignore unregister errors
      }
    }
  }

  if (typeof window !== 'undefined' && window.webmcp) {
    for (const name of WEBMCP_ANALISIS_TOOL_NAMES) {
      try {
        if (typeof window.webmcp.unregisterTool === 'function') {
          window.webmcp.unregisterTool(name);
        } else if (window.webmcp.tools instanceof Map) {
          window.webmcp.tools.delete(name);
        }
      } catch {
        // Ignore unregister errors
      }
    }
  }
}

function buildSkeletonHtml() {
  return `
    <div class="container py-3">
      <!-- Header & Date Range Selector -->
      <div class="card analisis-card mb-3">
        <div class="card-body d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div>
            <h5 class="fw-bold mb-1 analisis-title"><i class="fas fa-chart-line me-2"></i>Analisis Keuangan</h5>
            <div id="analisis-tx-count" class="small text-muted">Memuat data...</div>
          </div>
          <div class="d-flex align-items-center gap-2">
            <label for="analisis-date-range" class="small text-muted fw-semibold text-nowrap mb-0">Periode:</label>
            <input type="text" id="analisis-date-range" class="form-control form-control-sm" style="min-width: 215px;" placeholder="Pilih rentang tanggal" readonly>
          </div>
        </div>
      </div>

      <!-- KPI Cards -->
      <div class="row g-3 mb-4">
        <div class="col-12 col-md-4">
          <div class="card border-0 border-start border-4 border-success shadow-sm rounded-4 h-100">
            <div class="card-body py-3">
              <div class="small text-muted fw-semibold">Total Pemasukan</div>
              <div id="analisis-total-masuk" class="fs-5 fw-bold text-success">Rp 0</div>
            </div>
          </div>
        </div>
        <div class="col-12 col-md-4">
          <div class="card border-0 border-start border-4 border-danger shadow-sm rounded-4 h-100">
            <div class="card-body py-3">
              <div class="small text-muted fw-semibold">Total Pengeluaran</div>
              <div id="analisis-total-keluar" class="fs-5 fw-bold text-danger">Rp 0</div>
            </div>
          </div>
        </div>
        <div class="col-12 col-md-4">
          <div class="card border-0 border-start border-4 border-primary shadow-sm rounded-4 h-100">
            <div class="card-body py-3">
              <div class="small text-muted fw-semibold">Selisih (Net Cashflow)</div>
              <div id="analisis-net-cashflow" class="fs-5 fw-bold text-primary">Rp 0</div>
            </div>
          </div>
        </div>
      </div>

      <!-- AI / WebMCP Dynamic Charts & Local Presets -->
      <div class="card analisis-card mb-4">
        <div class="card-header bg-transparent border-0 pt-3 px-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
          <h6 class="fw-bold mb-0"><i class="fas fa-robot me-2" style="color: var(--primary-color);"></i>Grafik Dinamis AI (WebMCP) & Preset Lokal</h6>
          <button type="button" class="btn btn-sm btn-link text-decoration-none p-0 fw-semibold" id="btn-toggle-log" style="color: var(--primary-color);">Log Transformasi</button>
        </div>
        <div class="card-body">
          <div class="d-flex align-items-center flex-wrap gap-2 mb-3">
            <select class="form-select form-select-sm flex-grow-1" id="preset-select" style="min-width: 180px; max-width: 280px;">
              <option value="">Preset tersimpan...</option>
            </select>
            <button type="button" class="btn btn-sm analisis-btn-outline" id="preset-load" title="Muat preset" disabled>
              <i class="fas fa-play me-1"></i>Muat
            </button>
            <button type="button" class="btn btn-sm analisis-btn-primary" id="preset-save" title="Simpan grafik saat ini sebagai preset" disabled>
              <i class="fas fa-save me-1"></i>Simpan
            </button>
            <button type="button" class="btn btn-sm analisis-btn-danger" id="preset-delete" title="Hapus preset" disabled>
              <i class="fas fa-trash me-1"></i>Hapus
            </button>
          </div>
          <div id="analisis-ai-status" class="analisis-status-bar small text-muted mb-2">Menunggu data transaksi...</div>
          <pre id="analisis-transform-log" class="small bg-body-tertiary p-2 rounded d-none mb-3" style="white-space: pre-wrap;">Belum ada transformasi yang dijalankan.</pre>
          <div id="charts-container">
            <div id="chart"></div>
          </div>
        </div>
      </div>

      <!-- Breakdown Charts Row -->
      <div class="row g-3 mb-4">
        <div class="col-12 col-lg-6">
          <div class="card border-0 shadow-sm rounded-4 h-100">
            <div class="card-header bg-transparent border-0 pt-3 px-3">
              <h6 class="fw-bold mb-0"><i class="fas fa-chart-pie me-2 text-primary"></i>Pengeluaran per Kelompok</h6>
            </div>
            <div class="card-body">
              <div id="analisis-kelompok-chart" style="min-height: 320px;"></div>
            </div>
          </div>
        </div>
        <div class="col-12 col-lg-6">
          <div class="card border-0 shadow-sm rounded-4 h-100">
            <div class="card-header bg-transparent border-0 pt-3 px-3">
              <h6 class="fw-bold mb-0"><i class="fas fa-balance-scale me-2 text-warning"></i>Rutin vs Non-Rutin</h6>
            </div>
            <div class="card-body">
              <div id="analisis-rutin-chart" style="min-height: 320px;"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Daily Trend Chart -->
      <div class="card border-0 shadow-sm rounded-4 mb-4">
        <div class="card-header bg-transparent border-0 pt-3 px-3">
          <h6 class="fw-bold mb-0"><i class="fas fa-wave-square me-2 text-info"></i>Tren Harian Pemasukan & Pengeluaran</h6>
        </div>
        <div class="card-body">
          <div id="analisis-trend-chart" style="min-height: 300px;"></div>
        </div>
      </div>

      <!-- Top Spending Items -->
      <div class="card border-0 shadow-sm rounded-4 mb-4">
        <div class="card-header bg-transparent border-0 pt-3 px-3">
          <h6 class="fw-bold mb-0"><i class="fas fa-fire me-2 text-danger"></i>10 Pengeluaran Terbesar</h6>
        </div>
        <div class="card-body p-0">
          <div class="table-responsive">
            <table class="table table-hover align-middle mb-0">
              <thead class="table-light">
                <tr>
                  <th style="width: 48px;">#</th>
                  <th>Item / Barang</th>
                  <th>Kelompok</th>
                  <th class="text-end">Total</th>
                </tr>
              </thead>
              <tbody id="analisis-top-items-body">
                <tr>
                  <td colspan="4" class="text-center text-muted py-4">Memuat data...</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

export async function mount(container, _params) {
  isMounted = true;
  rootContainer = container;
  if (!document.getElementById(STYLE_ID)) {
    const styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = ANALISIS_CSS;
    document.head.appendChild(styleEl);
  }
  currentRawData = [];
  currentGraphData = null;
  lastTransformCode = null;
  dynamicCharts = {};

  if (viewAbortController) {
    viewAbortController.abort();
  }
  viewAbortController = new AbortController();
  const { signal } = viewAbortController;

  const range = getDefaultMonthRange();
  currentStartDate = range.start;
  currentEndDate = range.end;

  container.innerHTML = buildSkeletonHtml();
  initDatePicker();
  bindDynamicChartEvents(signal);
  refreshPresetSelect();
  renderLog();
  registerWebMCPAnalytics();

  window.addEventListener(
    'kasin:db-updated',
    () => {
      refreshData();
    },
    { signal }
  );

  await refreshData();
}

export function unmount() {
  isMounted = false;
  if (viewAbortController) {
    viewAbortController.abort();
    viewAbortController = null;
  }
  unregisterWebMCPAnalytics();
  destroyCharts();
  destroyDynamicCharts();
  destroyDatePicker();
  currentRawData = [];
  currentGraphData = null;
  lastTransformCode = null;
  rootContainer = null;
}
