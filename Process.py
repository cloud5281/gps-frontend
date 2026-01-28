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
        """
        以 GPS 為主觸發，直接取用當前最新的濃度值。
        """
        # --- 1. 建立濃度緩存 (Cache) ---
        # 預設值，避免程式剛啟動還沒收到濃度時會報錯
        latest_conc_cache = {
            'val': 0.0,
            'unit': self.conc.unit if hasattr(self.conc, 'unit') else '',
            'last_update': 0
        }
        
        SENSOR_TIMEOUT_SEC = 3.0

        while self.running:
            try:
                # --- A. 更新濃度緩存 (非阻塞) ---
                # 使用 while 迴圈把 Queue 裡累積的資料全部讀出來，只保留最後一筆(最新的)
                has_new_conc = False
                while not self.conc.conc_queue.empty():
                    try:
                        c_data = self.conc.conc_queue.get_nowait()
                        latest_conc_cache['val'] = c_data['conc']
                        # 如果 sensor 數據本身有帶單位就更新，沒有就維持設定檔的
                        if 'unit' in c_data: 
                            latest_conc_cache['unit'] = c_data['unit']
                        latest_conc_cache['last_update'] = time.time()
                        has_new_conc = True
                    except queue.Empty:
                        break
                
                # if has_new_conc:
                #     logger.debug(f"濃度更新: {latest_conc_cache['val']}")

                # --- B. 處理 GPS (主要觸發點) ---
                # 設定 timeout=0.1 讓迴圈可以持續運轉去檢查濃度和停止訊號
                try:
                    gps_data = self.gps.gps_queue.get(timeout=0.1)
                    
                    # 檢查是否為結束訊號
                    if gps_data is None:
                        if self.running:
                            self.fb.data_queue.put(None)
                        break

                    # --- C. 合併數據 ---
                    # 直接將緩存中的濃度填入 GPS 資料
                    gps_data['conc'] = latest_conc_cache['val']
                    gps_data['conc_unit'] = latest_conc_cache['unit']
                    
                    time_diff = time.time() - latest_conc_cache['last_update']
                    if latest_conc_cache['last_update'] > 0 and time_diff > SENSOR_TIMEOUT_SEC:
                        # 覆蓋 GPS 的狀態 (原本可能是 'A')，標記為濃度超時
                        gps_data['status'] = 'Sensor Timeout'
                    else:
                        pass

                    # --- D. 送出資料 ---
                    self.fb.data_queue.put(gps_data)

                except queue.Empty:
                    # GPS 沒資料是正常的 (頻率通常較慢)，繼續下一輪迴圈去收濃度
                    pass

            except Exception as e:
                logger.error(f"合併程序錯誤: {e}")
                time.sleep(1) # 出錯時暫停一下，避免 CPU 飆高

        # 確保結束時發送停止訊號
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