import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, onChildAdded, set } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

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
}

/**
 * 3. 介面管理器
 */
class UIManager {
    constructor(mapManager, db) {
        this.mapManager = mapManager;
        this.db = db;
        // 預設值
        this.thresholds = { a: 50, b: 100, c: 150 };
        this.isRecording = false;

        this.initDOM();
        this.bindEvents();
        this.startClock();
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
        // 先把預設值填進去顯示
        this.updateThresholdDisplay();
        this.els.inputs.a.value = this.thresholds.a;
        this.els.inputs.b.value = this.thresholds.b;
        this.els.inputs.c.value = this.thresholds.c;
    }

    syncConfigFromBackend(data) {
        if (!data) return;
        Config.dbRootPath = data.project_name || Config.dbRootPath; 
        Config.gpsIp = data.gps_ip || "";
        Config.gpsPort = data.gps_port || "";
        Config.concUnit = data.conc_unit || "";
        
        this.els.path.innerText = Config.dbRootPath;
        if (!this.els.modal.classList.contains('hidden')) {
            this.fillSettingsInputs();
        }
    }

    // 🔥 核心修改：如果是空的，就上傳預設值
    syncThresholdsFromBackend(data) {
        if (data) {
            // Case A: Firebase 有資料 -> 同步下來
            this.thresholds = {
                a: parseFloat(data.a),
                b: parseFloat(data.b),
                c: parseFloat(data.c)
            };
        } else {
            // Case B: Firebase 沒資料 -> 將目前的預設值上傳初始化
            // console.log("Firebase 無閾值資料，正在初始化上傳...");
            this.saveThresholdSettings(true); // true = 靜默上傳，不顯示提示框
            return; // 上傳後會再次觸發這個監聽，所以這裡直接 return 即可
        }
        
        // 更新輸入框 (如果使用者沒有正在打字的話)
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
        this.els.btnUpload.addEventListener('click', () => alert(`準備上傳至 IP: ${Config.gpsIp} Port: ${Config.gpsPort}`));
        this.els.btnDownload.addEventListener('click', () => alert("下載功能開發中..."));
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
            if (this.els.controlBar) this.els.controlBar.style.display = 'none';
            if (this.els.btnOpenSettings) this.els.btnOpenSettings.style.display = 'none';
            thresholdInputs.forEach(input => input.disabled = false);
        }
        else if (mode === 'recording') {
            if (this.els.controlBar) this.els.controlBar.style.display = '';
            if (this.els.btnOpenSettings) this.els.btnOpenSettings.classList.add('invisible'); 
            
            this.els.btnStart.innerText = "停止";
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
            this.setInterfaceMode('switching', "專案切換中...", "gray", "offline");
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
                window.history.pushState({}, '', url);
                location.reload(); 
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

    // 儲存閾值到 Firebase
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

        // 寫入 Firebase
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

    onValue(ref(db, `${Config.dbRootPath}/status`), (snapshot) => {
        const data = snapshot.val();
        const isSwitchingLocal = localStorage.getItem('is_switching');
        
        if (isSwitchingLocal) {
            if (data && (data.state === 'stopped' || data.state === 'active')) {
                localStorage.removeItem('is_switching');
            } else {
                uiManager.setInterfaceMode('switching', "專案切換中", "gray", "offline");
                uiManager.updateRealtimeData({}, false);
                return;
            }
        }

        if (!data || data.state === 'offline') {
            if (data && data.state === 'switching') {
                uiManager.setInterfaceMode('switching', "專案切換中", "gray", "offline");
            } else {
                uiManager.setInterfaceMode('offline', "未連上 Controller", "gray", "offline");
            }
            uiManager.updateRealtimeData({}, false);
            return;
        }

        backendState = data.state;
        
        switch (data.state) {
            case 'switching': 
                uiManager.setInterfaceMode('switching', "專案切換中", "gray", "offline");
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
                uiManager.setInterfaceMode('offline', "未連上 Controller", "gray", "offline");
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
}

main();