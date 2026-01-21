import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, onChildAdded, set } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

/**
 * 1. 設定管理
 */
const Config = (() => {
    const urlParams = new URLSearchParams(window.location.search);
    
    const firebaseId = urlParams.get('id'); 
    const projectPath = urlParams.get('path');

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
        this.thresholds = { a: 50, b: 100, c: 150 };
        this.isRecording = false;

        this.initDOM();
        this.bindEvents();
        this.loadThresholdSettings(); 
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
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                    this.saveThresholdSettings();
                }
            });
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

    /**
     * 🔥 修改核心：控制系統繁忙/離線狀態
     * @param {boolean} isBusy - 是否處於離線或繁忙狀態
     * @param {string} customText - 狀態列顯示文字
     * @param {boolean} allowThresholds - 是否允許調整濃度閾值 (即使在 isBusy 狀態下)
     */
    setSystemBusy(isBusy, customText = null, allowThresholds = false) {
        const thresholdInputs = Object.values(this.els.inputs);

        if (isBusy) {
            // 1. 隱藏下方白色控制列 (開始/上傳/下載)
            if (this.els.controlBar) {
                this.els.controlBar.style.display = 'none'; 
            }

            // 2. 隱藏「系統參數」按鈕 (依據需求，兩個情境都要隱藏)
            if (this.els.btnOpenSettings) {
                this.els.btnOpenSettings.style.display = 'none';
            }

            // 3. 控制閾值輸入框是否鎖定
            // 如果 allowThresholds 為 true，則不鎖定 (disabled = false)
            // 如果 allowThresholds 為 false，則鎖定 (disabled = true)
            thresholdInputs.forEach(input => input.disabled = !allowThresholds);

            // 4. 更新狀態顯示
            this.els.statusDot.className = "status-dot st-offline";
            this.els.statusText.innerText = customText || "系統離線";
            this.els.statusText.style.color = "gray";

        } else {
            // 系統正常運作：解除所有限制
            
            // 恢復白框
            if (this.els.controlBar) {
                this.els.controlBar.style.display = ''; 
            }

            // 恢復「系統參數」按鈕
            if (this.els.btnOpenSettings) {
                this.els.btnOpenSettings.style.display = ''; 
            }

            // 解除輸入鎖定
            thresholdInputs.forEach(input => input.disabled = false);
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

        if (Object.keys(updateData).length === 0) {
            alert("⚠️ 未輸入任何變更參數，操作已取消");
            return;
        }

        const btn = this.els.btnSaveBackend;
        const originalText = btn.innerText;
        btn.innerText = "傳送中...";
        btn.disabled = true;

        this.els.modal.classList.add('hidden');
        
        // 按下儲存後，進入「切換中」狀態，鎖定一切 (包含閾值)
        this.setSystemBusy(true, "正在更新設定...", false);

        const updateRef = ref(this.db, `${Config.dbRootPath}/control/config_update`);
        
        set(updateRef, updateData).then(() => {
            if (updateData.project_name && updateData.project_name !== Config.dbRootPath) {
                const url = new URL(window.location.href); // 確保建立完整的 URL 物件
                
                // 修正：因為網址已被清空，必須從 Config 把必要的 ID 補回去
                url.searchParams.set('id', Config.firebaseProjectId);
                
                // 建議：如果您的 API Key 也是透過網址傳入的，建議也補回去，以免失效
                // (如果您都使用預設 Key 則此行可省略，但加上去比較保險)
                if (Config.apiKey) {
                    url.searchParams.set('key', Config.apiKey);
                }

                // 設定新的專案路徑
                url.searchParams.set('path', updateData.project_name);
                sessionStorage.setItem('is_switching', 'true');
                // 更新網址並重整
                window.history.pushState({}, '', url);
                location.reload(); 
            }
        }).catch((err) => {
            alert("更新失敗: " + err);
            btn.disabled = false;
            btn.innerText = originalText;
            // 失敗恢復為未連接狀態 (允許閾值調整)
            this.setSystemBusy(true, "更新失敗", true);
        });
    }

    toggleRecordingCommand() {
        const cmdRef = ref(this.db, `${Config.dbRootPath}/control/command`);
        const newCmd = this.isRecording ? "stop" : "start";
        set(cmdRef, newCmd);
    }

    setButtonState(isRunning) {
        this.isRecording = isRunning;
        if (isRunning) {
            this.els.btnStart.innerText = "停止";
            this.els.btnStart.classList.add('btn-stop');
            this.els.btnUpload.classList.add('hidden');
            this.els.btnDownload.classList.add('hidden');
            this.els.btnOpenSettings.classList.add('invisible');
        } else {
            this.els.btnStart.innerText = "開始";
            this.els.btnStart.classList.remove('btn-stop');
            this.els.btnUpload.classList.remove('hidden');
            this.els.btnDownload.classList.remove('hidden');
            this.els.btnOpenSettings.classList.remove('invisible');
        }
    }

    startClock() {
        setInterval(() => this.els.time.innerText = new Date().toLocaleTimeString('zh-TW', { hour12: false }), 1000);
    }

    updateStatusText(state, displayText) {
        this.els.statusDot.className = `status-dot st-${state}`;
        this.els.statusText.innerText = displayText;
        
        const colorMap = { 'active': '#28a745', 'connecting': '#d39e00', 'offline': 'gray', 'timeout': '#dc3545', 'stopped': 'gray' };
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

    loadThresholdSettings() {
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

    const settingsRef = ref(db, `${Config.dbRootPath}/settings/current_config`);
    onValue(settingsRef, (snapshot) => {
        const configData = snapshot.val();
        if (configData) {
            uiManager.syncConfigFromBackend(configData);
        }
    });

    onValue(ref(db, `${Config.dbRootPath}/status`), (snapshot) => {
        const data = snapshot.val();
        
        // 1. 完全沒資料 (data == null) -> 情境一：未連接 Controller
        if (!data) {
             // 檢查是否剛切換過專案 (讀取 sessionStorage)
             const isSwitching = sessionStorage.getItem('is_switching');

             if (isSwitching) {
                 // 情境 A：剛切換完專案，後端還沒寫入狀態 -> 顯示「切換中」，鎖定介面
                 // 設定：Busy=True, 文字=建立連線中..., AllowThresholds=False (鎖定)
                 uiManager.setSystemBusy(true, "建立連線中... (新專案)", false);
                 
                 // 設定一個 10 秒保險機制：如果 10 秒後後端還沒上線，就視為斷線並允許操作
                 setTimeout(() => {
                    if (sessionStorage.getItem('is_switching')) {
                        sessionStorage.removeItem('is_switching');
                        // 這裡不強制刷新 UI，等待下一次 Firebase 回調或用戶手動重整
                    }
                 }, 10000);

             } else {
                 // 情境 B：單純打開網頁，後端沒開 -> 顯示「未連接」，允許調整閾值
                 // 設定：Busy=True, 文字=未連接 Controller, AllowThresholds=True (允許)
                 uiManager.setSystemBusy(true, "未連接 Controller", true);
             }
             
             uiManager.updateRealtimeData({}, false);
             return;
        }

        // --- 2. 收到資料，代表連線成功 ---
        
        // 🔥 關鍵：一旦收到資料，代表後端已經連上，立刻清除切換標記
        sessionStorage.removeItem('is_switching');

        // (原本的狀態判斷邏輯)
        if (data.state === 'offline') {
             const isServerSwitching = data.message && data.message.includes("切換");
             
             if (isServerSwitching) {
                 uiManager.setSystemBusy(true, "系統切換中...", false);
             } else {
                 uiManager.setSystemBusy(true, "未連接 Controller", true);
             }
             uiManager.updateRealtimeData({}, false);
             return;
        }

        // 3. 正常運作狀態 (active, stopped, connecting...)
        uiManager.setSystemBusy(false);
        backendState = data.state;
        
        // ... (後面的顯示邏輯保持不變) ...
        let displayText = '未連線';
        if (data.state === 'active') displayText = '連線正常';
        else if (data.state === 'connecting') displayText = '連線中...';
        else if (data.state === 'timeout') displayText = '連線逾時';
        else if (data.state === 'stopped') displayText = '已停止';
        // ...
        
        uiManager.updateStatusText(data.state, displayText);
        
        if (data.state === 'active' || data.state === 'connecting') {
            uiManager.setButtonState(true); 
        } else {
            uiManager.setButtonState(false); 
        }
        
        if (data.state === 'active' && lastGpsData) {
            uiManager.updateRealtimeData(lastGpsData, true);
        } else {
            uiManager.updateRealtimeData({}, false);
        }
    });

    onValue(ref(db, `${Config.dbRootPath}/latest`), (snapshot) => {
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

    onChildAdded(ref(db, `${Config.dbRootPath}/history`), (snapshot) => {
        const data = snapshot.val();
        if (data) {
            mapManager.addHistoryPoint(data, uiManager.getColor.bind(uiManager));
        }
    });
}

main();