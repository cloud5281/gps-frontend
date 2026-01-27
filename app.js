import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, onChildAdded, set, get, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { Chart, registerables } from 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm';
// 🔥🔥🔥 修改 1：引入 Zoom Plugin 🔥🔥🔥
import zoomPlugin from 'https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/+esm';

// 🔥🔥🔥 修改 2：註冊 Zoom Plugin 🔥🔥🔥
Chart.register(...registerables, zoomPlugin);

/**
 * 1. 設定管理
 */
const Config = (() => {
    const urlParams = new URLSearchParams(window.location.search);
    
    const firebaseId = urlParams.get('id') || "real-time-gps-84c8a"; 
    const projectPath = urlParams.get('path') || "test_project";

    if (!firebaseId || !projectPath) {
        alert("❌ 網址參數錯誤：缺少 id (Firebase ID) 或 path (專案名稱)");
    } else {
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    return {
        firebaseProjectId: firebaseId,
        apiKey: urlParams.get('key') || "AIzaSyCjPnL5my8NsG7XYCbABGh45KtKM9s4SlI",
        dbRootPath: projectPath, 
        gpsIp: "",
        gpsPort: "",
        concUnit: "",
        dbURL: urlParams.get('db') || null,
        ZOOM_LEVEL: 17, 
        COLORS: {
            GREEN: '#28a745', YELLOW: '#ffc107', ORANGE: '#fd7e14', RED: '#dc3545'
        }
    };
})();

/**
 * 2. 地圖管理器
 */
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
        const pos = [lat, lon];
        this.marker.setLatLng(pos);
        if (autoCenter) this.map.panTo(pos);
    }

    addHistoryPoint(data, getColorFn) {
        const pos = [data.lat, data.lon];
        this.coordsArray.push(pos);
        this.pathLine.setLatLngs(this.coordsArray);

        const color = getColorFn(data.conc);
        
        const circle = L.circleMarker(pos, {
            stroke: false,
            fillColor: color,
            fillOpacity: 0.9,
            radius: 8
        });
        circle.concValue = data.conc;

        const unit = data.conc_unit || Config.concUnit;
        const tooltipHtml = `
            <div style="text-align: left; line-height: 1.5;">
                <span>⏰ 時間:</span> ${data.timestamp}<br>
                <span>📍 經緯:</span> ${data.lon.toFixed(6)}, ${data.lat.toFixed(6)}<br>
                <span>🧪 濃度:</span> ${data.conc} ${unit}<br>
            </div>`;
        circle.bindTooltip(tooltipHtml, { permanent: false, direction: 'top', className: 'custom-tooltip', offset: [0, -8] });
        this.historyLayer.addLayer(circle);
    }

    refreshColors(getColorFn) {
        this.historyLayer.eachLayer((layer) => {
            if (layer.concValue !== undefined) {
                layer.setStyle({ fillColor: getColorFn(layer.concValue) });
            }
        });
    }

    fitToPath() {
        if (this.coordsArray.length > 0) {
            const bounds = this.pathLine.getBounds();
            if (bounds.isValid()) {
                this.map.fitBounds(bounds, { padding: [50, 50] }); 
            }
        }
    }

    focusOnPoint(lat, lon) {
        const target = L.latLng(lat, lon);
        let foundLayer = null;

        this.historyLayer.eachLayer((layer) => {
            if (layer.getLatLng && layer.getLatLng().equals(target)) {
                foundLayer = layer;
            }
        });

        if (foundLayer) {
            if (this.lastFocusedLayer && this.lastFocusedLayer !== foundLayer) {
                this.lastFocusedLayer.closeTooltip();
            }

            this.map.setView(target, Config.ZOOM_LEVEL);
            foundLayer.openTooltip();
            this.lastFocusedLayer = foundLayer;
        }
    }
}

/**
 * 3. 介面管理器
 */
