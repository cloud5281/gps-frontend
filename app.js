import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, onChildAdded, set, get, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { Chart, registerables } from 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm';
import zoomPlugin from 'https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/+esm';

Chart.register(...registerables, zoomPlugin);

const Config = (() => {
    const urlParams = new URLSearchParams(window.location.search);
    const firebaseId = urlParams.get('id') || "real-time-gps-84c8a"; 
    const projectPath = urlParams.get('path') || "test_project";
    if (!firebaseId || !projectPath) {
        alert("❌ 網址參數錯誤");
    } else {
        window.history.replaceState({}, document.title, window.location.pathname);
    }
    return {
        firebaseProjectId: firebaseId,
        apiKey: urlParams.get('key') || "AIzaSyCjPnL5my8NsG7XYCbABGh45KtKM9s4SlI",
        dbRootPath: projectPath, 
        gpsIp: "", gpsPort: "", concUnit: "",
        dbURL: urlParams.get('db') || null,
        ZOOM_LEVEL: 17, 
        COLORS: { GREEN: '#28a745', YELLOW: '#ffc107', ORANGE: '#fd7e14', RED: '#dc3545' }
    };
})();

class MapManager {
    constructor() {
        this.map = L.map('map').setView([25.0330, 121.5654], Config.ZOOM_LEVEL);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);
        this.marker = L.marker([0, 0], { 
            icon: L.icon({
                iconUrl: './man-walking.png',
                iconSize: [40, 40], iconAnchor: [20, 38], popupAnchor: [0, -40]
            }) 
        }).addTo(this.map);
        this.pathLine = L.polyline([], {color: 'blue', weight: 4}); 
        this.historyLayer = L.layerGroup().addTo(this.map);
        this.coordsArray = [];
        this.lastFocusedLayer = null;
    }

    updateCurrentPosition(lat, lon, autoCenter) {
        if (lat !== null && lon !== null && lat !== undefined && lon !== undefined) {
            const pos = [lat, lon];
            this.marker.setLatLng(pos);
            this.marker.setOpacity(1); 
            if (autoCenter) this.map.panTo(pos);
        } else {
            this.marker.setOpacity(0.5); 
        }
    }

    addHistoryPoint(data, getColorFn) {
        if (data.lat !== undefined && data.lat !== null && data.lon !== undefined && data.lon !== null) {
            const pos = [data.lat, data.lon];
            this.coordsArray.push(pos);
            this.pathLine.setLatLngs(this.coordsArray);
            const color = getColorFn(data.conc);
            const circle = L.circleMarker(pos, { stroke: false, fillColor: color, fillOpacity: 0.9, radius: 8 });
            circle.concValue = data.conc;
            const unit = data.conc_unit || Config.concUnit;
            const tooltipHtml = `<div><span>⏰時間:</span> ${data.timestamp}<br><span>📍經緯:</span> ${data.lon.toFixed(6)}, ${data.lat.toFixed(6)}<br><span>🧪濃度:</span> ${data.conc} ${unit}</div>`;
            circle.bindTooltip(tooltipHtml, { permanent: false, direction: 'top', className: 'custom-tooltip', offset: [0, -8] });
            this.historyLayer.addLayer(circle);
        }
    }

    refreshColors(getColorFn) {
        this.historyLayer.eachLayer((layer) => {
            if (layer.concValue !== undefined) layer.setStyle({ fillColor: getColorFn(layer.concValue) });
        });
    }

    focusOnPoint(lat, lon) {
        if (lat == null || lon == null) return;
        const target = L.latLng(lat, lon);
        let foundLayer = null;
        this.historyLayer.eachLayer((layer) => {
            if (layer.getLatLng && layer.getLatLng().equals(target)) foundLayer = layer;
        });
        if (foundLayer) {
            if (this.lastFocusedLayer && this.lastFocusedLayer !== foundLayer) this.lastFocusedLayer.closeTooltip();
            this.map.setView(target, Config.ZOOM_LEVEL);
            foundLayer.openTooltip();
            this.lastFocusedLayer = foundLayer;
        }
    }
}

