import logging
import threading
import queue
import time

from Config import Config
from Procedure.GPSReader import GPSReader
from Procedure.ConcentrationReader import ConcentrationReader
from Procedure.FirebaseManager import FirebaseManager

logger = logging.getLogger(__name__)

class RunProcess:
    def __init__(self):
        # 核心模組初始化
        self.gps = GPSReader()
        self.conc = ConcentrationReader()
        self.fb = FirebaseManager()

        # 給定
        self.running = False

    def _queue_merger(self):
        """
        負責將 GPS 與 Conc 依照 timestamp 進行對齊 (微調版：加入等待機制)
        """
        # --- 1. 新增：GPS 緩衝區 (用來放正在等待濃度的 GPS) ---
        gps_buffer = [] 
        
        # 濃度暫存區
        conc_buffer = []
        
        # --- 2. 新增：單位變數 (用來記住最新的單位) ---
        current_unit = "ppb" # 預設值，之後會從 queue 更新
        last_valid_conc = 0.0 
        
        # 設定最大等待秒數
        MAX_WAIT_SECONDS = 3.0
        
        while self.running:
            try:
                # ==========================================
                # 步驟 A: 接收資料
                # ==========================================
                
                # 1. 拿取 GPS 資料
                # 修改點：Timeout 改短一點 (例如 0.2秒)，讓迴圈能持續跑動去檢查 buffer 裡是否有人超時
                try:
                    gps_data = self.gps.gps_queue.get(timeout=0.2)
                    if gps_data is None:
                        self.running = False
                        self.fb.data_queue.put(None)
                        break
                    # 幫 GPS 貼上「收到的時間」標籤，這樣才知道它等了多久
                    gps_data['_arrival_time'] = time.time()
                    gps_buffer.append(gps_data) # 先放進緩衝區，不急著處理
                except queue.Empty:
                    pass # 沒新 GPS 沒關係，繼續往下跑去檢查舊的有沒有對齊
                
                # 2. 從濃度 Queue 更新資料
                while not self.conc.conc_queue.empty():
                    try:
                        conc_data = self.conc.conc_queue.get_nowait()
                        conc_buffer.append(conc_data)
                        
                        # --- 修改點：只要讀到資料，就更新當下的單位 ---
                        # 這樣不管之後是否對齊，補值時都有單位可用
                        if 'conc_unit' in conc_data:
                            current_unit = conc_data['conc_unit']
                            
                    except queue.Empty:
                        break

                # ==========================================
                # 步驟 B: 檢查緩衝區 (核心邏輯)
                # ==========================================
                
                # 我們改為對 gps_buffer 跑迴圈 (使用 [:] 複製一份以免刪除時出錯)
                for gps_point in gps_buffer[:]:
                    
                    target_time = gps_point['timestamp']
                    is_matched = False
                    match_index = -1
                    
                    # 3. 在濃度暫存區尋找 (維持你原本的邏輯)
                    for i, c_data in enumerate(conc_buffer):
                        if c_data['timestamp'] == target_time:
                            match_index = i
                            
                            # ✅ 配對成功
                            gps_point['conc'] = c_data['conc']
                            gps_point['conc_unit'] = current_unit # 直接使用我們記下來的單位
                            
                            last_valid_conc = c_data['conc'] # 更新補值用的最後數據
                            is_matched = True
                            
                            # 清理：把這個配對點(含)之前的舊濃度都丟掉
                            conc_buffer = conc_buffer[match_index+1:]
                            break
                        
                        elif c_data['timestamp'] > target_time:
                            # 濃度資料已經比 GPS 新了，代表這筆 GPS 沒救了 (錯過了)
                            break
                    
                    # 4. 決定這筆 GPS 的命運
                    if is_matched:
                        # 情況一：配對成功 -> 送出
                        if '_arrival_time' in gps_point: del gps_point['_arrival_time'] # 移除內部用的標籤
                        self.fb.data_queue.put(gps_point)
                        gps_buffer.remove(gps_point)
                        
                    else:
                        # 情況二：還沒配對到，檢查等多久了？
                        waited_time = time.time() - gps_point['_arrival_time']
                        
                        if waited_time > MAX_WAIT_SECONDS:
                            # ⚠️ 超時了 (等超過3秒) -> 執行補值
                            gps_point['conc'] = last_valid_conc
                            gps_point['conc_unit'] = current_unit # 使用記下來的單位
                            gps_point['status'] = 'Filled(Timeout)'
                            
                            if '_arrival_time' in gps_point: del gps_point['_arrival_time']
                            self.fb.data_queue.put(gps_point)
                            gps_buffer.remove(gps_point)
                            
                        else:
                            # 情況三：還沒超時 -> 什麼都不做
                            # 讓它繼續留在 gps_buffer 裡，等下一圈迴圈再試一次
                            pass
                
                # 防止濃度 buffer 無限膨脹 (維持你的原本邏輯)
                if len(conc_buffer) > 20:
                    conc_buffer.pop(0)

            except Exception as e:
                logger.error(f"合併錯誤: {e}")
                pass
   
    def run(self, is_push=True):
        self.running = True
        logger.info("---程式開始---")
        self.gps.run()      # 背景開始抓資料
        self.conc.run()

        threading.Thread(target=self._queue_merger, daemon=True).start()

        if is_push:
            try:
                self.fb.run()         
            except KeyboardInterrupt:
                logger.info("🏁 使用者終止程式。")
            finally:
                self.gps.running = False
                self.gps._cleanup()
                self.conc.running = False
                self.conc._cleanup()
                logger.info("---程式結束---")
                logging.shutdown()

def setup_logger(log_file):
    """封裝日誌設定"""
    log_fmt = logging.Formatter('[%(asctime)s] %(message)s', datefmt='%y/%m/%d %H:%M:%S')
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    if root_logger.hasHandlers():
        root_logger.handlers.clear()
    
    # 控制台輸出
    sh = logging.StreamHandler()
    sh.setFormatter(log_fmt)
    root_logger.addHandler(sh)
    
    # 檔案輸出
    if log_file:
        fh = logging.FileHandler(log_file, mode='w', encoding="utf-8")
        fh.setFormatter(log_fmt)
        root_logger.addHandler(fh)
    return root_logger

"""參數檔案名稱"""
config_name = "config.json"

"""模組初始化"""
cfg = Config(config_name=config_name)       
setup_logger(log_file=cfg.LOG_FILE)
Process = RunProcess()

"""運行參數 (在前面給定的參數檔案內修改)"""     
# GPSReader 參數設定
Process.gps.ip = cfg.GPS_IP
Process.gps.port = cfg.GPS_PORT  
Process.gps.gps_queue = cfg.GPS_QUEUE
# ConcentrationReader 參數設定
Process.conc.unit = cfg.CONC_UNIT
Process.conc.conc_queue = cfg.CONC_QUEUE 
# FirebaseManager 參數設定
Process.fb.key_path = cfg.FIREBASE_KEY 
Process.fb.db_url = cfg.DB_URL
Process.fb.db_id = cfg.DB_ID
Process.fb.api_key = cfg.API_KEY  
Process.fb.project_name = cfg.PROJECT_NAME
Process.fb.data_queue = cfg.SHARED_QUEUE 
Process.fb.map_url = cfg.MAP_URL

"""執行"""
Process.run()