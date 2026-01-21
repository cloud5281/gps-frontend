import logging
import threading
import queue
import time

from Procedure.GPSReader import GPSReader
from Procedure.ConcentrationReader import ConcentrationReader
from Procedure.FirebaseManager import FirebaseManager

logger = logging.getLogger(__name__)

class RunProcess:
    def __init__(self, cfg):
        self.cfg = cfg
        self.running = False

        # 核心模組初始化
        self.gps = GPSReader()
        self.conc = ConcentrationReader()
        self.fb = FirebaseManager(
            key_path=self.cfg.FIREBASE_KEY, 
            db_url=self.cfg.DB_URL
        )

        """運行參數 (在前面給定的參數檔案內修改)"""     
        # GPSReader 參數設定
        self.gps.ip = self.cfg.GPS_IP
        self.gps.port = self.cfg.GPS_PORT  
        self.gps.gps_queue = self.cfg.GPS_QUEUE

        # ConcentrationReader 參數設定
        self.conc.unit = self.cfg.CONC_UNIT
        self.conc.conc_queue = self.cfg.CONC_QUEUE 

        # FirebaseManager 參數設定
        self.fb.project_name = self.cfg.PROJECT_NAME
        self.fb.data_queue = self.cfg.SHARED_QUEUE 

    def _queue_merger(self):
        """負責將 GPS 與 Conc 依照 timestamp 進行對齊"""
        # --- 1. 緩衝區 (用來放正在等待濃度的 GPS) ---
        gps_buffer = [] 
        conc_buffer = []
        last_valid_conc = 0.0 
        MAX_WAIT_SECONDS = 3.0  # 設定最大等待秒數
        
        while self.running:
            try:
                # A. 接收 GPS (timeout 短一點以便檢查 running 狀態)
                try:
                    gps_data = self.gps.gps_queue.get(timeout=0.2)
                    if gps_data is None:
                        if self.running:
                            self.fb.data_queue.put(None)
                        break
                    gps_data['_arrival_time'] = time.time()
                    gps_buffer.append(gps_data) # 先放進緩衝區，不急著處理
                except queue.Empty:
                    pass # 沒新 GPS 沒關係，繼續往下跑去檢查舊的有沒有對齊
                
                # B. 從濃度 Queue 更新資料
                while not self.conc.conc_queue.empty():
                    try:
                        conc_data = self.conc.conc_queue.get_nowait()
                        conc_buffer.append(conc_data)                            
                    except queue.Empty:
                        break

                # C. 配對 (檢查緩衝區)
                # 我們改為對 gps_buffer 跑迴圈 
                for gps_point in gps_buffer[:]:
                    target_time = gps_point['timestamp']
                    is_matched = False
                    match_index = -1
                    
                    for i, c_data in enumerate(conc_buffer):
                        if c_data['timestamp'] == target_time:
                            match_index = i
                            # ✅ 配對成功
                            gps_point['conc'] = c_data['conc']
                            gps_point['conc_unit'] = self.conc.unit 
                            last_valid_conc = c_data['conc'] # 更新補值用的最後數據
                            is_matched = True
                            # 清理：把這個配對點(含)之前的舊濃度都丟掉
                            conc_buffer = conc_buffer[match_index+1:]
                            break
                        elif c_data['timestamp'] > target_time:
                            # 濃度資料已經比 GPS 新了，代表這筆 GPS 錯過了
                            break
                    
                    if is_matched:
                        # 情況一：配對成功 -> 送出
                        if '_arrival_time' in gps_point: del gps_point['_arrival_time'] # 移除內部用的標籤
                        self.fb.data_queue.put(gps_point)
                        gps_buffer.remove(gps_point)     
                    else:
                        # 情況二：檢查超時
                        waited_time = time.time() - gps_point['_arrival_time'] 
                        if waited_time > MAX_WAIT_SECONDS:
                            # ⚠️ 超時了 (等超過3秒) -> 執行補值
                            gps_point['conc'] = last_valid_conc
                            gps_point['conc_unit'] = self.conc.unit 
                            gps_point['status'] = 'Filled(Timeout)'      
                            if '_arrival_time' in gps_point: del gps_point['_arrival_time']
                            self.fb.data_queue.put(gps_point)
                            gps_buffer.remove(gps_point)
                        else:
                            # 情況三：還沒超時 -> 什麼都不做
                            pass
                
                # 清理過期濃度
                if len(conc_buffer) > 20:
                    conc_buffer.pop(0)

            except Exception as e:
                logger.error(f"合併錯誤: {e}")
                pass

        if self.running:
            self.fb.data_queue.put(None)

    def stop(self):
        """停止所有子程序"""
        self.running = False
        
        # 1. 停止 Reader
        self.gps.stop()
        self.conc.stop()    
        # 2. 停止 Firebase 
        self.fb.stop()
   
    def run(self):
        self.running = True
        logger.info("---程式開始---")

        # 1. 啟動 Reader
        self.gps.run()      
        self.conc.run()

        merger_thread = threading.Thread(target=self._queue_merger, daemon=True)
        merger_thread.start()

        try:
            self.fb.run() # 這裡會卡住直到停止訊號出現
        finally:
            self.stop()   
            self.running = False 