class UIManager {
    constructor(mapManager, db) {
        this.mapManager = mapManager;
        this.db = db;
        this.thresholds = { a: 50, b: 100, c: 150 };
        this.isRecording = false;
        this.chart = null; 
        this.sortedHistoryData = []; 
        this.chartTitleTextEl = null; 

        this.initDOM();
        this.setInterfaceMode('offline', "未連接 Controller", "gray", "offline");
        this.bindEvents();
        this.startClock();
        this.initChart();
    }

    initDOM() {
        this.els = {
            controlBar: document.getElementById('bottom-control-bar'),
            time: document.getElementById('time'),
            path: document.getElementById('currentPath'),
            coords: document.getElementById('coords'),
            conc: document.getElementById('concentration'),
            statusDot: document.getElementById('status-dot'),
            statusText: document.getElementById('connection-text'),
            thresholdTitle: document.getElementById('threshold-title-text'),
            autoCenter: document.getElementById('autoCenter'),
            modal: document.getElementById('settings-modal'),
            btnOpenSettings: document.getElementById('btn-open-settings'),
            btnCloseModal: document.getElementById('btn-close-modal'),
            btnSaveBackend: document.getElementById('btn-save-backend'),
            backendInputs: {
                project: document.getElementById('set-project-id'),
                ip: document.getElementById('set-gps-ip'),
                port: document.getElementById('set-gps-port'),
                unit: document.getElementById('set-conc-unit')
            },
            btnStart: document.getElementById('btn-start'),
            btnUpload: document.getElementById('btn-upload'),
            btnDownload: document.getElementById('btn-download'),
            inputs: { a: document.getElementById('val-a'), b: document.getElementById('val-b'), c: document.getElementById('val-c') },
            displays: { a: document.getElementById('disp-a'), b: document.getElementById('disp-b'), c: document.getElementById('disp-c') },
            msgBox: document.getElementById('msg-box')
        };
        this.els.path.innerText = Config.dbRootPath;
        this.updateThresholdDisplay();
        this.els.inputs.a.value = this.thresholds.a;
        this.els.inputs.b.value = this.thresholds.b;
        this.els.inputs.c.value = this.thresholds.c;
        if (this.els.autoCenter) this.els.autoCenter.checked = true;
        this.injectChartUI();
    }

    injectChartUI() {
        const lastInput = this.els.inputs.c;
        if (lastInput && lastInput.parentElement && lastInput.parentElement.parentElement) {
            const infoPanel = lastInput.closest('.info-panel');
            if (infoPanel) {
                infoPanel.style.maxHeight = '85vh'; 
                infoPanel.style.overflowY = 'auto'; 
                infoPanel.style.overflowX = 'hidden';
                infoPanel.style.scrollbarWidth = 'thin';
            }
            const targetParent = lastInput.parentElement.parentElement;
            const container = document.createElement('div');
            container.style.marginTop = '12px';
            container.style.paddingTop = '12px';
            container.style.borderTop = '1px solid #eee';
            
            const headerDiv = document.createElement('div');
            headerDiv.className = 'section-header'; 
            
            const titleSpan = document.createElement('span');
            titleSpan.innerText = "歷史濃度趨勢"; 
            this.chartTitleTextEl = titleSpan;
            headerDiv.appendChild(titleSpan);

            // 灰色提示小字
            const noteSpan = document.createElement('span');
            noteSpan.innerText = " (點選圖表上的點可察看詳細地圖資訊)";
            noteSpan.style.fontSize = "12px";
            noteSpan.style.color = "#999";
            noteSpan.style.fontWeight = "normal";
            noteSpan.style.marginLeft = "8px";
            headerDiv.appendChild(noteSpan);

            container.appendChild(headerDiv);
            
            const canvasWrapper = document.createElement('div');
            canvasWrapper.style.position = 'relative';
            canvasWrapper.style.height = '180px'; 
            canvasWrapper.style.width = '100%';
            const canvas = document.createElement('canvas');
            canvas.id = 'concChart';
            canvasWrapper.appendChild(canvas);
            container.appendChild(canvasWrapper);
            const spacer = document.createElement('div');
            spacer.style.height = '40px'; 
            container.appendChild(spacer);
            targetParent.appendChild(container);
            this.chartCanvas = canvas;
        }
    }