class UIManager {
    constructor(mapManager, db) {
        this.mapManager = mapManager;
        this.db = db;
        this.thresholds = { a: 50, b: 100, c: 150 };
        this.isRecording = false;
        this.chart = null; 
        this.sortedHistoryData = []; 
        this.chartTitleTextEl = null; // 儲存標題文字物件

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
            inputs: {
                a: document.getElementById('val-a'),
                b: document.getElementById('val-b'),
                c: document.getElementById('val-c')
            },
            displays: {
                a: document.getElementById('disp-a'),
                b: document.getElementById('disp-b'),
                c: document.getElementById('disp-c')
            },
            msgBox: document.getElementById('msg-box')
        };

        this.els.path.innerText = Config.dbRootPath;
        this.updateThresholdDisplay();
        this.els.inputs.a.value = this.thresholds.a;
        this.els.inputs.b.value = this.thresholds.b;
        this.els.inputs.c.value = this.thresholds.c;

        if (this.els.autoCenter) {
            this.els.autoCenter.checked = true;
        }

        this.injectChartUI();
    }

    injectChartUI() {
        const lastInput = this.els.inputs.c;
        
        if (lastInput && lastInput.parentElement && lastInput.parentElement.parentElement) {
            
            // 處理面板滾動
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
            
            // --- 標題區域 ---
            // 🔥🔥🔥 關鍵：直接套用 CSS 裡的 class，確保樣式 100% 一致 🔥🔥🔥
            const headerDiv = document.createElement('div');
            headerDiv.className = 'section-header'; 
            
            // 建立一個 span 來放文字，方便後續修改內容 (加上單位)
            const titleSpan = document.createElement('span');
            titleSpan.innerText = "歷史濃度趨勢"; 
            
            headerDiv.appendChild(titleSpan);
            container.appendChild(headerDiv);
            
            // 儲存這個 span 的參照
            this.chartTitleTextEl = titleSpan;

            // --- 圖表區域 ---
            const canvasWrapper = document.createElement('div');
            canvasWrapper.style.position = 'relative';
            canvasWrapper.style.height = '180px'; 
            canvasWrapper.style.width = '100%';
            
            const canvas = document.createElement('canvas');
            canvas.id = 'concChart';
            canvasWrapper.appendChild(canvas);
            container.appendChild(canvasWrapper);

            // --- 底部留白 ---
            const spacer = document.createElement('div');
            spacer.style.height = '40px'; 
            spacer.style.width = '100%';
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
                    pointHitRadius: 20,   
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: '#dc3545', // 浮現時的顏色 (例如：紅色)
                    pointHoverBorderColor: '#ffffff',     // 浮現時的邊框顏色 (例如：白色)
                    pointHoverBorderWidth: 2,             // 浮現時的邊框粗細  
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false, 
                layout: {
                    padding: { left: 0, right: 10, top: 0, bottom: 0 }
                },
                scales: {
                    x: {
                        display: true, 
                        grid: { display: false },
                        ticks: { display: false } 
                    },
                    y: {
                        beginAtZero: true,
                        grid: { color: '#f0f0f0' },
                        ticks: { font: { size: 11 } } 
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        bodyFont: { size: 13 },
                        padding: 10
                    },
                    // 🔥🔥🔥 修改 3：加入 zoom plugin 設定 🔥🔥🔥
                    zoom: {
                        zoom: {
                            wheel: { enabled: true }, // 啟用滾輪縮放
                            pinch: { enabled: true }, // 啟用觸控縮放
                            mode: 'x',                // 只縮放 X 軸 (時間)
                        },
                        pan: {
                            enabled: true,            // 啟用平移 (拖曳)
                            mode: 'x',                // 只平移 X 軸
                        },
                        limits: {
                            x: { min: 'original', max: 'original' } // 防止拖曳到沒有資料的地方
                        }
                    }
                },
                onClick: (e, elements) => {
                    if (elements.length > 0) {
                        const index = elements[0].index;
                        const record = this.sortedHistoryData[index];
                        
                        if (record && record.lat && record.lon) {
                            this.mapManager.focusOnPoint(record.lat, record.lon);
                        }
                    }
                },
                interaction: {
                    mode: 'nearest',
                    axis: 'x',
                    intersect: false
                }
            }
        });
    }

    updateChart(historyData) {
        if (!this.chart || !historyData) return;

        this.sortedHistoryData = Object.values(historyData).sort((a, b) => {
            return a.timestamp.localeCompare(b.timestamp);
        });

        const labels = this.sortedHistoryData.map(d => d.timestamp.split(' ')[1]); 
        const values = this.sortedHistoryData.map(d => d.conc);

        this.chart.data.labels = labels;
        this.chart.data.datasets[0].data = values;
        this.chart.update();
        
        // 🔥 當資料更新時，重置縮放狀態，以免卡在舊的位置 🔥
        this.chart.resetZoom();
    }

    syncConfigFromBackend(data) {
        if (!data) return;
        Config.gpsIp = data.gps_ip || "";
        Config.gpsPort = data.gps_port || "";
        Config.concUnit = data.conc_unit || "";
        
        if (!this.els.modal.classList.contains('hidden')) {
            this.fillSettingsInputs();
        }

        // 🔥🔥🔥 這裡就是你要的：同步時加上 (單位) 🔥🔥🔥
        if (this.chartTitleTextEl) {
            const unitText = Config.concUnit ? ` (${Config.concUnit})` : "";
            this.chartTitleTextEl.innerText = `歷史濃度趨勢${unitText}`;
        }
    }

    syncThresholdsFromBackend(data) {
        if (data) {
            this.thresholds = {
                a: parseFloat(data.a),
                b: parseFloat(data.b),
                c: parseFloat(data.c)
            };
        } else {
            this.saveThresholdSettings(true); 
            return; 
        }
        
        if (document.activeElement !== this.els.inputs.a && 
            document.activeElement !== this.els.inputs.b && 
            document.activeElement !== this.els.inputs.c) {
            this.els.inputs.a.value = this.thresholds.a;
            this.els.inputs.b.value = this.thresholds.b;
            this.els.inputs.c.value = this.thresholds.c;
        }

        this.updateThresholdDisplay();
        this.mapManager.refreshColors(this.getColor.bind(this));
    }

    updateThresholdDisplay() {
        this.els.displays.a.innerText = this.thresholds.a;
        this.els.displays.b.innerText = this.thresholds.b;
        this.els.displays.c.innerText = this.thresholds.c;
    }

    fillSettingsInputs() {
        this.els.backendInputs.project.value = Config.dbRootPath;
        this.els.backendInputs.ip.value = Config.gpsIp;
        this.els.backendInputs.port.value = Config.gpsPort;
        this.els.backendInputs.unit.value = Config.concUnit;
    }

    bindEvents() {
        this.els.btnOpenSettings.addEventListener('click', () => {
            this.fillSettingsInputs();
            this.els.modal.classList.remove('hidden');
        });

        this.els.btnCloseModal.addEventListener('click', () => this.els.modal.classList.add('hidden'));
        this.els.modal.addEventListener('click', (e) => {
            if (e.target === this.els.modal) this.els.modal.classList.add('hidden');
        });

        this.els.btnSaveBackend.addEventListener('click', () => {
            this.saveBackendSettings();
        });

        // 🔥🔥🔥 修正：讓設定視窗內的輸入框支援 Enter 鍵儲存 🔥🔥🔥
        Object.values(this.els.backendInputs).forEach(input => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault(); 
                    input.blur(); 
                    this.saveBackendSettings();
                }
            });
        });

        Object.values(this.els.inputs).forEach(input => {
            const saveHandler = (e) => {
                if (e.type === 'keydown' && e.key !== 'Enter') return;
                e.preventDefault();
                input.blur();
                this.saveThresholdSettings(); 
            };
            input.addEventListener('keydown', saveHandler);
            input.addEventListener('blur', () => this.saveThresholdSettings());
        });

        const portInput = this.els.backendInputs.port;
        if(portInput) {
            portInput.addEventListener('keydown', (e) => {
                const allowedKeys = [8, 9, 13, 27, 46];
                if (allowedKeys.includes(e.keyCode) || 
                   (e.keyCode >= 35 && e.keyCode <= 40) ||
                   (e.ctrlKey === true || e.metaKey === true)) {
                    return;
                }
                const isNumber = (e.keyCode >= 48 && e.keyCode <= 57) || (e.keyCode >= 96 && e.keyCode <= 105);
                if (!isNumber) {
                    e.preventDefault();
                }
            });
        }

        this.els.btnStart.addEventListener('click', () => this.toggleRecordingCommand());
        this.els.btnUpload.addEventListener('click', () => this.triggerUploadProcess());
        this.els.btnDownload.addEventListener('click', () => this.downloadHistoryAsCSV());
    }

    triggerUploadProcess() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv';
        input.style.display = 'none';
        
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                this.parseAndUploadCSV(file);
            }
        };
        
        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
    }

    parseAndUploadCSV(file) {
        const btn = this.els.btnUpload;
        const originalText = btn.innerText;
        btn.disabled = true;
        btn.innerText = "上傳中...";

        let projectName = file.name.replace(/\.csv$/i, "").trim();
        if (!projectName) {
            alert("❌ 檔名無效，無法作為專案名稱");
            btn.disabled = false;
            btn.innerText = originalText;
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target.result;
                const lines = text.split(/\r?\n/); 
                
                if (lines.length < 2) throw new Error("CSV 內容為空或格式錯誤");

                const uploadData = {};
                let count = 0;
                let lastRecord = null;

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    const cols = line.split(',');
                    if (cols.length < 4) continue;

                    const record = {
                        timestamp: cols[0].trim(),
                        lat: parseFloat(cols[1]),
                        lon: parseFloat(cols[2]),
                        conc: parseFloat(cols[3]),
                        conc_unit: cols[4] ? cols[4].trim() : "",
                        status: cols[5] ? cols[5].trim() : ""
                    };

                    if (!isNaN(record.lat) && !isNaN(record.lon)) {
                        const key = `record_${Date.now()}_${i}`;
                        uploadData[key] = record;
                        lastRecord = record; 
                        count++;
                    }
                }

                if (count === 0) throw new Error("找不到有效的數據行");

                const updates = {};
                updates[`${projectName}/history`] = uploadData;
                
                if (lastRecord) {
                    updates[`${projectName}/latest`] = lastRecord;
                }

                update(ref(this.db), updates)
                    .then(() => {
                        const isDifferentProject = (projectName !== Config.dbRootPath);

                        if (isDifferentProject) {
                            alert(`✅ 上傳成功！共 ${count} 筆資料。\n\n系統將自動切換至新專案: ${projectName}`);
                            
                            btn.innerText = "切換中...";
                            this.setInterfaceMode('switching', "專案切換中... (約 1 分鐘)", "gray", "offline");

                            const updateRef = ref(this.db, `${Config.dbRootPath}/control/config_update`);
                            set(updateRef, { project_name: projectName });

                            const url = new URL(window.location.href);
                            url.searchParams.set('path', projectName);
                            localStorage.setItem('should_fit_bounds', 'true');
                            
                            window.location.href = url.toString();
                            
                        } else {
                            localStorage.setItem('should_fit_bounds', 'true');
                            alert(`✅ 上傳成功！共 ${count} 筆資料。\n\n頁面將重新整理以顯示數據。`);
                            location.reload();
                        }
                    })
                    .catch((err) => {
                        console.error(err);
                        alert("❌ 上傳至 Firebase 失敗: " + err.message);
                        btn.disabled = false;
                        btn.innerText = originalText;
                    });

            } catch (err) {
                alert("❌ 解析 CSV 失敗: " + err.message);
                btn.disabled = false;
                btn.innerText = originalText;
            }
        };

        reader.readAsText(file);
    }

    async downloadHistoryAsCSV() {
        const btn = this.els.btnDownload;
        const originalText = btn.innerText;
        btn.disabled = true;
        btn.innerText = "下載中...";

        try {
            const historyRef = ref(this.db, `${Config.dbRootPath}/history`);
            const snapshot = await get(historyRef);

            if (!snapshot.exists()) {
                alert("❌ 目前沒有歷史資料可供下載");
                return;
            }

            const data = snapshot.val();
            let csvContent = "\uFEFF"; 
            csvContent += "Timestamp,Latitude,Longitude,Concentration,Unit,Status\n";

            Object.values(data).forEach(row => {
                const t = row.timestamp || "";
                const lat = row.lat || "";
                const lon = row.lon || "";
                const conc = row.conc || 0;
                const unit = row.conc_unit || Config.concUnit;
                const st = row.status || "";
                csvContent += `${t},${lat},${lon},${conc},${unit},${st}\n`;
            });

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `${Config.dbRootPath}.csv`; 
            link.click();
            URL.revokeObjectURL(url);

        } catch (error) {
            console.error(error);
            alert("❌ 下載失敗: " + error.message);
        } finally {
            btn.disabled = false;
            btn.innerText = originalText;
        }
    }

    setInterfaceMode(mode, statusText, statusColor = 'gray', statusClass = 'offline') {
        const thresholdInputs = Object.values(this.els.inputs);
        
        this.els.statusText.innerText = statusText;
        this.els.statusText.style.color = statusColor;
        this.els.statusDot.className = `status-dot st-${statusClass}`;

        if (mode === 'switching') {
            if (this.els.controlBar) this.els.controlBar.style.display = 'none';
            if (this.els.btnOpenSettings) this.els.btnOpenSettings.style.display = 'none';
            thresholdInputs.forEach(input => input.disabled = true);
        }
        else if (mode === 'offline') {
            if (this.els.controlBar) this.els.controlBar.style.display = ''; 
            
            this.els.btnStart.classList.add('hidden');         
            this.els.btnUpload.classList.remove('hidden');     
            this.els.btnDownload.classList.remove('hidden');   
            
            if (this.els.btnOpenSettings) this.els.btnOpenSettings.style.display = 'none';
            thresholdInputs.forEach(input => input.disabled = false);
        }
        else if (mode === 'recording') {
            if (this.els.controlBar) this.els.controlBar.style.display = '';
            if (this.els.btnOpenSettings) this.els.btnOpenSettings.classList.add('invisible'); 
            
            this.els.btnStart.innerText = "停止";
            this.els.btnStart.classList.remove('hidden'); 
            this.els.btnStart.classList.add('btn-stop');
            
            this.els.btnUpload.classList.add('hidden');
            this.els.btnDownload.classList.add('hidden');
            
            thresholdInputs.forEach(input => input.disabled = false);
            this.isRecording = true;
        } 
        else if (mode === 'idle') {
            if (this.els.controlBar) this.els.controlBar.style.display = '';
            if (this.els.btnOpenSettings) {
                this.els.btnOpenSettings.style.display = '';
                this.els.btnOpenSettings.classList.remove('invisible');
            }

            this.els.btnStart.innerText = "開始";
            this.els.btnStart.classList.remove('hidden'); 
            this.els.btnStart.classList.remove('btn-stop');
            
            this.els.btnUpload.classList.remove('hidden');
            this.els.btnDownload.classList.remove('hidden');

            thresholdInputs.forEach(input => input.disabled = false);
            this.isRecording = false;
        }
    }

    saveBackendSettings() {
        const p = this.els.backendInputs.project.value.trim();
        const i = this.els.backendInputs.ip.value.trim();
        const pt = this.els.backendInputs.port.value.trim();
        const u = this.els.backendInputs.unit.value.trim();
        const updateData = {};
        if (p) updateData.project_name = p;
        if (i) updateData.gps_ip = i;
        if (pt) updateData.gps_port = pt;
        if (u) updateData.conc_unit = u;

        if (Object.keys(updateData).length === 0) { alert("⚠️ 未輸入任何變更參數"); return; }

        const btn = this.els.btnSaveBackend;
        const originalText = btn.innerText;
        btn.disabled = true;

        const isProjectChanged = (updateData.project_name && updateData.project_name !== Config.dbRootPath);

        if (isProjectChanged) {
            btn.innerText = "切換中...";
            this.setInterfaceMode('switching', "專案切換中... (約 1 分鐘)", "gray", "offline");
        } else {
            btn.innerText = "更新中...";
        }

        const updateRef = ref(this.db, `${Config.dbRootPath}/control/config_update`);
        
        set(updateRef, updateData).then(() => {
            if (isProjectChanged) {
                const url = new URL(window.location.href);
                url.searchParams.set('id', Config.firebaseProjectId);
                if (Config.apiKey) url.searchParams.set('key', Config.apiKey);
                url.searchParams.set('path', updateData.project_name);
                
                localStorage.setItem('is_switching', 'true');
                
                window.location.href = url.toString();
            } else {
                btn.innerText = "✅ 已更新";
                setTimeout(() => {
                    this.els.modal.classList.add('hidden');
                    btn.disabled = false;
                    btn.innerText = originalText;
                }, 800);
            }
        }).catch((err) => {
            alert("更新失敗: " + err);
            btn.disabled = false;
            btn.innerText = originalText;
            if (isProjectChanged) {
                this.setInterfaceMode('idle', "更新失敗", "red", "timeout");
            }
        });
    }

    toggleRecordingCommand() {
        const cmdRef = ref(this.db, `${Config.dbRootPath}/control/command`);
        const newCmd = this.isRecording ? "stop" : "start";
        set(cmdRef, newCmd);
    }

    startClock() {
        setInterval(() => this.els.time.innerText = new Date().toLocaleTimeString('zh-TW', { hour12: false }), 1000);
    }

    updateRealtimeData(data, isActive) {
        if (!isActive) {
            this.els.coords.innerText = "-";
            this.els.conc.innerText = "-";
            this.els.conc.style.color = 'black';
            return;
        }
        this.els.coords.innerText = `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`;
        if (data.conc !== undefined) {
            const unit = data.conc_unit || Config.concUnit;
            this.els.conc.innerText = `${data.conc} ${unit}`;
            this.els.conc.style.color = (data.conc >= this.thresholds.c) ? 'red' : 'black';
        }
    }

    getColor(value) {
        if (value < this.thresholds.a) return Config.COLORS.GREEN;
        if (value < this.thresholds.b) return Config.COLORS.YELLOW;
        if (value < this.thresholds.c) return Config.COLORS.ORANGE;
        return Config.COLORS.RED;
    }

    saveThresholdSettings(isSilent = false) {
        const { a: elA, b: elB, c: elC } = this.els.inputs;
        const msgBox = this.els.msgBox;
        [elA, elB, elC].forEach(el => el.classList.remove('input-error'));
        if (!isSilent) msgBox.innerText = "";

        const valA = parseFloat(elA.value);
        const valB = parseFloat(elB.value);
        const valC = parseFloat(elC.value);
        let error = null;
        if (isNaN(valA) || isNaN(valB) || isNaN(valC)) error = "❌ 請填入完整數值";
        else if (valA >= valB) { elA.classList.add('input-error'); error = "❌ 黃色需大於綠色"; }
        else if (valB >= valC) { elB.classList.add('input-error'); error = "❌ 橙色需大於黃色"; }

        if (error) {
            msgBox.innerText = error;
            msgBox.style.color = "red";
            return;
        }

        const thRef = ref(this.db, `${Config.dbRootPath}/settings/thresholds`);
        set(thRef, { a: valA, b: valB, c: valC })
            .then(() => {
                if (!isSilent) {
                    msgBox.innerText = "✅ 設定已儲存至雲端";
                    msgBox.style.color = "green";
                    setTimeout(() => msgBox.innerText = "", 2000);
                }
            })
            .catch((err) => {
                console.error(err);
                if (!isSilent) {
                    msgBox.innerText = "❌ 儲存失敗";
                    msgBox.style.color = "red";
                }
            });
    }
}

