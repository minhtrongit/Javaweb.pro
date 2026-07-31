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
  const DISPLAY_COLS = ["STT","MaSoBHXH","Col6","Col7","Col8","Col12","Col13","Col14"];
  const LOAI_DOI_TUONG = {
    "GD":"Hộ gia đình", "DN":"Doanh nghiệp", "TE":"Trẻ em dưới 6 tuổi",
    "HS":"Học sinh, sinh viên", "HT":"Hưu trí", "CH":"Cận nghèo"
  };

  const el = (id) => document.getElementById(id);
  const loadingScreen = el("loadingScreen");
  const loadingText = el("loadingText");
  const toastEl = el("toast");

  function showToast(msg, isErr){
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>{ toastEl.classList.remove("show"); }, 4200);
  }
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  function escHtml(s){ return (s===undefined||s===null?"":s.toString()).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function escAttr(s){ return escHtml(s).replace(/"/g,"&quot;"); }
  function stripLabel(str){ if(!str) return ""; const i = str.indexOf(":"); return i===-1 ? str.trim() : str.slice(i+1).trim(); }
  function norm(s){ return (s||"").toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/đ/g,"d"); }
  function parseTenChuHo(str){
    let ten="", ma="";
    if(str){
      str.split(";").forEach(p=>{
        const t = p.trim();
        if(t.toLowerCase().startsWith("tên chủ hộ")) ten = stripLabel(t);
        else if(t.toLowerCase().startsWith("mã hộ")) ma = stripLabel(t);
      });
    }
    return {ten, ma};
  }

  // ---------------- Trạng thái toàn cục ----------------
  let SQLModule = null;
  let db = null;
  let tableName = "";
  let dbColumns = [];      // danh sách cột thật sự có trong bảng
  let currentSort = { col: "STT", dir: 1 };
  let currentPage = 1;
  let currentTotal = 0;
  let currentWhere = { clause: "", params: [] };

  function setSource(name, ok){
    const chip = el("sourceChip");
    chip.className = "source-chip " + (ok ? "ok" : "err");
    el("sourceFname").textContent = name;
  }

  function runSQL(sql, params){
    const stmt = db.prepare(sql);
    if(params && params.length) stmt.bind(params);
    const cols = stmt.getColumnNames();
    const rows = [];
    while(stmt.step()){ rows.push(stmt.get()); }
    stmt.free();
    return { columns: cols, values: rows };
  }
  function runExec(sql, params){
    if(params && params.length){ runSQL(sql, params); return; }
    db.run(sql);
  }

  async function initSql(){
    return await initSqlJs({ locateFile: f => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${f}` });
  }

  // ---------------- Nạp CSDL ----------------
  async function loadDatabaseFromBytes(bytes, label){
    if(!SQLModule){ loadingText.textContent = "Đang khởi tạo công cụ đọc SQLite…"; SQLModule = await initSql(); }
    if(db){ try{ db.close(); }catch(e){} }
    loadingText.textContent = "Đang mở tệp dữ liệu…";
    db = new SQLModule.Database(new Uint8Array(bytes));

    const tblRes = runSQL("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    if(!tblRes.values.length) throw new Error("Không tìm thấy bảng dữ liệu nào trong file.");
    tableName = tblRes.values[0][0];

    const pragma = runSQL(`PRAGMA table_info("${tableName}")`);
    dbColumns = pragma.values.map(r => r[1]);

    loadingText.textContent = "Đang tạo chỉ mục tăng tốc tìm kiếm…";
    await sleep(10);
    const idxCols = ["MaSoBHXH","Col6","Col7","Col12","Huyen","XaPhuong","Col11","STT"].filter(c=>dbColumns.includes(c));
    for(const c of idxCols){
      try{ runExec(`CREATE INDEX IF NOT EXISTS "idx_${c}" ON "${tableName}"("${c}")`); }catch(e){ /* bỏ qua nếu lỗi */ }
      await sleep(0);
    }

    const cnt = runSQL(`SELECT COUNT(*) FROM "${tableName}"`);
    currentTotal = cnt.values[0][0];
    el("statTotal").textContent = currentTotal.toLocaleString('vi-VN');

    // Thống kê nhanh (không chặn UI lâu — dùng COUNT(DISTINCT))
    try{
      if(dbColumns.includes("MaSoBHXH")){
        const h = runSQL(`SELECT COUNT(DISTINCT "MaSoBHXH") FROM "${tableName}"`);
        el("statHouseholds").textContent = h.values[0][0].toLocaleString('vi-VN');
      }
      if(dbColumns.includes("Huyen")){
        const hu = runSQL(`SELECT COUNT(DISTINCT "Huyen") FROM "${tableName}" WHERE "Huyen" IS NOT NULL AND "Huyen" != ''`);
        el("statHuyen").textContent = hu.values[0][0].toLocaleString('vi-VN');
      }
    }catch(e){}

    buildDbColSelect();
    setSource(label, true);

    currentWhere = { clause:"", params:[] };
    currentPage = 1;
    await executeSearch(true);

    showToast(`Đã tải "${label}" — ${currentTotal.toLocaleString('vi-VN')} bản ghi.`, false);
  }

  async function tryLoadDefaultFile(){
    loadingText.textContent = "Đang tải dữ liệu mặc định…";
    try{
      const resp = await fetch("./" + DEFAULT_FILENAME, {cache:"no-store"});
      if(!resp.ok) throw new Error("HTTP " + resp.status);
      const buf = await resp.arrayBuffer();
      await loadDatabaseFromBytes(buf, DEFAULT_FILENAME);
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
      await loadDatabaseFromBytes(buf, file.name);
    }catch(err){
      showToast("Lỗi khi đọc file: " + err.message, true);
      setSource("Lỗi đọc file", false);
    }finally{
      loadingScreen.style.display = "none";
      e.target.value = "";
    }
  });
  el("btnPickFile").addEventListener("click", ()=> el("filePicker").click());

  // ---------------- Bộ lọc theo từng cột (phía trên tiêu đề bảng) ----------------
  const colFilterInputs = Array.from(document.querySelectorAll(".col-filter"));
  colFilterInputs.forEach(inp=>{
    inp.addEventListener("keydown", (e)=>{ if(e.key==="Enter") executeSearch(false); });
    inp.addEventListener("click", (e)=> e.stopPropagation());
  });

  // ---------------- Xây WHERE từ điều kiện hiện tại ----------------
  function buildWhere(){
    const parts = [];
    const params = [];
    const exact = el("exactMatch").checked;

    // Ô tìm kiếm chung — áp dụng trên nhiều cột (OR giữa các cột)
    const q = el("searchInput").value.trim();
    if(q){
      const searchCols = ["Col6","Col7","MaSoBHXH","Col12","TenChuHo"].filter(c=>dbColumns.includes(c));
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

  // ---------------- Sắp xếp ----------------
  document.querySelectorAll("thead th").forEach(th=>{
    th.addEventListener("click", ()=>{
      const col = th.dataset.col;
      if(!dbColumns.includes(col)) return;
      if(currentSort.col === col){ currentSort.dir *= -1; } else { currentSort = { col, dir: 1 }; }
      document.querySelectorAll("thead th .arrow").forEach(a=>a.remove());
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = currentSort.dir===1 ? "▲" : "▼";
      th.appendChild(arrow);
      currentPage = 1;
      renderPage();
    });
  });

  // ---------------- Vẽ bảng / phân trang (truy vấn SQL trực tiếp theo trang) ----------------
  function genderBadgeRaw(g){ return g ? escHtml(g) : "—"; }

  function renderPage(){
    if(!db){ return; }
    const totalPages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));
    if(currentPage > totalPages) currentPage = totalPages;
    const offset = (currentPage-1) * PAGE_SIZE;

    const selCols = DISPLAY_COLS.filter(c=>dbColumns.includes(c));
    const orderCol = dbColumns.includes(currentSort.col) ? currentSort.col : "STT";
    const sql = `SELECT rowid, ${selCols.map(c=>`"${c}"`).join(",")} FROM "${tableName}" ${currentWhere.clause}
                 ORDER BY "${orderCol}" ${currentSort.dir===1?"ASC":"DESC"} LIMIT ? OFFSET ?`;
    const res = runSQL(sql, [...currentWhere.params, PAGE_SIZE, offset]);

    const tbody = el("tableBody");
    el("emptyState").style.display = currentTotal===0 ? "block" : "none";

    const idx = {}; selCols.forEach((c,i)=> idx[c] = i+1); // +1 vì cột 0 là rowid

    tbody.innerHTML = res.values.map(row=>{
      const rowid = row[0];
      const get = (c)=> idx[c]!==undefined ? row[idx[c]] : "";
      return `<tr data-rowid="${rowid}">
        <td class="mono">${escHtml(get("STT"))}</td>
        <td class="mono">${escHtml(get("MaSoBHXH"))||"—"}</td>
        <td class="name-cell">${escHtml(get("Col6"))||"—"}</td>
        <td class="mono">${escHtml(get("Col7"))||"—"}</td>
        <td>${escHtml(get("Col8"))||"—"}</td>
        <td class="mono">${escHtml(get("Col12"))||"—"}</td>
        <td>${get("Col13") ? `<span class="badge">${escHtml(get("Col13"))}</span>` : "—"}</td>
        <td>${escHtml(get("Col14"))||"—"}</td>
      </tr>`;
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
    const cols = res.columns;
    const row = res.values[0];
    const g = (name)=>{ const i = cols.indexOf(name); return i===-1 ? "" : row[i]; };

    const chuho = parseTenChuHo(g("TenChuHo"));
    const loaiMa = (g("Col13")||"").toString().trim();

    el("drawerStt").textContent = "HỒ SƠ #" + g("STT");
    el("drawerName").textContent = g("Col6") || "—";

    const groups = [
      { title:"Thông tin cá nhân", fields:[
        ["Họ và tên", g("Col6")],
        ["Ngày sinh", g("Col8")],
        ["Giới tính", g("Col9")],
        ["Số CCCD/CMND", g("Col12"), true],
        ["Quan hệ với chủ hộ", (g("Col11")||"").toString().trim()],
      ]},
      { title:"Thông tin BHXH / BHYT", fields:[
        ["Mã số BHXH cá nhân", g("Col7"), true],
        ["Mã hộ gia đình", g("MaSoBHXH"), true],
        ["Loại đối tượng", LOAI_DOI_TUONG[loaiMa] || loaiMa],
        ["Giá trị thẻ / Thời hạn BHYT", g("Col14")],
        ["Mã cơ quan quản lý", g("Col17"), true],
      ]},
      { title:"Chủ hộ", fields:[
        ["Tên chủ hộ", chuho.ten],
        ["Mã hộ gia đình", chuho.ma || g("MaSoBHXH"), true],
      ]},
      { title:"Địa chỉ", fields:[
        ["Thôn/Bản/Tổ dân phố", stripLabel(g("Thon"))],
        ["Xã/Phường/Thị trấn", stripLabel(g("XaPhuong"))],
        ["Huyện/Thị xã", stripLabel(g("Huyen"))],
        ["Địa chỉ gốc (dữ liệu nhập)", g("Col10")],
      ]},
      { title:"Khác", fields:[
        ["Ghi chú", [g("Col18"), g("Col19")].filter(Boolean).join(" · ") || "—"],
        ["File nguồn", g("TenFile"), true],
      ]},
    ];

    el("drawerBody").innerHTML = groups.map(gr=>{
      const rows = gr.fields.filter(f=>f[1] !== undefined);
      if(!rows.some(f=>f[1] && f[1] !== "—")) return "";
      return `<div class="dgroup">
        <div class="dgroup-title">${gr.title}</div>
        ${rows.map(f=>`<div class="dfield"><span class="k">${f[0]}</span><span class="v${f[2]?' mono':''}">${escHtml(f[1])||"—"}</span></div>`).join("")}
      </div>`;
    }).join("");

    el("overlay").classList.add("show");
    el("drawer").classList.add("show");
  }
  function closeDrawer(){ el("overlay").classList.remove("show"); el("drawer").classList.remove("show"); }
  el("overlay").addEventListener("click", closeDrawer);
  el("drawerClose").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", e=>{ if(e.key==="Escape"){ closeDrawer(); closeExcelModal(); } });

  // ---------------- Xuất Excel kết quả tìm kiếm hiện tại (đầy đủ mọi cột) ----------------
  el("btnExport").addEventListener("click", async ()=>{
    if(!db){ showToast("Chưa có dữ liệu để xuất.", true); return; }
    if(currentTotal === 0){ showToast("Không có dữ liệu phù hợp để xuất.", true); return; }
    if(currentTotal > LARGE_EXPORT_WARN){
      const ok = confirm(`Kết quả hiện có ${currentTotal.toLocaleString('vi-VN')} dòng — file Excel xuất ra có thể rất lớn và mất nhiều thời gian/bộ nhớ trình duyệt.\n\nBạn có muốn tiếp tục không?`);
      if(!ok) return;
    }

    loadingScreen.style.display = "flex";
    loadingText.textContent = `Đang thu thập dữ liệu để xuất (0 / ${currentTotal.toLocaleString('vi-VN')})…`;
    await sleep(10);

    try{
      const headerCols = dbColumns; // toàn bộ cột trong .db
      const data = [];
      let offset = 0;
      while(offset < currentTotal){
        const sql = `SELECT * FROM "${tableName}" ${currentWhere.clause} LIMIT ? OFFSET ?`;
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
      XLSX.writeFile(wb, `HoGiaDinh_XuatDuLieu_${stamp}.xlsx`);
      showToast(`Đã xuất ${data.length.toLocaleString('vi-VN')} bản ghi (đầy đủ cột) ra Excel.`, false);
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

      // Sheet 1: Tìm thấy — toàn bộ cột .db + cột Excel (đặt ở cuối, tiền tố "Excel - ")
      const foundData = matchedPairs.map(p=>{
        const dbRow = rowDataMap.get(p.rowid) || {};
        const obj = {};
        dbColumns.forEach(c=>{ obj[COLUMN_LABELS[c]||c] = dbRow[c]; });
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