    initChart() {
        if (!this.chartCanvas) return;
        const ctx = this.chartCanvas.getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: '濃度',
                    data: [],
                    borderColor: '#007bff',
                    backgroundColor: 'rgba(0, 123, 255, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 0,
                    pointHitRadius: 25, 
                    pointHoverRadius: 6,
                    fill: true
                }]
            },
            options: {
                responsive: true, 
                maintainAspectRatio: false, 
                scales: { x: { display: true, ticks: { display: false } }, y: { beginAtZero: true } },
                interaction: { mode: 'nearest', axis: 'x', intersect: false }, 
                plugins: {
                    legend: { display: false },
                    zoom: { zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }, pan: { enabled: true, mode: 'x' }, limits: { x: { min: 'original', max: 'original' } } }
                },
                onClick: (e, elements) => {
                    if (elements.length > 0) {
                        const index = elements[0].index;
                        const record = this.sortedHistoryData[index];
                        if (record && record.lat) this.mapManager.focusOnPoint(record.lat, record.lon);
                    }
                }
            }
        });
    }

    updateChart(historyData) {
        if (!this.chart || !historyData) return;
        this.sortedHistoryData = Object.values(historyData).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        this.chart.data.labels = this.sortedHistoryData.map(d => d.timestamp.split(' ')[1]); 
        this.chart.data.datasets[0].data = this.sortedHistoryData.map(d => d.conc);
        this.chart.update();
        this.chart.resetZoom();
    }

    syncConfigFromBackend(data) {
        if (!data) return;
        Config.gpsIp = data.gps_ip || ""; Config.gpsPort = data.gps_port || ""; Config.concUnit = data.conc_unit || "";
        if (!this.els.modal.classList.contains('hidden')) this.fillSettingsInputs();
        if (this.chartTitleTextEl) this.chartTitleTextEl.innerText = `歷史濃度趨勢${Config.concUnit ? ` (${Config.concUnit})` : ""}`;
        if (this.els.thresholdTitle) this.els.thresholdTitle.innerText = `濃度閾值設定${Config.concUnit ? ` (${Config.concUnit})` : ""}`;
    }

    syncThresholdsFromBackend(data) {
        if (data) {
            this.thresholds = { a: parseFloat(data.a), b: parseFloat(data.b), c: parseFloat(data.c) };
        } else {
            this.saveThresholdSettings(true); return; 
        }
        if (document.activeElement !== this.els.inputs.a && document.activeElement !== this.els.inputs.b && document.activeElement !== this.els.inputs.c) {
            this.els.inputs.a.value = this.thresholds.a; this.els.inputs.b.value = this.thresholds.b; this.els.inputs.c.value = this.thresholds.c;
        }
        this.updateThresholdDisplay();
        this.mapManager.refreshColors(this.getColor.bind(this));
    }
    updateThresholdDisplay() { this.els.displays.a.innerText = this.thresholds.a; this.els.displays.b.innerText = this.thresholds.b; this.els.displays.c.innerText = this.thresholds.c; }
    fillSettingsInputs() { this.els.backendInputs.project.value = Config.dbRootPath; this.els.backendInputs.ip.value = Config.gpsIp; this.els.backendInputs.port.value = Config.gpsPort; this.els.backendInputs.unit.value = Config.concUnit; }

    bindEvents() {
        this.els.btnOpenSettings.addEventListener('click', () => { this.fillSettingsInputs(); this.els.modal.classList.remove('hidden'); });
        this.els.btnCloseModal.addEventListener('click', () => this.els.modal.classList.add('hidden'));
        this.els.btnSaveBackend.addEventListener('click', () => this.saveBackendSettings());
        
        // 閾值設定框: Enter 存檔
        Object.values(this.els.inputs).forEach(input => {
            input.addEventListener('blur', () => this.saveThresholdSettings());
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); this.saveThresholdSettings(); } });
        });

        // 參數設定框: Enter 存檔
        Object.values(this.els.backendInputs).forEach(input => {
            if (input) {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        input.blur(); // 解除焦點
                        this.saveBackendSettings(); // 觸發儲存
                    }
                });
            }
        });

        this.els.btnStart.addEventListener('click', () => this.toggleRecordingCommand());
        this.els.btnUpload.addEventListener('click', () => this.triggerUploadProcess());
        this.els.btnDownload.addEventListener('click', () => this.downloadHistoryAsCSV());
    }

    updateRealtimeData(data) {
        if (!data) {
            this.els.coords.innerText = "-";
            this.els.conc.innerText = "-";
            return;
        }

        const status = data.status;

        if (status === 'GPS Lost' || status === 'All Lost' || status === 'V') {
            this.els.coords.innerText = "GPS 訊號中斷"; 
        } else if (data.lat !== undefined && data.lat !== null) {
            this.els.coords.innerText = `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`;
        } else {
            this.els.coords.innerText = "-";
        }

        if (status === 'Sensor Timeout' || status === 'All Lost') {
            this.els.conc.innerText = "濃度訊號中斷";
            this.els.conc.style.color = 'gray';
        } else if (data.conc !== undefined && data.conc !== null) {
            const unit = data.conc_unit || Config.concUnit || "";
            this.els.conc.innerText = `${data.conc} ${unit}`;
            this.els.conc.style.color = (data.conc >= this.thresholds.c) ? 'red' : 'black';
        } else {
            this.els.conc.innerText = "-";
            this.els.conc.style.color = 'black';
        }
    }

    setInterfaceMode(mode, statusText, statusColor = 'gray', statusClass = 'offline') {
        const thresholdInputs = Object.values(this.els.inputs);
        this.els.statusText.innerText = statusText;
        this.els.statusText.style.color = statusColor;
        this.els.statusDot.className = `status-dot st-${statusClass}`;

        if (mode === 'recording') {
            this.els.btnStart.innerText = "停止";
            this.els.btnStart.classList.remove('hidden');
            this.els.btnStart.classList.add('btn-primary-large', 'btn-stop'); 
            
            this.els.btnUpload.classList.add('hidden');
            this.els.btnDownload.classList.add('hidden');
            this.els.btnOpenSettings.classList.add('invisible'); 
            
            thresholdInputs.forEach(input => input.disabled = false);
            this.isRecording = true;
        } 
        else if (mode === 'idle') {
            this.els.btnStart.innerText = "開始";
            this.els.btnStart.classList.remove('hidden', 'btn-stop');
            this.els.btnStart.classList.add('btn-primary-large'); 

            this.els.btnUpload.classList.remove('hidden');
            this.els.btnDownload.classList.remove('hidden');
            
            this.els.btnOpenSettings.style.display = '';
            this.els.btnOpenSettings.classList.remove('invisible');
            
            thresholdInputs.forEach(input => input.disabled = false);
            this.isRecording = false;
        }
        else if (mode === 'offline') {
            this.els.controlBar.style.display = '';
            this.els.btnStart.classList.add('hidden');
            this.els.btnUpload.classList.remove('hidden');
            this.els.btnDownload.classList.remove('hidden');
            
            this.els.btnOpenSettings.style.display = '';
            this.els.btnOpenSettings.classList.remove('invisible');

            thresholdInputs.forEach(input => input.disabled = false);
        }
        else if (mode === 'switching') {
            this.els.controlBar.style.display = 'none';
            this.els.btnOpenSettings.style.display = 'none';
            thresholdInputs.forEach(input => input.disabled = true);
        }
    }

    triggerUploadProcess() { const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv'; input.style.display = 'none'; input.onchange = (e) => { const file = e.target.files[0]; if (file) this.parseAndUploadCSV(file); }; document.body.appendChild(input); input.click(); document.body.removeChild(input); }
    parseAndUploadCSV(file) { const btn = this.els.btnUpload; const originalText = btn.innerText; btn.disabled = true; btn.innerText = "上傳中..."; let projectName = file.name.replace(/\.csv$/i, "").trim(); if (!projectName) { alert("❌ 檔名無效"); btn.disabled = false; btn.innerText = originalText; return; } const reader = new FileReader(); reader.onload = (e) => { try { const text = e.target.result; const lines = text.split(/\r?\n/); if (lines.length < 2) throw new Error("CSV 為空"); const uploadData = {}; let count = 0; let lastRecord = null; for (let i = 1; i < lines.length; i++) { const line = lines[i].trim(); if (!line) continue; const cols = line.split(','); if (cols.length < 4) continue; const record = { timestamp: cols[0].trim(), lat: parseFloat(cols[1]), lon: parseFloat(cols[2]), conc: parseFloat(cols[3]), conc_unit: cols[4] ? cols[4].trim() : "", status: cols[5] ? cols[5].trim() : "" }; if (!isNaN(record.lat) && !isNaN(record.lon)) { const key = `record_${Date.now()}_${i}`; uploadData[key] = record; lastRecord = record; count++; } } if (count === 0) throw new Error("無有效數據"); const updates = {}; updates[`${projectName}/history`] = uploadData; if (lastRecord) updates[`${projectName}/latest`] = lastRecord; update(ref(this.db), updates).then(() => { const isDiff = (projectName !== Config.dbRootPath); if (isDiff) { alert(`✅ 上傳成功，切換至: ${projectName}`); this.setInterfaceMode('switching', "切換中", "gray", "offline"); set(ref(this.db, `${Config.dbRootPath}/control/config_update`), { project_name: projectName }); const url = new URL(window.location.href); url.searchParams.set('path', projectName); localStorage.setItem('should_fit_bounds', 'true'); window.location.href = url.toString(); } else { localStorage.setItem('should_fit_bounds', 'true'); alert("✅ 上傳成功"); location.reload(); } }).catch(err => { alert("上傳失敗: " + err.message); btn.disabled = false; btn.innerText = originalText; }); } catch (err) { alert("解析失敗: " + err.message); btn.disabled = false; btn.innerText = originalText; } }; reader.readAsText(file); }
    async downloadHistoryAsCSV() { const btn = this.els.btnDownload; const originalText = btn.innerText; btn.disabled = true; btn.innerText = "下載中..."; try { const snapshot = await get(ref(this.db, `${Config.dbRootPath}/history`)); if (!snapshot.exists()) { alert("❌ 無歷史資料"); return; } const data = snapshot.val(); let csvContent = "\uFEFFTimestamp,Latitude,Longitude,Concentration,Unit,Status\n"; Object.values(data).forEach(row => { const t = row.timestamp || ""; const lat = row.lat || ""; const lon = row.lon || ""; const conc = row.conc || 0; const unit = row.conc_unit || Config.concUnit; const st = row.status || ""; csvContent += `${t},${lat},${lon},${conc},${unit},${st}\n`; }); const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${Config.dbRootPath}.csv`; link.click(); URL.revokeObjectURL(url); } catch (error) { console.error(error); alert("下載失敗"); } finally { btn.disabled = false; btn.innerText = originalText; } }
    saveBackendSettings() { const p = this.els.backendInputs.project.value.trim(); const i = this.els.backendInputs.ip.value.trim(); const pt = this.els.backendInputs.port.value.trim(); const u = this.els.backendInputs.unit.value.trim(); const updateData = {}; if (p) updateData.project_name = p; if (i) updateData.gps_ip = i; if (pt) updateData.gps_port = pt; if (u) updateData.conc_unit = u; if (Object.keys(updateData).length === 0) { alert("⚠️ 未輸入變更"); return; } const btn = this.els.btnSaveBackend; const originalText = btn.innerText; btn.disabled = true; const isProjectChanged = (updateData.project_name && updateData.project_name !== Config.dbRootPath); if (isProjectChanged) { btn.innerText = "切換中..."; this.setInterfaceMode('switching', "切換中", "gray", "offline"); } else { btn.innerText = "更新中..."; } set(ref(this.db, `${Config.dbRootPath}/control/config_update`), updateData).then(() => { if (isProjectChanged) { const url = new URL(window.location.href); url.searchParams.set('path', updateData.project_name); localStorage.setItem('is_switching', 'true'); window.location.href = url.toString(); } else { btn.innerText = "✅ 已更新"; setTimeout(() => { this.els.modal.classList.add('hidden'); btn.disabled = false; btn.innerText = originalText; }, 800); } }).catch((err) => { alert("更新失敗: " + err); btn.disabled = false; btn.innerText = originalText; if (isProjectChanged) this.setInterfaceMode('idle', "更新失敗", "red", "timeout"); }); }
    toggleRecordingCommand() { set(ref(this.db, `${Config.dbRootPath}/control/command`), this.isRecording ? "stop" : "start"); }
    startClock() { setInterval(() => this.els.time.innerText = new Date().toLocaleTimeString('zh-TW', { hour12: false }), 1000); }
    getColor(value) { if (value < this.thresholds.a) return Config.COLORS.GREEN; if (value < this.thresholds.b) return Config.COLORS.YELLOW; if (value < this.thresholds.c) return Config.COLORS.ORANGE; return Config.COLORS.RED; }
    
    // 🔥🔥🔥 這裡修復了：加入閾值防呆邏輯 🔥🔥🔥
    saveThresholdSettings(isSilent = false) { 
        const { a: elA, b: elB, c: elC } = this.els.inputs;
        const msgBox = this.els.msgBox;
        
        // 重置錯誤樣式
        [elA, elB, elC].forEach(el => el.classList.remove('input-error'));
        if (!isSilent) msgBox.innerText = "";

        const valA = parseFloat(elA.value);
        const valB = parseFloat(elB.value);
        const valC = parseFloat(elC.value);
        
        let error = null;

        // 檢查是否為數字
        if (isNaN(valA) || isNaN(valB) || isNaN(valC)) {
             error = "❌ 請填入完整數值";
        } 
        // 檢查邏輯：綠 < 黃 < 橙
        else if (valA >= valB) {
             elA.classList.add('input-error');
             error = "❌ 綠色閾值需小於黃色閾值";
        } else if (valB >= valC) {
             elB.classList.add('input-error'); 
             error = "❌ 黃色閾值需小於橙色閾值";
        }

        if (error) {
            if (!isSilent) {
                msgBox.innerText = error;
                msgBox.style.color = "red";
            }
            return; // 驗證失敗，不存檔
        }

        // 驗證成功，寫入 Firebase
        set(ref(this.db, `${Config.dbRootPath}/settings/thresholds`), { a: valA, b: valB, c: valC })
            .then(() => {
                if (!isSilent) {
                    msgBox.innerText = "✅ 設定已儲存";
                    msgBox.style.color = "green";
                    setTimeout(() => msgBox.innerText = "", 2000);
                }
            })
            .catch(err => {
                if (!isSilent) {
                    msgBox.innerText = "❌ 儲存失敗";
                    msgBox.style.color = "red";
                }
            });
    }
}

async function main() {
    const firebaseConfig = { apiKey: Config.apiKey, authDomain: `${Config.firebaseProjectId}.firebaseapp.com`, databaseURL: Config.dbURL || `https://${Config.firebaseProjectId}-default-rtdb.asia-southeast1.firebasedatabase.app`, projectId: Config.firebaseProjectId };
    const app = initializeApp(firebaseConfig);
    const db = getDatabase(app);
    const mapManager = new MapManager();
    const uiManager = new UIManager(mapManager, db);
    let backendState = 'offline';
    let lastGpsData = null;
    let lastValidPosition = null; 

    onValue(ref(db, `${Config.dbRootPath}/settings/current_config`), (snapshot) => { if (snapshot.val()) uiManager.syncConfigFromBackend(snapshot.val()); });
    onValue(ref(db, `${Config.dbRootPath}/settings/thresholds`), (snapshot) => { uiManager.syncThresholdsFromBackend(snapshot.val()); });
    
    // 監聽歷史數據
    onValue(ref(db, `${Config.dbRootPath}/history`), (snapshot) => { 
        if(snapshot.exists()) {
            const data = snapshot.val();
            uiManager.updateChart(data);
            
            const sorted = Object.values(data).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            for (let i = sorted.length - 1; i >= 0; i--) {
                if (sorted[i].lat != null && sorted[i].lon != null) {
                    lastValidPosition = { lat: sorted[i].lat, lon: sorted[i].lon };
                    break;
                }
            }

            if (localStorage.getItem('should_fit_bounds') === 'true') { 
                if (lastValidPosition) {
                    mapManager.updateCurrentPosition(lastValidPosition.lat, lastValidPosition.lon, true);
                    mapManager.map.setZoom(Config.ZOOM_LEVEL);
                }
                localStorage.removeItem('should_fit_bounds'); 
            }
        }
    });

    onValue(ref(db, `${Config.dbRootPath}/status`), (snapshot) => {
        const data = snapshot.val();
        if (localStorage.getItem('is_switching') && data && (data.state === 'stopped' || data.state === 'active')) localStorage.removeItem('is_switching');
        
        if (!data || data.state === 'offline') {
            uiManager.setInterfaceMode('offline', "未連接 Controller", "gray", "offline");
            uiManager.updateRealtimeData({}); 
            return;
        }

        backendState = data.state;
        const msg = data.message || "未知狀態";

        switch (data.state) {
            case 'active':
                uiManager.setInterfaceMode('recording', msg, '#28a745', 'active');
                break;
            case 'gps_lost':
            case 'conc_lost':
            case 'connecting':
                uiManager.setInterfaceMode('recording', msg, '#ffc107', 'connecting');
                break;
            case 'all_lost':
            case 'timeout':
                uiManager.setInterfaceMode('idle', msg, '#dc3545', 'timeout');
                break;
            case 'stopped':
                uiManager.setInterfaceMode('idle', msg, 'gray', 'stopped');
                uiManager.updateRealtimeData({});
                break;
            default:
                uiManager.setInterfaceMode('offline', msg, 'gray', 'offline');
                break;
        }
    });

    onValue(ref(db, `${Config.dbRootPath}/latest`), (snapshot) => {
        const data = snapshot.val();
        if (data) {
            lastGpsData = data;
            
            if (data.lat != null && data.lon != null) {
                lastValidPosition = { lat: data.lat, lon: data.lon };
            }

            mapManager.updateCurrentPosition(data.lat, data.lon, document.getElementById('autoCenter').checked);
            
            if (backendState !== 'offline' && backendState !== 'stopped') {
                uiManager.updateRealtimeData(data);
            }
        }
    });

    onChildAdded(ref(db, `${Config.dbRootPath}/history`), (snapshot) => { if (snapshot.val()) mapManager.addHistoryPoint(snapshot.val(), uiManager.getColor.bind(uiManager)); });
    
    const autoCenterBox = document.getElementById('autoCenter');
    if (autoCenterBox) { 
        autoCenterBox.addEventListener('change', (e) => { 
            if (e.target.checked) {
                if (lastGpsData && lastGpsData.lat != null) {
                    mapManager.updateCurrentPosition(lastGpsData.lat, lastGpsData.lon, true);
                    mapManager.map.setZoom(Config.ZOOM_LEVEL);
                } else if (lastValidPosition) {
                    mapManager.updateCurrentPosition(lastValidPosition.lat, lastValidPosition.lon, true);
                    mapManager.map.setZoom(Config.ZOOM_LEVEL);
                }
            }
        }); 
    }
}

main();