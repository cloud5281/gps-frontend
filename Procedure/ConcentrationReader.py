import logging
import threading
import time
import random

from datetime import datetime

logger = logging.getLogger(__name__)

class ConcentrationReader:
    def __init__(self):
        self.unit = None 
        self.conc_queue = None
        self.running = False

    def _cleanup(self):
        """明確釋放所有連線資源"""
        try:
            self.file_obj.close()
        except Exception as e: 
            logger.debug(f"Conc 關閉檔案物件時發生錯誤: {e}")
        finally:
            self.file_obj = None
            
        try:
            self.socket.close()
        except Exception as e: 
            logger.debug(f"Conc 關閉 Socket 時發生錯誤: {e}")
        finally:
            self.socket = None
        logger.info("🔌 Conc 連線中斷，資源已釋放。")

    def stop(self):
        self.running = False
        self._cleanup()

    def _producer(self):
        """讀取濃度數據"""
        
        while self.running:
            try:
                # 模擬讀取濃度 (這裡請換成你真實的 socket/serial 讀取邏輯)
                # real_val = self.read_from_sensor()
                fake_val = round(random.uniform(50, 150), 2)
                # logger.info(f"🧪 濃度讀取: {fake_val}")
                
                # 封裝資料
                conc_packet = {
                    "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "conc": fake_val,
                    "conc_unit": self.unit
                }
                
                # 塞入 Queue
                self.conc_queue.put(conc_packet)
                
                # 控制頻率 (盡量接近 1 秒 1 次，與 GPS 同步)
                time.sleep(1) 
                
            except Exception as e:
                logger.error(f"濃度讀取錯誤: {e}")
                time.sleep(1)

    def run(self):
        self.running = True
        threading.Thread(target=self._producer, daemon=True).start()
        logger.info(f"🚀 開始處理 Conc 數據...")