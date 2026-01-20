import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, onChildAdded, set } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

/**
 * 1. 設定管理 (Configuration)
 */
const Config = (() => {
    const urlParams = new URLSearchParams(window.location.search);
    
    // 從 LocalStorage 讀取設定
    const savedProject = localStorage.getItem('cfg_project_id');
    const savedIp = localStorage.getItem('cfg_gps_ip');
    const savedPort = localStorage.getItem('cfg_gps_port');
    const savedUnit = localStorage.getItem('cfg_conc_unit');

    // ★ 修正重點：確保 ID 統一
    const defaultId = "20260120"; 
    const finalProjectId = savedProject || urlParams.get('id') || defaultId;

    return {
        projectId: finalProjectId,
        gpsIp: savedIp || "192.168.199.103",
        gpsPort: savedPort || "11123",
        concUnit: savedUnit || "ppb",
        
        apiKey: urlParams.get('key') || "AIzaSyCjPnL5my8NsG7XYCbABGh45KtKM9s4SlI",
        dbPath: urlParams.get('path') || finalProjectId, 
        dbURL: urlParams.get('db') || null,
        COLORS: {
            GREEN: '#28a745', YELLOW: '#ffc107', ORANGE: '#fd7e14', RED: '#dc3545'
        }
    };
})();

/**
 * 2. 地圖管理器 (MapManager)
 */
class MapManager {
    constructor() {
        this.map = L.map('map').setView([25.0330, 121.5654], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);

        this.marker = L.marker([0, 0], { 
            icon: L.icon({
                iconUrl: './man-walking.png',
                iconSize: [40, 40], iconAnchor: [20, 38], popupAnchor: [0, -40]
            }) 
        }).addTo(this.map);

        this.pathLine = L.polyline([], {color: 'blue', weight: 4}).addTo(this.map);
        this.historyLayer = L.layerGroup().addTo(this.map);
        this.coordsArray = [];
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
            color: 'white', fillColor: color, fillOpacity: 0.9, weight: 1, radius: 8
        });
        circle.concValue = data.conc;

        const unit = data.conc_unit || Config.concUnit;

        const tooltipHtml = `
            <div style="text-align: left; line-height: 1.5;">
                <span>⏰ 時間:</span> ${data.timestamp}<br>
                <span>📍 經緯:</span> ${data.lon.toFixed(6)}, ${data.lat.toFixed(6)}<br>
                <span>🧪 濃度:</span> ${data.conc} ${unit}<br>
            </div>`;
            
        circle.bindTooltip(tooltipHtml, {
            permanent: false, direction: 'top', className: 'custom-tooltip', offset: [0, -8]
        });
        
        this.historyLayer.addLayer(circle);
    }

    refreshColors(getColorFn) {
        this.historyLayer.eachLayer((layer) => {
            if (layer.concValue !== undefined) {
                layer.setStyle({ fillColor: getColorFn(layer.concValue) });
            }
        });
    }
}

/**
 * 3. 介面管理器 (UIManager)
 */
class UIManager {
    // ★ 修正重點：Constructor 接收 db 實體
    constructor(mapManager, db) {
        this.mapManager = mapManager;
        this.db = db; // 將資料庫連線存起來
        this.thresholds = { a: 50, b: 100, c: 150 };
        this.isRecording = false;

        this.initDOM();
        this.bindEvents();
        this.loadSettings();
        this.startClock();
    }