/**
 * 4. 應用程式入口
 */
async function main() {
    const firebaseConfig = {
        apiKey: Config.apiKey,
        authDomain: `${Config.firebaseProjectId}.firebaseapp.com`,
        databaseURL: Config.dbURL || `https://${Config.firebaseProjectId}-default-rtdb.asia-southeast1.firebasedatabase.app`,
        projectId: Config.firebaseProjectId,
    };
    const app = initializeApp(firebaseConfig);
    const db = getDatabase(app);
    const mapManager = new MapManager();
    const uiManager = new UIManager(mapManager, db);
    let backendState = 'offline';
    let lastGpsData = null;

    onValue(ref(db, `${Config.dbRootPath}/settings/current_config`), (snapshot) => {
        if (snapshot.val()) uiManager.syncConfigFromBackend(snapshot.val());
    });

    onValue(ref(db, `${Config.dbRootPath}/settings/thresholds`), (snapshot) => {
        uiManager.syncThresholdsFromBackend(snapshot.val());
    });

    onValue(ref(db, `${Config.dbRootPath}/history`), (snapshot) => {
        if(snapshot.exists()) {
            uiManager.updateChart(snapshot.val());
        }

        if (localStorage.getItem('should_fit_bounds') === 'true' && snapshot.exists()) {
            const data = snapshot.val();
            const keys = Object.keys(data).sort();
            
            if (keys.length > 0) {
                const lastKey = keys[keys.length - 1];
                const lastRecord = data[lastKey];

                if (lastRecord && lastRecord.lat && lastRecord.lon) {
                    mapManager.updateCurrentPosition(lastRecord.lat, lastRecord.lon, true);
                    mapManager.map.setZoom(Config.ZOOM_LEVEL);
                }
            }
            
            localStorage.removeItem('should_fit_bounds');
        }
    });

    onValue(ref(db, `${Config.dbRootPath}/status`), (snapshot) => {
        const data = snapshot.val();
        const isSwitchingLocal = localStorage.getItem('is_switching');
        
        if (isSwitchingLocal) {
            if (data && (data.state === 'stopped' || data.state === 'active')) {
                localStorage.removeItem('is_switching');
            } else {
                uiManager.setInterfaceMode('switching', "專案切換中... (約 1 分鐘)", "gray", "offline");
                uiManager.updateRealtimeData({}, false);
                return;
            }
        }

        if (!data || data.state === 'offline') {
            if (data && data.state === 'switching') {
                uiManager.setInterfaceMode('switching', "專案切換中... (約 1 分鐘)", "gray", "offline");
            } else {
                uiManager.setInterfaceMode('offline', "未連接 Controller", "gray", "offline");
            }
            uiManager.updateRealtimeData({}, false);
            return;
        }

        backendState = data.state;
        
        switch (data.state) {
            case 'switching': 
                uiManager.setInterfaceMode('switching', "專案切換中... (約 1 分鐘)", "gray", "offline");
                break;

            case 'stopped': 
                uiManager.setInterfaceMode('idle', "紀錄已停止，請重新開始", "gray", "stopped");
                break;

            case 'connecting': 
                uiManager.setInterfaceMode('recording', "連線中...", "#d39e00", "connecting");
                break;

            case 'active': 
                uiManager.setInterfaceMode('recording', "連線成功", "#28a745", "active");
                if (lastGpsData) uiManager.updateRealtimeData(lastGpsData, true);
                break;

            case 'timeout': 
                uiManager.setInterfaceMode('idle', "連線逾時，請重新開始", "#dc3545", "timeout");
                break;

            default:
                uiManager.setInterfaceMode('offline', "未連接 Controller", "gray", "offline");
                break;
        }

        if (data.state !== 'active') {
            uiManager.updateRealtimeData({}, false);
        }
    });

    onValue(ref(db, `${Config.dbRootPath}/latest`), (snapshot) => {
        const data = snapshot.val();
        if (data && data.lat) {
            lastGpsData = data;
            mapManager.updateCurrentPosition(data.lat, data.lon, document.getElementById('autoCenter').checked);
            if (backendState === 'active') uiManager.updateRealtimeData(data, true);
        }
    });
    onChildAdded(ref(db, `${Config.dbRootPath}/history`), (snapshot) => {
        if (snapshot.val()) mapManager.addHistoryPoint(snapshot.val(), uiManager.getColor.bind(uiManager));
    });

    const autoCenterBox = document.getElementById('autoCenter');
    if (autoCenterBox) {
        autoCenterBox.addEventListener('change', (e) => {
            if (e.target.checked && lastGpsData && lastGpsData.lat) {
                mapManager.updateCurrentPosition(lastGpsData.lat, lastGpsData.lon, true);
                mapManager.map.setZoom(Config.ZOOM_LEVEL);
            }
        });
    }
}

main();