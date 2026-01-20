import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, onChildAdded } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

/**
 * 1. 設定管理 (Configuration)
 */
const Config = (() => {
    const urlParams = new URLSearchParams(window.location.search);
    return {
        projectId: urlParams.get('id') || "real-time-gps-84c8a",
        apiKey: urlParams.get('key') || "AIzaSyCjPnL5my8NsG7XYCbABGh45KtKM9s4SlI",
        dbPath: urlParams.get('path') || "test_project",
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

        const tooltipHtml = `
            <div style="text-align: left; line-height: 1.5;">
                <span>⏰ 時間:</span> ${data.timestamp}<br>
                <span>📍 經緯:</span> ${data.lon.toFixed(6)}, ${data.lat.toFixed(6)}<br>
                <span>🧪 濃度:</span> ${data.conc} ${data.conc_unit}<br>
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
 * ★這裡包含了你剛剛要求的按鈕切換與彈窗邏輯★
 */
class UIManager {
    constructor(mapManager) {
        this.mapManager = mapManager;
        this.thresholds = { a: 50, b: 100, c: 150 };
        this.isRecording = false; // 紀錄按鈕狀態

        this.initDOM();
        this.bindEvents(); // 綁定按鈕事件
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
            statusMsg: document.getElementById('status-msg'),
            autoCenter: document.getElementById('autoCenter'),
            
            // --- 新增：彈出視窗相關 ---
            modal: document.getElementById('settings-modal'),
            btnOpenSettings: document.getElementById('btn-open-settings'),
            btnCloseModal: document.getElementById('btn-close-modal'),
            btnSave: document.getElementById('btn-save-settings'),

            // --- 新增：底部按鈕相關 ---
            btnStart: document.getElementById('btn-start'),
            btnUpload: document.getElementById('btn-upload'),
            btnDownload: document.getElementById('btn-download'),

            // 輸入框與顯示文字
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

        this.els.path.innerText = Config.dbPath;
    }

    // --- ★ 新增：綁定所有按鈕事件 ---
    bindEvents() {
        // 1. 彈出視窗開關
        this.els.btnOpenSettings.addEventListener('click', () => {
            this.els.modal.classList.remove('hidden');
        });

        this.els.btnCloseModal.addEventListener('click', () => {
            this.els.modal.classList.add('hidden');
        });

        // 點擊視窗外部關閉
        this.els.modal.addEventListener('click', (e) => {
            if (e.target === this.els.modal) this.els.modal.classList.add('hidden');
        });

        // 2. 儲存設定按鈕
        this.els.btnSave.addEventListener('click', () => {
            this.saveSettings();
            this.els.modal.classList.add('hidden');
        });

        // 3. 閾值輸入框 Enter 鍵儲存
        Object.values(this.els.inputs).forEach(input => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                    this.saveSettings();
                }
            });
        });

        // 4. 底部開始/停止按鈕邏輯
        this.els.btnStart.addEventListener('click', () => {
            this.toggleRecordingState();
        });

        // 5. 上傳/下載 (暫時只有 alert)
        this.els.btnUpload.addEventListener('click', () => alert("上傳功能開發中..."));
        this.els.btnDownload.addEventListener('click', () => alert("下載功能開發中..."));
    }

    // --- ★ 新增：切換錄製狀態邏輯 ---
    toggleRecordingState() {
        if (!this.isRecording) {
            // --- 動作：開始 ---
            this.isRecording = true;
            
            // 隱藏上傳與下載
            this.els.btnUpload.classList.add('hidden');
            this.els.btnDownload.classList.add('hidden');
            
            // 變更按鈕樣式
            this.els.btnStart.innerText = "停止";
            this.els.btnStart.classList.add('btn-stop');
            
            console.log("狀態變更：開始紀錄");
            // TODO: 這裡未來可以加入寫入 Firebase 'status/state' = 'active' 的邏輯
        } else {
            // --- 動作：停止 ---
            this.isRecording = false;
            
            // 顯示上傳與下載
            this.els.btnUpload.classList.remove('hidden');
            this.els.btnDownload.classList.remove('hidden');
            
            // 恢復按鈕樣式
            this.els.btnStart.innerText = "開始";
            this.els.btnStart.classList.remove('btn-stop');
            
            console.log("狀態變更：停止紀錄");
            // TODO: 這裡未來可以加入寫入 Firebase 'status/state' = 'offline' 的邏輯
        }
    }

    startClock() {
        setInterval(() => {
            this.els.time.innerText = new Date().toLocaleTimeString('zh-TW', { hour12: false });
        }, 1000);
    }

    updateStatus(state, text, msg) {
        const { statusDot, statusText, statusMsg } = this.els;
        statusDot.className = `status-dot st-${state}`;
        statusText.innerText = text;
        statusMsg.innerText = msg;
        
        const colorMap = {
            'active': '#28a745', 'connecting': '#d39e00', 'offline': 'gray', 'timeout': '#dc3545'
        };
        statusText.style.color = colorMap[state] || 'gray';
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
            const unit = data.conc_unit || '';
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
        const savedA = localStorage.getItem(`${Config.dbPath}_th_a`);
        const savedB = localStorage.getItem(`${Config.dbPath}_th_b`);
        const savedC = localStorage.getItem(`${Config.dbPath}_th_c`);

        if (savedA) this.els.inputs.a.value = savedA;
        if (savedB) this.els.inputs.b.value = savedB;
        if (savedC) this.els.inputs.c.value = savedC;

        this.saveSettings(true); 
    }

    saveSettings(isSilent = false) {
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

        localStorage.setItem(`${Config.dbPath}_th_a`, valA);
        localStorage.setItem(`${Config.dbPath}_th_b`, valB);
        localStorage.setItem(`${Config.dbPath}_th_c`, valC);

        this.mapManager.refreshColors(this.getColor.bind(this));

        if (!isSilent) {
            msgBox.innerText = "✅ 設定已更新";
            msgBox.style.color = "green";
            setTimeout(() => msgBox.innerText = "", 2000);
        }
    }
}

/**
 * 4. 應用程式入口 (Main)
 */
async function main() {
    const mapManager = new MapManager();
    const uiManager = new UIManager(mapManager);

    const firebaseConfig = {
        apiKey: Config.apiKey,
        authDomain: `${Config.projectId}.firebaseapp.com`,
        databaseURL: Config.dbURL || `https://${Config.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app`,
        projectId: Config.projectId,
    };

    const app = initializeApp(firebaseConfig);
    const db = getDatabase(app);

    let backendState = 'offline';
    let lastGpsData = null;

    // --- 監聽狀態 ---
    onValue(ref(db, `${Config.dbPath}/status`), (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        backendState = data.state;
        let displayText = '未連線';
        
        if (data.state === 'active') displayText = '連線正常';
        else if (data.state === 'connecting') displayText = '連線中...';
        else if (data.state === 'timeout') displayText = '連線逾時';

        uiManager.updateStatus(data.state, displayText, data.message || '');
        
        if (data.state === 'active' && lastGpsData) {
            uiManager.updateRealtimeData(lastGpsData, true);
        } else {
            uiManager.updateRealtimeData({}, false);
        }
    });

    // --- 監聽最新位置 ---
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

    // --- 監聽歷史路徑 ---
    onChildAdded(ref(db, `${Config.dbPath}/history`), (snapshot) => {
        const data = snapshot.val();
        if (data) {
            mapManager.addHistoryPoint(data, uiManager.getColor.bind(uiManager));
        }
    });
}

main();