(function(){
  "use strict";

  const DEFAULT_FILENAME = "DLHGDCV93.db";
  const PAGE_SIZE = 50;
  const LARGE_EXPORT_WARN = 200000;
  const SCAN_CHUNK = 20000;
  const FETCH_BATCH = 500;

  const COLUMN_LABELS = {
    STT:"STT", MaSoBHXH:"Mã hộ (Mã số BHXH hộ)", TenChuHo:"Thông tin chủ hộ",
    Col5:"STT trong hộ", Col6:"Họ và tên", Col7:"Mã số BHXH", Col8:"Ngày sinh",
    Col9:"Giới tính", Col10:"Địa chỉ (dữ liệu gốc)", Col11:"Quan hệ với chủ hộ",
    Col12:"Số CCCD/CMND", Col13:"Mã đối tượng (ĐT)", Col14:"Giá trị thẻ (thời hạn BHYT)",
    Col16:"Col16", Col17:"Mã cơ quan quản lý", Col18:"Ghi chú 1", Col19:"Ghi chú 2",
    Thon:"Thôn/Bản/Tổ dân phố", XaPhuong:"Xã/Phường/Thị trấn", Huyen:"Huyện/Thị xã", TenFile:"File nguồn"
  };
  const el = (id) => document.getElementById(id);
  const loadingScreen = el("loadingScreen");
  const loadingText = el("loadingText");
  const toastEl = el("toast");

  function isMonoCol(col){ return /(stt|ma|bhxh|cccd|code|^id$|_id$)/i.test(col || ""); }

  function showToast(msg, isErr){
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>{ toastEl.classList.remove("show"); }, 4200);
  }
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  function escHtml(s){ return (s===undefined||s===null?"":s.toString()).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function escAttr(s){ return escHtml(s).replace(/"/g,"&quot;"); }
  function norm(s){ return (s||"").toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/đ/g,"d"); }

  // ---------------- Trạng thái toàn cục ----------------
  let SQLModule = null;
  let db = null;
  let tableName = "";
  let dbColumns = [];      // toàn bộ cột có trong bảng đang chọn
  let displayCols = [];    // các cột người dùng chọn để hiển thị/tìm kiếm
  let statColumn1 = "";    // cột dùng cho ô thống kê tuỳ chọn 1 (đếm giá trị khác nhau)
  let statColumn2 = "";    // cột dùng cho ô thống kê tuỳ chọn 2 (đếm giá trị khác nhau)
  let currentSort = { col: "", dir: 1 };
  let currentPage = 1;
  let currentTotal = 0;
  let currentWhere = { clause: "", params: [] };
  let colFilterInputs = [];  // các ô lọc theo từng cột (được tạo lại mỗi khi đổi cột hiển thị)

  // Trạng thái tạm trong lúc "chọn bảng → chọn cột" khi nạp 1 file .db mới
  let stagingDb = null;
  let stagingTables = [];
  let stagingTableName = "";
  let stagingDbColumns = [];
  let stagingLabel = "";

  function setSource(name, ok){
    const chip = el("sourceChip");
    chip.className = "source-chip " + (ok ? "ok" : "err");
    el("sourceFname").textContent = name;
  }

  function runSQLOn(dbInst, sql, params){
    const stmt = dbInst.prepare(sql);
    if(params && params.length) stmt.bind(params);
    const cols = stmt.getColumnNames();
    const rows = [];
    while(stmt.step()){ rows.push(stmt.get()); }
    stmt.free();
    return { columns: cols, values: rows };
  }
  function runSQL(sql, params){ return runSQLOn(db, sql, params); }
  function runExec(sql, params){
    if(params && params.length){ runSQL(sql, params); return; }
    db.run(sql);
  }

  async function initSql(){
    return await initSqlJs({ locateFile: f => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${f}` });
  }

  // ---------------- Helper dùng chung: danh sách checkbox chọn cột ----------------
  function buildColumnChecklist(container, columns, checkedCols){
    const checkedSet = new Set(checkedCols || []);
    container.innerHTML = columns.map(c=>{
      const label = COLUMN_LABELS[c] || c;
      const checked = checkedSet.has(c) ? "checked" : "";
      return `<label class="col-check">
        <input type="checkbox" value="${escAttr(c)}" ${checked}>
        <span>${escHtml(label)}</span>
        <span class="col-check-key">${escHtml(c)}</span>
      </label>`;
    }).join("");
  }
  function getCheckedColumns(container){
    return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb=>cb.value);
  }
  function setAllChecked(container, checked){
    container.querySelectorAll('input[type="checkbox"]').forEach(cb=> cb.checked = checked);
  }

  // ---------------- Nạp CSDL: Bước 1 — mở file & liệt kê các bảng ----------------
  let pendingPickMode = "db"; // "db" | "excel" — quyết định hành vi của modal chọn bảng/sheet
  let pendingExcelWorkbook = null;

  async function openDatabaseBytesAndPickTable(bytes, label){
    if(!SQLModule){ loadingText.textContent = "Đang khởi tạo công cụ đọc SQLite…"; SQLModule = await initSql(); }
    loadingText.textContent = "Đang mở tệp dữ liệu…";
    await sleep(10);

    if(stagingDb){ try{ stagingDb.close(); }catch(e){} stagingDb = null; }
    stagingDb = new SQLModule.Database(new Uint8Array(bytes));
    stagingLabel = label;

    const tblRes = runSQLOn(stagingDb, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    if(!tblRes.values.length){
      try{ stagingDb.close(); }catch(e){}
      stagingDb = null;
      throw new Error("Không tìm thấy bảng dữ liệu nào trong file.");
    }
    stagingTables = tblRes.values.map(v=>v[0]);

    loadingScreen.style.display = "none";

    if(stagingTables.length === 1){
      chooseStagingTable(stagingTables[0]);
    }else{
      openTableSelectModal(stagingTables, "db");
    }
  }

  // ---------------- Nạp CSDL từ file Excel: chuyển 1 sheet thành 1 bảng SQLite tạm ----------------
  async function openExcelAsDataSource(bytes, label){
    loadingText.textContent = "Đang đọc file Excel…";
    await sleep(10);
    let wb;
    try{ wb = XLSX.read(new Uint8Array(bytes), {type:"array"}); }
    catch(err){ throw new Error("Không đọc được file Excel: " + err.message); }
    const sheetNames = (wb.SheetNames||[]).filter(n=>wb.Sheets[n]);
    if(!sheetNames.length) throw new Error("File Excel không có sheet dữ liệu nào.");

    pendingExcelWorkbook = wb;
    stagingLabel = label;
    loadingScreen.style.display = "none";

    if(sheetNames.length === 1){
      await buildStagingDbFromExcelSheet(wb, sheetNames[0], label);
    }else{
      openTableSelectModal(sheetNames, "excel");
    }
  }

  function sanitizeColumnNames(rawHeaders){
    const used = new Set();
    return rawHeaders.map((h,i)=>{
      let name = (h===undefined||h===null?"":String(h)).trim().replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g,"");
      if(!name) name = "Cot" + (i+1);
      let finalName = name, n=2;
      while(used.has(finalName)){ finalName = name + "_" + n; n++; }
      used.add(finalName);
      return finalName;
    });
  }

  async function buildStagingDbFromExcelSheet(wb, sheetName, label){
    loadingScreen.style.display = "flex";
    loadingText.textContent = `Đang chuyển sheet "${sheetName}" sang cơ sở dữ liệu…`;
    await sleep(10);
    try{
      if(!SQLModule){ SQLModule = await initSql(); }
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:false, defval:""});
      if(!rows.length) throw new Error(`Sheet "${sheetName}" không có dữ liệu.`);
      const headers = sanitizeColumnNames(rows[0]);
      const dataRows = rows.slice(1).filter(r=> r.some(v=> v!==undefined && v!==null && String(v).trim()!==""));

      if(stagingDb){ try{ stagingDb.close(); }catch(e){} }
      stagingDb = new SQLModule.Database();
      const tblName = "data";
      stagingDb.run(`CREATE TABLE "${tblName}" (${headers.map(h=>`"${h}" TEXT`).join(",")})`);

      const insertSql = `INSERT INTO "${tblName}" (${headers.map(h=>`"${h}"`).join(",")}) VALUES (${headers.map(()=>"?").join(",")})`;
      stagingDb.run("BEGIN TRANSACTION");
      const stmt = stagingDb.prepare(insertSql);
      for(let i=0;i<dataRows.length;i++){
        const r = dataRows[i];
        stmt.run(headers.map((h,ci)=> r[ci]===undefined || r[ci]===null ? "" : String(r[ci])));
        if(i % 3000 === 0){
          loadingText.textContent = `Đang chuyển dữ liệu Excel… ${i.toLocaleString('vi-VN')}/${dataRows.length.toLocaleString('vi-VN')}`;
          await sleep(0);
        }
      }
      stmt.free();
      stagingDb.run("COMMIT");

      stagingTableName = tblName;
      stagingDbColumns = headers;
      stagingLabel = `${label} — sheet "${sheetName}"`;

      loadingScreen.style.display = "none";
      openColumnSelectModal();
    }catch(err){
      loadingScreen.style.display = "none";
      showToast("Lỗi khi chuyển đổi Excel: " + err.message, true);
      if(stagingDb){ try{ stagingDb.close(); }catch(e){} }
      cancelStagingLoad();
    }
  }

  function openTableSelectModal(names, mode){
    pendingPickMode = mode;
    el("tableSelectModalTitle").textContent = mode==="excel" ? "Chọn sheet dữ liệu" : "Chọn bảng dữ liệu";
    el("tableSelectModalDesc").textContent = mode==="excel"
      ? "File Excel này có nhiều sheet — hãy chọn sheet bạn muốn dùng làm dữ liệu."
      : "File .db này có nhiều bảng — hãy chọn bảng bạn muốn làm việc.";

    const list = el("tablePickList");
    list.innerHTML = names.map(t=>{
      let count = "—";
      try{
        if(mode==="excel"){
          const ws = pendingExcelWorkbook.Sheets[t];
          const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
          count = range ? Math.max(0, range.e.r - range.s.r).toLocaleString('vi-VN') : "—";
        }else{
          count = runSQLOn(stagingDb, `SELECT COUNT(*) FROM "${t}"`).values[0][0].toLocaleString('vi-VN');
        }
      }catch(e){}
      return `<label class="table-pick-item">
        <input type="radio" name="tablePick" value="${escAttr(t)}">
        <span class="tbl-name">${escHtml(t)}</span>
        <span class="tbl-count">${count} dòng</span>
      </label>`;
    }).join("");
    list.querySelectorAll('input[name="tablePick"]').forEach(r=>{
      r.addEventListener("change", ()=>{ el("btnConfirmTable").disabled = false; });
    });
    el("btnConfirmTable").disabled = true;
    el("tableSelectModal").classList.add("show");
  }
  function closeTableSelectModal(){ el("tableSelectModal").classList.remove("show"); }

  el("btnConfirmTable").addEventListener("click", async ()=>{
    const picked = el("tablePickList").querySelector('input[name="tablePick"]:checked');
    if(!picked) return;
    closeTableSelectModal();
    if(pendingPickMode === "excel"){
      await buildStagingDbFromExcelSheet(pendingExcelWorkbook, picked.value, stagingLabel);
    }else{
      chooseStagingTable(picked.value);
    }
  });
  el("btnCancelTablePick").addEventListener("click", ()=>{
    closeTableSelectModal();
    cancelStagingLoad();
  });

  // ---------------- Nạp CSDL: Bước 2 — chọn cột muốn hiển thị + cột thống kê ----------------
  function chooseStagingTable(tblName){
    stagingTableName = tblName;
    const pragma = runSQLOn(stagingDb, `PRAGMA table_info("${tblName}")`);
    stagingDbColumns = pragma.values.map(r => r[1]);
    if(!stagingDbColumns.length){
      showToast("Bảng \"" + tblName + "\" không có cột dữ liệu nào.", true);
      cancelStagingLoad();
      return;
    }
    openColumnSelectModal();
  }

  function fillStatColSelect(selectEl, preferredList){
    selectEl.innerHTML = '<option value="">— Không dùng —</option>' +
      stagingDbColumns.map(c=>`<option value="${escAttr(c)}">${escHtml(COLUMN_LABELS[c]||c)}</option>`).join("");
    const preferred = preferredList.find(c=>stagingDbColumns.includes(c));
    selectEl.value = preferred || "";
  }

  function openColumnSelectModal(){
    el("colSelectSubtitle").textContent = `Bảng "${stagingTableName}" — ${stagingDbColumns.length} cột.`;
    buildColumnChecklist(el("colSelectList"), stagingDbColumns, stagingDbColumns); // mặc định chọn tất cả
    fillStatColSelect(el("statCol1Select"), ["MaSoBHXH"]);
    fillStatColSelect(el("statCol2Select"), ["Huyen"]);
    updateColSelectConfirmState();
    el("columnSelectModal").classList.add("show");
  }
  function closeColumnSelectModal(){ el("columnSelectModal").classList.remove("show"); }
  function updateColSelectConfirmState(){
    el("btnConfirmColumns").disabled = getCheckedColumns(el("colSelectList")).length === 0;
  }
  el("colSelectList").addEventListener("change", updateColSelectConfirmState);
  el("btnColSelectAll").addEventListener("click", ()=>{ setAllChecked(el("colSelectList"), true); updateColSelectConfirmState(); });
  el("btnColSelectNone").addEventListener("click", ()=>{ setAllChecked(el("colSelectList"), false); updateColSelectConfirmState(); });
  el("btnCancelColSelect").addEventListener("click", ()=>{
    closeColumnSelectModal();
    cancelStagingLoad();
  });
  el("btnConfirmColumns").addEventListener("click", async ()=>{
    const chosen = getCheckedColumns(el("colSelectList"));
    if(!chosen.length) return;
    const statCol1 = el("statCol1Select").value;
    const statCol2 = el("statCol2Select").value;
    closeColumnSelectModal();
    await finishLoadingWithColumns(chosen, statCol1, statCol2);
  });

  function cancelStagingLoad(){
    if(stagingDb){ try{ stagingDb.close(); }catch(e){} }
    stagingDb = null;
    stagingTables = [];
    stagingTableName = "";
    stagingDbColumns = [];
    stagingLabel = "";
    pendingExcelWorkbook = null;
    loadingScreen.style.display = "none";
    if(!db) setSource("Chưa có dữ liệu — hãy chọn file .db", false);
  }

  // ---------------- Nạp CSDL: Bước 3 — hoàn tất (đánh chỉ mục, thống kê, hiển thị) ----------------
  async function finishLoadingWithColumns(chosenCols, statCol1, statCol2){
    loadingScreen.style.display = "flex";
    loadingText.textContent = "Đang hoàn tất nạp dữ liệu…";
    await sleep(10);

    if(db){ try{ db.close(); }catch(e){} }
    db = stagingDb;
    tableName = stagingTableName;
    dbColumns = stagingDbColumns;
    displayCols = chosenCols;
    statColumn1 = statCol1 || "";
    statColumn2 = statCol2 || "";
    stagingDb = null;
    pendingExcelWorkbook = null;

    loadingText.textContent = "Đang tạo chỉ mục tăng tốc tìm kiếm…";
    await sleep(10);
    const idxCols = Array.from(new Set([...displayCols, statColumn1, statColumn2])).filter(c=>c && dbColumns.includes(c));
    for(const c of idxCols){
      try{ runExec(`CREATE INDEX IF NOT EXISTS "idx_${c}" ON "${tableName}"("${c}")`); }catch(e){ /* bỏ qua nếu lỗi */ }
      await sleep(0);
    }

    const cnt = runSQL(`SELECT COUNT(*) FROM "${tableName}"`);
    currentTotal = cnt.values[0][0];
    el("statTotal").textContent = currentTotal.toLocaleString('vi-VN');

    updateCustomStats();

    currentSort = { col: displayCols.includes("STT") ? "STT" : displayCols[0], dir: 1 };
    buildDisplayTableHeader();
    buildDbColSelect();

    _allCountCache = null;
    setSource(stagingLabel, true);

    currentWhere = { clause:"", params:[] };
    currentPage = 1;
    await executeSearch(true);

    loadingScreen.style.display = "none";
    showToast(`Đã tải "${stagingLabel}" — bảng "${tableName}" — ${currentTotal.toLocaleString('vi-VN')} bản ghi, ${displayCols.length} cột hiển thị.`, false);
  }

  // Tính lại 2 ô thống kê tuỳ chọn (đếm số giá trị khác nhau) theo cột người dùng đã chọn
  function updateCustomStats(){
    const cfg = [
      { col: statColumn1, numEl: el("statCustom1"), lblEl: el("statCustom1Lbl") },
      { col: statColumn2, numEl: el("statCustom2"), lblEl: el("statCustom2Lbl") },
    ];
    cfg.forEach(({col, numEl, lblEl})=>{
      if(!col || !dbColumns.includes(col)){
        numEl.textContent = "—";
        lblEl.textContent = "Chưa chọn cột thống kê";
        return;
      }
      const label = COLUMN_LABELS[col] || col;
      lblEl.textContent = `Số "${label}" khác nhau`;
      try{
        const r = runSQL(`SELECT COUNT(DISTINCT "${col}") FROM "${tableName}" WHERE "${col}" IS NOT NULL AND "${col}" != ''`);
        numEl.textContent = r.values[0][0].toLocaleString('vi-VN');
      }catch(e){
        numEl.textContent = "—";
      }
    });
  }

  // ---------------- Dựng lại tiêu đề bảng + ô lọc theo cột (mỗi khi đổi cột hiển thị) ----------------
  function buildDisplayTableHeader(){
    const thead = el("tableHead");
    const filterRowHtml = displayCols.map(c=>{
      const label = COLUMN_LABELS[c] || c;
      return `<th><input type="text" class="col-filter" data-col="${escAttr(c)}" placeholder="Lọc ${escAttr(label)}…"></th>`;
    }).join("");
    const titleRowHtml = displayCols.map(c=>{
      const label = COLUMN_LABELS[c] || c;
      return `<th data-col="${escAttr(c)}">${escHtml(label)}</th>`;
    }).join("");
    thead.innerHTML = `<tr class="col-filter-row">${filterRowHtml}</tr><tr>${titleRowHtml}</tr>`;

    colFilterInputs = Array.from(thead.querySelectorAll(".col-filter"));
    colFilterInputs.forEach(inp=>{
      inp.addEventListener("keydown", (e)=>{ if(e.key==="Enter") executeSearch(false); });
      inp.addEventListener("click", (e)=> e.stopPropagation());
    });

    thead.querySelectorAll("tr:not(.col-filter-row) th").forEach(th=>{
      th.addEventListener("click", ()=>{
        const col = th.dataset.col;
        if(!displayCols.includes(col)) return;
        if(currentSort.col === col){ currentSort.dir *= -1; } else { currentSort = { col, dir: 1 }; }
        thead.querySelectorAll("th .arrow").forEach(a=>a.remove());
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.textContent = currentSort.dir===1 ? "▲" : "▼";
        th.appendChild(arrow);
        currentPage = 1;
        renderPage();
      });
    });
  }

  async function tryLoadDefaultFile(){
    loadingText.textContent = "Đang tải dữ liệu mặc định…";
    try{
      const resp = await fetch("./" + DEFAULT_FILENAME, {cache:"no-store"});
      if(!resp.ok) throw new Error("HTTP " + resp.status);
      const buf = await resp.arrayBuffer();
      await openDatabaseBytesAndPickTable(buf, DEFAULT_FILENAME);
    }catch(err){
      setSource("Chưa có dữ liệu — hãy chọn file .db", false);
      showToast("Không tự tải được \"" + DEFAULT_FILENAME + "\" (thường do mở trực tiếp bằng file://). Hãy dùng nút “Chọn file dữ liệu” hoặc chạy trang qua một máy chủ cục bộ.", true);
    }finally{
      loadingScreen.style.display = "none";
    }
  }

  el("filePicker").addEventListener("change", async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    loadingScreen.style.display = "flex";
    loadingText.textContent = "Đang đọc " + file.name + "…";
    try{
      const buf = await file.arrayBuffer();
      const ext = (file.name.split(".").pop()||"").toLowerCase();
      if(ext === "xlsx" || ext === "xls"){
        await openExcelAsDataSource(buf, file.name);
      }else{
        await openDatabaseBytesAndPickTable(buf, file.name);
      }
    }catch(err){
      showToast("Lỗi khi đọc file: " + err.message, true);
      if(!db) setSource("Lỗi đọc file", false);
      loadingScreen.style.display = "none";
    }finally{
      e.target.value = "";
    }
  });
  el("btnPickFile").addEventListener("click", ()=> el("filePicker").click());

  // ---------------- Import thêm dữ liệu từ file .db khác ----------------
  let importFileBytes = null;
  let importFileName = "";

  function openImportModal(){
    if(!db){ showToast("Vui lòng chọn file dữ liệu (.db) chính trước khi import thêm.", true); return; }
    el("importModal").classList.add("show");
  }
  function closeImportModal(){ el("importModal").classList.remove("show"); }
  el("btnImportData").addEventListener("click", openImportModal);
  el("importModalClose").addEventListener("click", closeImportModal);
  el("importModalBackdrop").addEventListener("click", closeImportModal);

  el("importDrop").addEventListener("click", ()=> el("importFileInput").click());
  el("importFileInput").addEventListener("change", async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    try{
      importFileBytes = await file.arrayBuffer();
      importFileName = file.name;
      el("importFileName").textContent = file.name;
      el("btnRunImport").disabled = false;
      el("importResultSummary").classList.remove("show");
      el("importProgressWrap").classList.remove("show");
    }catch(err){
      showToast("Lỗi khi đọc file: " + err.message, true);
    }
  });

  function setImportProgress(pct, text){
    el("importProgressWrap").classList.add("show");
    el("importProgressFill").style.width = Math.max(0,Math.min(100,pct)) + "%";
    el("importProgressText").textContent = text;
  }

  el("btnRunImport").addEventListener("click", async ()=>{
    if(!importFileBytes || !db) return;
    const dedupe = el("importDedupe").checked;
    el("btnRunImport").disabled = true;
    el("importResultSummary").classList.remove("show");

    let importDb = null;
    try{
      setImportProgress(2, "Đang mở file import…");
      await sleep(0);
      if(!SQLModule){ SQLModule = await initSql(); }
      importDb = new SQLModule.Database(new Uint8Array(importFileBytes));

      const tblRes = runSQLOn(importDb, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      if(!tblRes.values.length) throw new Error("File import không có bảng dữ liệu nào.");
      const candidateTables = tblRes.values.map(v=>v[0]);

      // File import có thể có nhiều bảng — tự động dùng bảng đầu tiên có đầy đủ cột khớp với dữ liệu hiện tại
      let importTableName = null;
      for(const t of candidateTables){
        const cols = runSQLOn(importDb, `PRAGMA table_info("${t}")`).values.map(r=>r[1]);
        if(dbColumns.every(c=>cols.includes(c))){ importTableName = t; break; }
      }
      if(!importTableName){
        const detail = candidateTables.length>1 ? ` (đã kiểm tra ${candidateTables.length} bảng: ${candidateTables.join(", ")})` : "";
        throw new Error("Không tìm thấy bảng nào trong file import có cấu trúc cột khớp với dữ liệu hiện tại" + detail + ".");
      }

      setImportProgress(12, "Đang đọc dữ liệu từ file import…");
      await sleep(0);
      const colsList = dbColumns.slice();
      const selectSql = `SELECT ${colsList.map(c=>`"${c}"`).join(",")} FROM "${importTableName}"`;
      const importRows = runSQLOn(importDb, selectSql).values;
      importDb.close();
      importDb = null;

      if(!importRows.length) throw new Error("File import không có dữ liệu nào.");

      const totalBefore = runSQL(`SELECT COUNT(*) FROM "${tableName}"`).values[0][0];
      let deletedCount = 0;

      if(dedupe && dbColumns.includes("MaSoBHXH")){
        const idx = colsList.indexOf("MaSoBHXH");
        const uniqueMaHo = Array.from(new Set(importRows.map(r=>r[idx]).filter(v=>v!==null && v!==undefined && v!=="")));
        setImportProgress(25, `Đang xóa dữ liệu cũ trùng Mã số BHXH (${uniqueMaHo.length.toLocaleString('vi-VN')} mã)…`);
        await sleep(0);
        for(let i=0;i<uniqueMaHo.length;i+=500){
          const batch = uniqueMaHo.slice(i, i+500);
          const placeholders = batch.map(()=>"?").join(",");
          runExec(`DELETE FROM "${tableName}" WHERE "MaSoBHXH" IN (${placeholders})`, batch);
          await sleep(0);
        }
        const totalAfterDelete = runSQL(`SELECT COUNT(*) FROM "${tableName}"`).values[0][0];
        deletedCount = totalBefore - totalAfterDelete;
      }

      setImportProgress(45, `Đang chèn ${importRows.length.toLocaleString('vi-VN')} dòng dữ liệu mới…`);
      await sleep(0);

      const placeholders = colsList.map(()=>"?").join(",");
      const insertSql = `INSERT INTO "${tableName}" (${colsList.map(c=>`"${c}"`).join(",")}) VALUES (${placeholders})`;
      db.run("BEGIN TRANSACTION");
      try{
        const stmt = db.prepare(insertSql);
        for(let i=0;i<importRows.length;i++){
          stmt.run(importRows[i]);
          if(i % 3000 === 0){
            setImportProgress(45 + (i/importRows.length)*40, `Đang chèn dữ liệu… ${i.toLocaleString('vi-VN')}/${importRows.length.toLocaleString('vi-VN')}`);
            await sleep(0);
          }
        }
        stmt.free();
        db.run("COMMIT");
      }catch(insertErr){
        try{ db.run("ROLLBACK"); }catch(e){}
        throw insertErr;
      }

      setImportProgress(92, "Đang cập nhật thống kê…");
      await sleep(0);

      _allCountCache = null;
      const cnt = runSQL(`SELECT COUNT(*) FROM "${tableName}"`);
      currentTotal = cnt.values[0][0];
      el("statTotal").textContent = currentTotal.toLocaleString('vi-VN');
      updateCustomStats();

      currentPage = 1;
      await executeSearch(true);

      setImportProgress(100, "Hoàn tất.");
      const summary = el("importResultSummary");
      summary.classList.add("show");
      summary.innerHTML = `Đã import <b>${importRows.length.toLocaleString('vi-VN')}</b> dòng từ "${escHtml(importFileName)}".` +
        (dedupe
          ? `<br>Chế độ: <b>Xóa dữ liệu cũ trùng Mã số BHXH</b> — đã xóa <b>${deletedCount.toLocaleString('vi-VN')}</b> bản ghi cũ trước khi thêm mới.`
          : `<br>Chế độ: <b>Thêm dữ liệu mới</b> — giữ nguyên toàn bộ dữ liệu cũ dù trùng mã.`) +
        `<br>Tổng số bản ghi hiện tại: <b>${currentTotal.toLocaleString('vi-VN')}</b>.`;
      showToast("Import dữ liệu thành công.", false);

      importFileBytes = null;
      importFileName = "";
      el("importFileInput").value = "";
      el("importFileName").textContent = "";
    }catch(err){
      if(importDb){ try{ importDb.close(); }catch(e){} }
      showToast("Lỗi khi import: " + err.message, true);
      el("importProgressWrap").classList.remove("show");
    }finally{
      el("btnRunImport").disabled = !importFileBytes;
    }
  });

  // ---------------- Xây WHERE từ điều kiện hiện tại ----------------
  function buildWhere(){
    const parts = [];
    const params = [];
    const exact = el("exactMatch").checked;

    // Ô tìm kiếm chung — áp dụng trên các cột đang hiển thị (OR giữa các cột)
    const q = el("searchInput").value.trim();
    if(q){
      const searchCols = displayCols.filter(c=>dbColumns.includes(c));
      if(searchCols.length){
        if(exact){
          parts.push("(" + searchCols.map(c=>`"${c}" = ?`).join(" OR ") + ")");
          searchCols.forEach(()=>params.push(q));
        }else{
          const like = "%" + q + "%";
          parts.push("(" + searchCols.map(c=>`"${c}" LIKE ?`).join(" OR ") + ")");
          searchCols.forEach(()=>params.push(like));
        }
      }
    }

    // Các ô tìm kiếm theo từng cột (phía trên tiêu đề) — kết hợp AND với nhau và với ô tìm kiếm chung
    colFilterInputs.forEach(inp=>{
      const col = inp.dataset.col;
      const val = inp.value.trim();
      if(!val || !dbColumns.includes(col)) return;
      if(exact){
        parts.push(`"${col}" = ?`);
        params.push(val);
      }else{
        parts.push(`"${col}" LIKE ?`);
        params.push("%" + val + "%");
      }
    });

    return { clause: parts.length ? ("WHERE " + parts.join(" AND ")) : "", params };
  }

  async function executeSearch(silent){
    if(!db){ return; }
    currentWhere = buildWhere();
    const cnt = runSQL(`SELECT COUNT(*) FROM "${tableName}" ${currentWhere.clause}`, currentWhere.params);
    currentTotal = cnt.values[0][0];
    currentPage = 1;
    renderPage();
    if(!silent) showToast(`Tìm thấy ${currentTotal.toLocaleString('vi-VN')} kết quả.`, false);
  }

  el("btnSearch").addEventListener("click", ()=> executeSearch(false));
  el("searchInput").addEventListener("keydown", (e)=>{ if(e.key==="Enter") executeSearch(false); });
  el("btnReset").addEventListener("click", ()=>{
    el("searchInput").value = "";
    colFilterInputs.forEach(inp=> inp.value = "");
    el("exactMatch").checked = false;
    executeSearch(false);
  });

  // ---------------- Vẽ bảng / phân trang (truy vấn SQL trực tiếp theo trang) ----------------
  function renderPage(){
    if(!db){ return; }
    const totalPages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));
    if(currentPage > totalPages) currentPage = totalPages;
    const offset = (currentPage-1) * PAGE_SIZE;

    const selCols = displayCols.filter(c=>dbColumns.includes(c));
    const orderCol = selCols.includes(currentSort.col) ? currentSort.col : selCols[0];
    const sql = `SELECT rowid, ${selCols.map(c=>`"${c}"`).join(",")} FROM "${tableName}" ${currentWhere.clause}
                 ORDER BY "${orderCol}" ${currentSort.dir===1?"ASC":"DESC"} LIMIT ? OFFSET ?`;
    const res = runSQL(sql, [...currentWhere.params, PAGE_SIZE, offset]);

    const tbody = el("tableBody");
    el("emptyState").style.display = currentTotal===0 ? "block" : "none";

    tbody.innerHTML = res.values.map(row=>{
      const rowid = row[0];
      const cells = selCols.map((c,i)=>{
        const val = row[i+1]; // +1 vì cột 0 là rowid
        const cls = isMonoCol(c) ? " class=\"mono\"" : "";
        return `<td${cls}>${escHtml(val)||"—"}</td>`;
      }).join("");
      return `<tr data-rowid="${rowid}">${cells}</tr>`;
    }).join("");

    tbody.querySelectorAll("tr").forEach(tr=>{
      tr.addEventListener("click", ()=> openDrawer(Number(tr.dataset.rowid)));
    });

    el("resultCount").textContent = currentTotal.toLocaleString('vi-VN') + " kết quả";
    el("statFiltered").textContent = currentTotal.toLocaleString('vi-VN');
    renderPagination(totalPages, currentTotal, offset, res.values.length);
  }

  function renderPagination(totalPages, total, offset, shown){
    el("pgInfo").textContent = total===0 ? "" :
      `${(offset+1).toLocaleString('vi-VN')}–${(offset+shown).toLocaleString('vi-VN')} / ${total.toLocaleString('vi-VN')}`;
    el("pgFirst").disabled = currentPage===1;
    el("pgPrev").disabled = currentPage===1;
    el("pgNext").disabled = currentPage>=totalPages;
    el("pgLast").disabled = currentPage>=totalPages;

    const nums = el("pgNumbers");
    nums.innerHTML = "";
    const windowSize = 5;
    let s = Math.max(1, currentPage - Math.floor(windowSize/2));
    let e = Math.min(totalPages, s + windowSize - 1);
    s = Math.max(1, e - windowSize + 1);
    for(let p=s; p<=e; p++){
      const b = document.createElement("button");
      b.className = "pg-btn" + (p===currentPage ? " active" : "");
      b.textContent = p;
      b.addEventListener("click", ()=>{ currentPage = p; renderPage(); });
      nums.appendChild(b);
    }
  }
  el("pgFirst").addEventListener("click", ()=>{ currentPage=1; renderPage(); });
  el("pgPrev").addEventListener("click", ()=>{ currentPage=Math.max(1,currentPage-1); renderPage(); });
  el("pgNext").addEventListener("click", ()=>{ currentPage++; renderPage(); });
  el("pgLast").addEventListener("click", ()=>{ currentPage=Math.ceil(currentTotal/PAGE_SIZE)||1; renderPage(); });

  // ---------------- Ngăn kéo chi tiết (lấy đầy đủ toàn bộ cột theo rowid) ----------------
  function openDrawer(rowid){
    const res = runSQL(`SELECT rowid, * FROM "${tableName}" WHERE rowid = ?`, [rowid]);
    if(!res.values.length) return;
    const cols = res.columns.filter(c=>c!=="rowid");
    const row = res.values[0];
    const g = (name)=>{ const i = res.columns.indexOf(name); return i===-1 ? "" : row[i]; };

    const titleCol = displayCols.find(c=>g(c)) || cols.find(c=>g(c));
    el("drawerStt").textContent = "BẢN GHI #" + rowid;
    el("drawerName").textContent = (titleCol ? g(titleCol) : "") || "—";

    const fields = cols.map(c=>[COLUMN_LABELS[c]||c, g(c), isMonoCol(c)]);

    el("drawerBody").innerHTML = `<div class="dgroup">
      <div class="dgroup-title">Toàn bộ thông tin (bảng "${escHtml(tableName)}")</div>
      ${fields.map(f=>`<div class="dfield"><span class="k">${escHtml(f[0])}</span><span class="v${f[2]?' mono':''}">${escHtml(f[1])||"—"}</span></div>`).join("")}
    </div>`;

    el("overlay").classList.add("show");
    el("drawer").classList.add("show");
  }
  function closeDrawer(){ el("overlay").classList.remove("show"); el("drawer").classList.remove("show"); }
  el("overlay").addEventListener("click", closeDrawer);
  el("drawerClose").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", e=>{ if(e.key==="Escape"){ closeDrawer(); closeExcelModal(); closeImportModal(); } });

  // ---------------- Xuất Excel kết quả tìm kiếm hiện tại (chọn cột muốn xuất) ----------------
  function openExportModal(){
    if(!db){ showToast("Chưa có dữ liệu để xuất.", true); return; }
    if(currentTotal === 0){ showToast("Không có dữ liệu phù hợp để xuất.", true); return; }
    buildColumnChecklist(el("exportColList"), dbColumns, []); // mặc định không chọn cột nào = xuất tất cả
    el("exportModal").classList.add("show");
  }
  function closeExportModal(){ el("exportModal").classList.remove("show"); }
  el("btnExport").addEventListener("click", openExportModal);
  el("exportModalClose").addEventListener("click", closeExportModal);
  el("exportModalBackdrop").addEventListener("click", closeExportModal);
  el("btnExportSelectAll").addEventListener("click", ()=> setAllChecked(el("exportColList"), true));
  el("btnExportSelectNone").addEventListener("click", ()=> setAllChecked(el("exportColList"), false));

  el("btnRunExport").addEventListener("click", async ()=>{
    if(!db) return;
    if(currentTotal > LARGE_EXPORT_WARN){
      const ok = confirm(`Kết quả hiện có ${currentTotal.toLocaleString('vi-VN')} dòng — file Excel xuất ra có thể rất lớn và mất nhiều thời gian/bộ nhớ trình duyệt.\n\nBạn có muốn tiếp tục không?`);
      if(!ok) return;
    }
    const chosen = getCheckedColumns(el("exportColList"));
    const headerCols = chosen.length ? chosen : dbColumns; // không chọn cột nào => xuất tất cả cột trong bảng
    closeExportModal();

    loadingScreen.style.display = "flex";
    loadingText.textContent = `Đang thu thập dữ liệu để xuất (0 / ${currentTotal.toLocaleString('vi-VN')})…`;
    await sleep(10);

    try{
      const data = [];
      let offset = 0;
      while(offset < currentTotal){
        const sql = `SELECT ${headerCols.map(c=>`"${c}"`).join(",")} FROM "${tableName}" ${currentWhere.clause} LIMIT ? OFFSET ?`;
        const res = runSQL(sql, [...currentWhere.params, SCAN_CHUNK, offset]);
        for(const row of res.values){
          const obj = {};
          headerCols.forEach((c,i)=>{ obj[COLUMN_LABELS[c] || c] = row[i]; });
          data.push(obj);
        }
        offset += SCAN_CHUNK;
        loadingText.textContent = `Đang thu thập dữ liệu để xuất (${Math.min(offset,currentTotal).toLocaleString('vi-VN')} / ${currentTotal.toLocaleString('vi-VN')})…`;
        await sleep(0);
      }

      loadingText.textContent = "Đang tạo file Excel…";
      await sleep(10);
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Ket qua");
      const stamp = new Date().toISOString().slice(0,10);
      XLSX.writeFile(wb, `DuLieu_XuatKetQua_${stamp}.xlsx`);
      showToast(`Đã xuất ${data.length.toLocaleString('vi-VN')} bản ghi (${headerCols.length} cột) ra Excel.`, false);
    }catch(err){
      showToast("Lỗi khi xuất Excel: " + err.message, true);
    }finally{
      loadingScreen.style.display = "none";
    }
  });


  // ===================================================================
  // TÌM KIẾM ĐỐI CHIẾU TỪ FILE EXCEL
  // ===================================================================
  let excelWorkbook = null;
  let excelSheetHeaders = [];
  let excelSheetRows = [];   // toàn bộ dòng dữ liệu (mảng object) của sheet đang chọn

  function buildDbColSelect(){
    const sel = el("dbColSelect");
    sel.innerHTML = dbColumns.map(c=>`<option value="${escAttr(c)}">${escHtml(COLUMN_LABELS[c]||c)}</option>`).join("");
    // Ưu tiên chọn sẵn một cột định danh hay dùng nếu có
    const preferred = ["MaSoBHXH","Col7","Col6","Col12"].find(c=>dbColumns.includes(c));
    if(preferred) sel.value = preferred;
    updateRunButtonState();
    buildColumnChecklist(el("excelExportColList"), dbColumns, []); // mặc định không chọn cột nào = xuất tất cả cột
  }

  function openExcelModal(){
    el("excelModal").classList.add("show");
  }
  function closeExcelModal(){
    el("excelModal").classList.remove("show");
  }
  el("btnExcelSearch").addEventListener("click", openExcelModal);
  el("excelModalClose").addEventListener("click", closeExcelModal);
  el("excelModalBackdrop").addEventListener("click", closeExcelModal);

  el("excelDrop").addEventListener("click", ()=> el("excelFileInput").click());

  el("excelFileInput").addEventListener("change", async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    el("excelFileName").textContent = "Đang đọc " + file.name + "…";
    try{
      const buf = await file.arrayBuffer();
      excelWorkbook = XLSX.read(buf, { type:"array" });
      el("excelFileName").textContent = file.name;
      const sheetSel = el("excelSheetSelect");
      sheetSel.disabled = false;
      sheetSel.innerHTML = '<option value="">— Chọn sheet —</option>' +
        excelWorkbook.SheetNames.map(n=>`<option value="${escAttr(n)}">${escHtml(n)}</option>`).join("");
      el("excelColSelect").disabled = true;
      el("excelColSelect").innerHTML = '<option value="">— Chọn sheet trước —</option>';
      excelSheetRows = [];
      updateRunButtonState();
    }catch(err){
      showToast("Không đọc được file Excel: " + err.message, true);
      el("excelFileName").textContent = "";
    }
  });

  el("excelSheetSelect").addEventListener("change", (e)=>{
    const sheetName = e.target.value;
    const colSel = el("excelColSelect");
    if(!sheetName){
      colSel.disabled = true;
      colSel.innerHTML = '<option value="">— Chọn sheet trước —</option>';
      excelSheetRows = [];
      updateRunButtonState();
      return;
    }
    const ws = excelWorkbook.Sheets[sheetName];
    excelSheetRows = XLSX.utils.sheet_to_json(ws, { defval:"" });
    // Lấy danh sách cột (theo thứ tự xuất hiện, gộp từ vài dòng đầu để tránh thiếu cột)
    const headerSet = [];
    const sampleN = Math.min(excelSheetRows.length, 50);
    for(let i=0;i<sampleN;i++){
      Object.keys(excelSheetRows[i]).forEach(k=>{ if(!headerSet.includes(k)) headerSet.push(k); });
    }
    if(headerSet.length===0 && excelSheetRows.length){ Object.keys(excelSheetRows[0]).forEach(k=>headerSet.push(k)); }
    excelSheetHeaders = headerSet;

    colSel.disabled = false;
    colSel.innerHTML = '<option value="">— Chọn cột —</option>' +
      headerSet.map(h=>`<option value="${escAttr(h)}">${escHtml(h)}</option>`).join("");
    updateRunButtonState();
  });

  el("excelColSelect").addEventListener("change", updateRunButtonState);
  el("dbColSelect").addEventListener("change", updateRunButtonState);
  el("btnExcelExportSelectAll").addEventListener("click", ()=> setAllChecked(el("excelExportColList"), true));
  el("btnExcelExportSelectNone").addEventListener("click", ()=> setAllChecked(el("excelExportColList"), false));

  function updateRunButtonState(){
    const ok = db && excelSheetRows.length>0 && el("excelColSelect").value && el("dbColSelect").value;
    el("btnRunExcelMatch").disabled = !ok;
  }

  async function buildIndexForDbColumn(colName, onProgress){
    const map = new Map();
    let offset = 0;
    while(offset < currentTotalRowsForIndex()){
      const res = runSQL(`SELECT rowid, "${colName}" FROM "${tableName}" LIMIT ? OFFSET ?`, [SCAN_CHUNK, offset]);
      if(!res.values.length) break;
      for(const row of res.values){
        const key = norm(row[1]);
        if(!key) continue;
        if(!map.has(key)) map.set(key, []);
        map.get(key).push(row[0]);
      }
      offset += res.values.length;
      onProgress && onProgress(offset);
      await sleep(0);
      if(res.values.length < SCAN_CHUNK) break;
    }
    return map;
  }
  function currentTotalRowsForIndex(){
    // Tổng số dòng thật sự trong bảng (không áp bộ lọc) — dùng cho việc quét dựng chỉ mục đối chiếu
    return currentTotal_ALL();
  }
  let _allCountCache = null;
  function currentTotal_ALL(){
    if(_allCountCache===null){
      const r = runSQL(`SELECT COUNT(*) FROM "${tableName}"`);
      _allCountCache = r.values[0][0];
    }
    return _allCountCache;
  }

  async function fetchRowsByRowids(rowids){
    const resultMap = new Map();
    for(let i=0;i<rowids.length;i+=FETCH_BATCH){
      const batch = rowids.slice(i, i+FETCH_BATCH);
      const placeholders = batch.map(()=>"?").join(",");
      const res = runSQL(`SELECT rowid, * FROM "${tableName}" WHERE rowid IN (${placeholders})`, batch);
      res.values.forEach(v=>{
        const obj = {};
        res.columns.forEach((c,ci)=>{ if(c!=="rowid") obj[c] = v[ci]; });
        resultMap.set(v[0], obj);
      });
      await sleep(0);
    }
    return resultMap;
  }

  function setExcelProgress(pct, text){
    el("excelProgressWrap").classList.add("show");
    el("excelProgressFill").style.width = Math.max(0,Math.min(100,pct)) + "%";
    el("excelProgressText").textContent = text;
  }

  el("btnRunExcelMatch").addEventListener("click", async ()=>{
    const excelCol = el("excelColSelect").value;
    const dbCol = el("dbColSelect").value;
    if(!excelCol || !dbCol || !excelSheetRows.length) return;

    el("btnRunExcelMatch").disabled = true;
    el("excelResultSummary").classList.remove("show");
    _allCountCache = null;

    try{
      // Bước 1: dựng chỉ mục cho cột dữ liệu đã chọn
      setExcelProgress(0, "Đang quét dữ liệu .db để dựng chỉ mục đối chiếu…");
      const totalAll = currentTotal_ALL();
      const indexMap = await buildIndexForDbColumn(dbCol, (done)=>{
        setExcelProgress((done/Math.max(totalAll,1))*60, `Đang quét dữ liệu .db: ${done.toLocaleString('vi-VN')} / ${totalAll.toLocaleString('vi-VN')}`);
      });

      // Bước 2: so khớp từng dòng Excel
      setExcelProgress(62, "Đang đối chiếu dữ liệu Excel…");
      await sleep(0);
      const matchedPairs = [];   // { rowid, excelRow }
      const notFoundRows = [];
      const rowidSet = new Set();
      excelSheetRows.forEach(erow=>{
        const val = erow[excelCol];
        const key = norm(val);
        const hit = key ? indexMap.get(key) : undefined;
        if(hit && hit.length){
          hit.forEach(rid=>{ matchedPairs.push({ rowid: rid, excelRow: erow }); rowidSet.add(rid); });
        }else{
          notFoundRows.push(erow);
        }
      });

      // Bước 3: lấy đầy đủ dữ liệu .db cho các rowid tìm thấy
      setExcelProgress(70, `Đang lấy dữ liệu chi tiết cho ${rowidSet.size.toLocaleString('vi-VN')} bản ghi khớp…`);
      const uniqueRowids = Array.from(rowidSet);
      const rowDataMap = await fetchRowsByRowids(uniqueRowids);
      setExcelProgress(90, "Đang tạo file Excel kết quả…");
      await sleep(10);

      // Sheet 1: Tìm thấy — các cột .db đã chọn (hoặc tất cả nếu không chọn) + cột Excel (đặt ở cuối, tiền tố "[Excel]")
      const chosenExportCols = getCheckedColumns(el("excelExportColList"));
      const foundHeaderCols = chosenExportCols.length ? chosenExportCols : dbColumns;
      const foundData = matchedPairs.map(p=>{
        const dbRow = rowDataMap.get(p.rowid) || {};
        const obj = {};
        foundHeaderCols.forEach(c=>{ obj[COLUMN_LABELS[c]||c] = dbRow[c]; });
        excelSheetHeaders.forEach(h=>{ obj["[Excel] " + h] = p.excelRow[h]; });
        return obj;
      });

      // Sheet 2: Không tìm thấy — chỉ dữ liệu gốc từ Excel
      const notFoundData = notFoundRows.map(r=>{
        const obj = {};
        excelSheetHeaders.forEach(h=> obj[h] = r[h]);
        return obj;
      });

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(foundData), "Tim thay");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(notFoundData), "Khong tim thay");
      const stamp = new Date().toISOString().slice(0,10);
      XLSX.writeFile(wb, `DoiChieu_Excel_${stamp}.xlsx`);

      setExcelProgress(100, "Hoàn tất.");
      const summary = el("excelResultSummary");
      summary.classList.add("show");
      summary.innerHTML = `Đã xử lý <b>${excelSheetRows.length.toLocaleString('vi-VN')}</b> dòng Excel.<br>
        Tìm thấy: <b>${matchedPairs.length.toLocaleString('vi-VN')}</b> dòng khớp (từ ${rowidSet.size.toLocaleString('vi-VN')} bản ghi trong .db).<br>
        Không tìm thấy: <b>${notFoundRows.length.toLocaleString('vi-VN')}</b> dòng.<br>
        File Excel kết quả đã được tải xuống.`;
      showToast("Đối chiếu hoàn tất — đã tải file Excel kết quả.", false);
    }catch(err){
      showToast("Lỗi khi đối chiếu: " + err.message, true);
    }finally{
      el("btnRunExcelMatch").disabled = false;
    }
  });

  // ---------------- Khởi động ----------------
  tryLoadDefaultFile();

})();
