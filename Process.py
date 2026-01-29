import logging
import threading
import queue
import time

from datetime import datetime
from Procedure.GPSReader import GPSReader
from Procedure.ConcentrationReader import ConcentrationReader
from Procedure.FirebaseManager import FirebaseManager
from Procedure.BackupManager import BackupManager

logger = logging.getLogger(__name__)

class RunProcess:
    def __init__(self, cfg):
        self.cfg = cfg
        self.running = False

        self.gps = GPSReader()
        self.conc = ConcentrationReader()
        self.fb = FirebaseManager(
            key_path=self.cfg.FIREBASE_KEY, 
            db_url=self.cfg.DB_URL
        )
        self.backup = BackupManager(self.cfg.PROJECT_NAME)

        self.is_backup_started = False

        self.gps.ip = self.cfg.GPS_IP
        self.gps.port = self.cfg.GPS_PORT  
        self.gps.gps_queue = self.cfg.GPS_QUEUE

        self.conc.unit = self.cfg.CONC_UNIT
        self.conc.conc_queue = self.cfg.CONC_QUEUE 

        self.fb.project_name = self.cfg.PROJECT_NAME
        self.fb.data_queue = self.cfg.SHARED_QUEUE 

    def _ensure_backup_active(self):
        if not self.is_backup_started:
            try:
                self.backup.start()
                self.is_backup_started = True
            except Exception as e:
                logger.error(f"啟動備份失敗: {e}")

    def _queue_merger(self):
        latest_conc_cache = {
            'val': 0.0,
            'unit': self.conc.unit if hasattr(self.conc, 'unit') else '',
            'last_update': 0
        }
        
        SENSOR_TIMEOUT_SEC = 2.0
        
        last_gps_arrival_time = time.time()
        last_upload_time = time.time()
        GPS_GRACE_PERIOD = 2.0 

        # 🔥 新增：用來記錄上一筆資料的時間字串 (例如 "09:24:54")
        last_processed_ts = ""

        while self.running:
            try:
                # --- A. 更新濃度緩存 ---
                while not self.conc.conc_queue.empty():
                    try:
                        c_data = self.conc.conc_queue.get_nowait()
                        latest_conc_cache['val'] = c_data['conc']
                        if 'unit' in c_data: 
                            latest_conc_cache['unit'] = c_data['unit']
                        latest_conc_cache['last_update'] = time.time()
                    except queue.Empty:
                        break
                
                # --- B. 處理 GPS ---
                try:
                    gps_data = self.gps.gps_queue.get(timeout=0.1)
                    
                    if gps_data is None:
                        if self.running: self.fb.data_queue.put(None)
                        break

                    # 🔥🔥🔥 修正重點：過濾重複時間戳 🔥🔥🔥
                    # 如果這筆資料的時間跟上一筆一樣 (都是 "09:24:54")，就直接丟棄
                    current_ts = gps_data.get('timestamp', '')
                    if current_ts == last_processed_ts:
                        continue 
                    
                    # 更新紀錄，讓下一筆跟這筆比
                    last_processed_ts = current_ts

                    # === GPS 正常接收 ===
                    gps_data['conc'] = latest_conc_cache['val']
                    gps_data['conc_unit'] = latest_conc_cache['unit']
                    
                    time_diff = time.time() - latest_conc_cache['last_update']
                    if latest_conc_cache['last_update'] > 0 and time_diff > SENSOR_TIMEOUT_SEC:
                        gps_data['status'] = 'Sensor Timeout'
                        gps_data['conc'] = 0
                    
                    self.fb.data_queue.put(gps_data)
                    
                    self._ensure_backup_active()
                    self.backup.write(gps_data)
                    
                    # 更新系統計時器
                    current_time = time.time()
                    last_gps_arrival_time = current_time 
                    last_upload_time = current_time      

                except queue.Empty:
                    current_time = time.time()
                    
                    is_gps_really_lost = (current_time - last_gps_arrival_time > GPS_GRACE_PERIOD)
                    is_time_to_fill = (current_time - last_upload_time >= 1.0)

                    if is_gps_really_lost and is_time_to_fill:
                        # 產生現在時間字串
                        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        
                        # 🔥 即使是補位資料，也檢查一下是否跟上一筆重複 (極端情況)
                        if now_str == last_processed_ts:
                            continue

                        last_processed_ts = now_str # 更新紀錄

                        no_gps_data = {
                            "timestamp": now_str,
                            "lat": None,
                            "lon": None,
                            "alt": 0,
                            "status": "GPS Lost",
                            "conc": latest_conc_cache['val'],
                            "conc_unit": latest_conc_cache['unit']
                        }
                        
                        time_diff = current_time - latest_conc_cache['last_update']
                        if latest_conc_cache['last_update'] > 0 and time_diff > SENSOR_TIMEOUT_SEC:
                            no_gps_data['status'] = 'All Lost'

                        self.fb.data_queue.put(no_gps_data)
                        
                        self._ensure_backup_active()
                        self.backup.write(no_gps_data)
                        
                        last_upload_time = current_time

            except Exception as e:
                logger.error(f"合併程序錯誤: {e}")
                time.sleep(1)

        if self.running:
            self.fb.data_queue.put(None)

    def stop(self):
        self.running = False
        self.gps.stop()
        self.conc.stop()    
        self.fb.stop()
        if self.is_backup_started:
            self.backup.stop()
            self.is_backup_started = False
   
    def run(self):
        self.running = True
        logger.info("---程式開始---")

        self.gps.run()      
        self.conc.run()

        merger_thread = threading.Thread(target=self._queue_merger, daemon=True)
        merger_thread.start()

        try:
            self.fb.run()
        finally:
            self.stop()   
            self.running = False