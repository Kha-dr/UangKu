<div class="container">
  <div class="container-fluid" style="max-width:32rem">
    <form id="form" method="post" action="/Databases" enctype="multipart/form-data">
      <input type="hidden" name="csrf_token" value="<?= htmlspecialchars($data['csrf_token'], ENT_QUOTES) ?>">
      <div class="form-group">
        <div class="date-range input-group mb-3 w-100">
          <input class="form-control" id="startDate" type="text" placeholder="Mulai">
          <span class="input-group-text">s/d</span>
          <input class="form-control" id="endDate" type="text" placeholder="Akhir">
        </div>
        <button type="button" class="btn bg-success font-weight-bold w-100" id="btn-export-csv">Download CSV</button>
        <input type="file" placeholder="Upload CSV File" class="form-control" accept=".csv,text/csv,text/comma-separated-values,application/csv,application/vnd.ms-excel,text/plain" name="attachment" />
        <?php InputValidator('attachment') ?>
        <small style="font-size: .5em;">Ini hanya akan mengupdate data yang ada di CSV sesuai id saja, silahkan hapus yang tidak perlu diupdate</small>
      </div>
      <div class="form-group center-input">
        <label>DB Version</label>
        <select class="form-control" id="dbVersion" placeholder="DB Version" name="dbVersion">
          <option value="" data-placeholder="true" readonly="true">DB Version</option>
          <?php foreach ($data['dbVersions'] as $version) : ?>
            <option value="<?= $version ?>"><?= $version ?></option>
          <?php endforeach; ?>
        </select>
        <?php InputValidator('dbVersion') ?>
        <hr>
        <button type="button" class="btn font-weight-bold w-100" id="btn-download-sqlite">Download SQLite</button>
        <hr>
        <button type="button" class="btn btn-outline-danger font-weight-bold w-100" id="btn-reinitialize-sqlite">Reinitialize SQL</button>
        <small style="font-size: .5em;">This will reset the SQL database to its initial state with current saldo as saldo awal</small>
      </div>
    </form>
  </div>
</div>
<script src="https://unpkg.com/slim-select@3/dist/slimselect.js" crossorigin="anonymous"></script>
<link href="https://unpkg.com/slim-select@3/dist/slimselect.css" rel="stylesheet" crossorigin="anonymous">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css" crossorigin="anonymous">
<script src="https://cdn.jsdelivr.net/npm/flatpickr" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/flatpickr/dist/plugins/rangePlugin.js" crossorigin="anonymous"></script>
</link>
<script>
  const d = new Date();
  var dateRange = dateRange || [
    new Date(d.getFullYear(), d.getMonth(), 1),
    d
  ];
  delete d;
  const startInput = document.querySelector('#startDate');
  const endInput = document.querySelector('#endDate');
  flatpickr(startInput, {
    disableMobile: "true",
    plugins: [new rangePlugin({
      input: endInput
    })],
    maxDate: "today",
    dateFormat: "Y-m-d", // internal format
    onChange([start, end]) {
      startInput.value = toDateShortMonth(start);
      endInput.value = toDateShortMonth(end || start); // use start date if end is not selected
      dateRange = [start, end || start]
    }
  });
  startInput.value = toDateShortMonth(dateRange[0]);
  endInput.value = toDateShortMonth(dateRange[1]); // use start date if end is not selected
  const FORM = document.querySelector('form#form');
  function submitPostAction(fields) {
    const tempForm = document.createElement('form');
    tempForm.method = 'post';
    tempForm.action = '/Databases';
    const csrfInput = document.createElement('input');
    csrfInput.type = 'hidden';
    csrfInput.name = 'csrf_token';
    csrfInput.value = FORM.querySelector('input[name="csrf_token"]').value;
    tempForm.appendChild(csrfInput);
    Object.entries(fields).forEach(([name, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      tempForm.appendChild(input);
    });
    document.body.appendChild(tempForm);
    tempForm.submit();
    tempForm.remove();
  }
  FORM.querySelector("#btn-export-csv").addEventListener('click', (e) => {
    e.preventDefault();
    Swal.fire({
      title: `Ekspor Database`,
      text: `Proses ini akan mengekspor data transaksi ${startInput.value} s.d ${endInput.value} ke dalam file CSV`,
      icon: "warning",
      target: "dialog",
      showCancelButton: true,
    }).then(async (result) => {
      if (!result.isConfirmed) return;
      await showAlert('Memproses....', 'warning')
      submitPostAction({
        export: 'true',
        startDate: formatDBDate(dateRange[0]),
        endDate: formatDBDate(dateRange[1]),
      });
    });
  })
  FORM.querySelector("#btn-download-sqlite").addEventListener('click', (e) => {
    e.preventDefault();
    Swal.fire({
      title: `Unduh SQLite`,
      text: "Proses ini akan mengunduh file database SQLite aktif.",
      icon: "info",
      target: "dialog",
      showCancelButton: true,
    }).then(async (result) => {
      if (!result.isConfirmed) return;
      await showAlert('Memproses....', 'warning')
      submitPostAction({ sqllite: 'download' });
    });
  })
  FORM.querySelector("#btn-reinitialize-sqlite").addEventListener('click', (e) => {
    e.preventDefault();
    Swal.fire({
      title: `Reinitialize SQL`,
      text: "PERINGATAN: Proses ini akan membuat backup lalu mereset seluruh riwayat transaksi menjadi saldo awal saat ini!",
      icon: "warning",
      target: "dialog",
      showCancelButton: true,
    }).then(async (result) => {
      if (!result.isConfirmed) return;
      await showAlert('Memproses....', 'warning')
      submitPostAction({ sqllite: 'reinitialize' });
    });
  })
  FORM.attachment.addEventListener('change', () => {
    if (!FORM.attachment.value) return;
    Swal.fire({
      title: `Update Database`,
      text: "Proses ini akan mengupdate data berdasarkan file CSV yang diunggah, pastikan format file benar dan sudah dibackup sebelumnya",
      icon: "warning",
      target: "dialog",
      showCancelButton: true,
    }).then(async (result) => {
      if (!result.isConfirmed) return;
      await showAlert('Memproses....', 'warning')
      FORM.submit()
    });
  })
  FORM.dbVersion.addEventListener('change', () => {
    if (!FORM.dbVersion.value) return;
    Swal.fire({
      title: `Change Database`,
      text: "Proses ini akan mengganti database yang digunakan ke versi yang dipilih, pastikan sudah dibackup sebelumnya",
      icon: "warning",
      target: "dialog",
      showCancelButton: true,
    }).then(async (result) => {
      if (!result.isConfirmed) return;
      await showAlert('Memproses....', 'warning')
      FORM.submit()
    });
  })
</script>