    initDOM() {
        this.els = {
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

        this.els.path.innerText = Config.projectId;
    }

    bindEvents() {
        this.els.btnOpenSettings.addEventListener('click', () => {
            this.els.backendInputs.project.value = Config.projectId;
            this.els.backendInputs.ip.value = Config.gpsIp;
            this.els.backendInputs.port.value = Config.gpsPort;
            this.els.backendInputs.unit.value = Config.concUnit;
            this.els.modal.classList.remove('hidden');
        });

        this.els.btnCloseModal.addEventListener('click', () => this.els.modal.classList.add('hidden'));
        this.els.modal.addEventListener('click', (e) => {
            if (e.target === this.els.modal) this.els.modal.classList.add('hidden');
        });

        this.els.btnSaveBackend.addEventListener('click', () => {
            this.saveBackendSettings();
        });

        Object.values(this.els.inputs).forEach(input => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                    this.saveThresholdSettings();
                }
            });
        });

        this.els.btnStart.addEventListener('click', () => this.toggleRecordingState());
        this.els.btnUpload.addEventListener('click', () => alert(`準備上傳至 IP: ${Config.gpsIp} Port: ${Config.gpsPort}`));
        this.els.btnDownload.addEventListener('click', () => alert("下載功能開發中..."));
    }

    saveBackendSettings() {
        const p = this.els.backendInputs.project.value.trim();
        const i = this.els.backendInputs.ip.value.trim();
        const pt = this.els.backendInputs.port.value.trim();
        const u = this.els.backendInputs.unit.value.trim();

        if(!p) return alert("專案名稱不能為空");

        localStorage.setItem('cfg_project_id', p);
        localStorage.setItem('cfg_gps_ip', i);
        localStorage.setItem('cfg_gps_port', pt);
        localStorage.setItem('cfg_conc_unit', u);

        Config.projectId = p;
        Config.gpsIp = i;
        Config.gpsPort = pt;
        Config.concUnit = u;
        // ★ 修正：更新 dbPath 以確保讀取路徑也跟著變
        Config.dbPath = p; 

        this.els.path.innerText = p;

        const btn = this.els.btnSaveBackend;
        const originalText = btn.innerText;
        const originalBg = btn.style.backgroundColor;

        btn.innerText = "儲存成功";
        btn.style.backgroundColor = "#28a745";
        btn.disabled = true;

        setTimeout(() => {
            btn.innerText = originalText;
            btn.style.backgroundColor = originalBg;
            btn.disabled = false;
            this.els.modal.classList.add('hidden');
            // 建議：這裡通常需要 reload 頁面來確保 Firebase listener 重連到新專案
             location.reload(); 
        }, 1000);
    }

    toggleRecordingState() {
        // ★ 修正重點：使用已經傳進來的 this.db，而不是重新 getDatabase()
        const currentProjectId = Config.projectId;
        const cmdRef = ref(this.db, `${currentProjectId}/control/command`);

        console.log(`正在發送指令到: ${currentProjectId}/control/command`);

        if (!this.isRecording) {
            // 發送 Start
            set(cmdRef, "start").then(() => {
                console.log("✅ Start 指令發送成功");
            }).catch((err) => {
                console.error("❌ 發送失敗:", err);
                alert("發送指令失敗，請檢查 Console");
            });

            this.isRecording = true;
            this.els.btnUpload.classList.add('hidden');
            this.els.btnDownload.classList.add('hidden');
            this.els.btnOpenSettings.classList.add('invisible');
            this.els.btnStart.innerText = "停止";
            this.els.btnStart.classList.add('btn-stop');
        } else {
            // 發送 Stop
            set(cmdRef, "stop").then(() => {
                console.log("✅ Stop 指令發送成功");
            }).catch((err) => {
                console.error("❌ 發送失敗:", err);
                alert("發送指令失敗: " + err);
            });

            this.isRecording = false;
            this.els.btnUpload.classList.remove('hidden');
            this.els.btnDownload.classList.remove('hidden');
            this.els.btnOpenSettings.classList.remove('invisible');
            this.els.btnStart.innerText = "開始";
            this.els.btnStart.classList.remove('btn-stop');
        }
    }

    startClock() {
        setInterval(() => this.els.time.innerText = new Date().toLocaleTimeString('zh-TW', { hour12: false }), 1000);
    }

    updateStatus(state, text) {
        this.els.statusDot.className = `status-dot st-${state}`;
        this.els.statusText.innerText = text;
        const colorMap = { 'active': '#28a745', 'connecting': '#d39e00', 'offline': 'gray', 'timeout': '#dc3545' };
        this.els.statusText.style.color = colorMap[state] || 'gray';
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

    loadSettings() {
        const savedA = localStorage.getItem('th_a');
        const savedB = localStorage.getItem('th_b');
        const savedC = localStorage.getItem('th_c');
        if (savedA) this.els.inputs.a.value = savedA;
        if (savedB) this.els.inputs.b.value = savedB;
        if (savedC) this.els.inputs.c.value = savedC;
        this.saveThresholdSettings(true); 
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

        this.thresholds = { a: valA, b: valB, c: valC };
        this.els.displays.a.innerText = valA;
        this.els.displays.b.innerText = valB;
        this.els.displays.c.innerText = valC;
        localStorage.setItem('th_a', valA);
        localStorage.setItem('th_b', valB);
        localStorage.setItem('th_c', valC);
        this.mapManager.refreshColors(this.getColor.bind(this));

        if (!isSilent) {
            msgBox.innerText = "✅ 閾值已更新";
            msgBox.style.color = "green";
            setTimeout(() => msgBox.innerText = "", 2000);
        }
    }
}

/**
 * 4. 應用程式入口 (Main)
 */
async function main() {
    // 1. 先初始化 Firebase，確保拿到 db 實體
    const firebaseConfig = {
        apiKey: Config.apiKey,
        authDomain: `${Config.projectId}.firebaseapp.com`,
        databaseURL: Config.dbURL || `https://${Config.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app`,
        projectId: Config.projectId,
    };

    const app = initializeApp(firebaseConfig);
    const db = getDatabase(app);

    // 2. 初始化 Managers (★ 把 db 傳給 UIManager)
    const mapManager = new MapManager();
    const uiManager = new UIManager(mapManager, db);

    let backendState = 'offline';
    let lastGpsData = null;

    // 3. 開始監聽資料
    // ★ 注意：這裡使用 Config.dbPath，它現在預設會等於 projectId，所以會聽對位置
    onValue(ref(db, `${Config.dbPath}/status`), (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        backendState = data.state;
        let displayText = '未連線';
        if (data.state === 'active') displayText = '連線正常';
        else if (data.state === 'connecting') displayText = '連線中...';
        else if (data.state === 'timeout') displayText = '連線逾時';
        else if (data.state === 'stopped') displayText = '已停止';

        uiManager.updateStatus(data.state, displayText);
        
        if (data.state === 'active' && lastGpsData) {
            uiManager.updateRealtimeData(lastGpsData, true);
        } else {
            uiManager.updateRealtimeData({}, false);
        }
    });

    onValue(ref(db, `${Config.dbPath}/latest`), (snapshot) => {
        const data = snapshot.val();
        if (data && data.lat) {
            lastGpsData = data;
            const isAuto = document.getElementById('autoCenter').checked;
            mapManager.updateCurrentPosition(data.lat, data.lon, isAuto);

            if (backendState === 'active') {
                uiManager.updateRealtimeData(data, true);
            }
        }
    });

    onChildAdded(ref(db, `${Config.dbPath}/history`), (snapshot) => {
        const data = snapshot.val();
        if (data) {
            mapManager.addHistoryPoint(data, uiManager.getColor.bind(uiManager));
        }
    });
}

main();