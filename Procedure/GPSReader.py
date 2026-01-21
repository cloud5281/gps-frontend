import socket
import logging
import pynmea2
import threading
import queue
import time

from datetime import datetime

logger = logging.getLogger(__name__)

class GPSReader:
    def __init__(self):
        # 給定
        self.ip = None
        self.port = None
        self.gps_queue = None
        # 內部
        self.timeout_limit = 10 

        self.socket = None   
        self.file_obj = None 
        self.latest_data = {
            "timestamp": "", 
            "lat": 0.0, 
            "lon": 0.0, 
            "alt": '?', 
            "status": "V"
        }     # 緩存最新資料
        self.last_yield_time = None
        self.running = False

    def _cleanup(self):
        """明確釋放所有連線資源"""
        try:
            self.file_obj.close()
        except Exception as e: 
            logger.debug(f"GPS 關閉檔案物件時發生錯誤: {e}")
        finally:
            self.file_obj = None
            
        try:
            self.socket.close()
        except Exception as e: 
            logger.debug(f"GPS 關閉 Socket 時發生錯誤: {e}")
        finally:
            self.socket = None
        logger.info("🔌 GPS 連線中斷，資源已釋放。")

    def _producer(self):
        """
        背景執行緒：
        - 每 5 秒嘗試重連一次
        - 若累積 30 秒連不上則自動終止
        持續讀取資料塞入 Queue
        """
        first_failure_time = None  # 紀錄第一次失敗的時間點

        while self.running:
            try:
                logger.info(f"📡 嘗試連線至 {self.ip}: {self.port}")
                self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                self.socket.settimeout(5)
                self.socket.connect((self.ip, self.port))
                # --- 連線成功 ---
                logger.info(f"✅ GPS 連線成功！")

                first_failure_time = None  # 重置失敗時間
                self.file_obj = self.socket.makefile('r', encoding='utf-8', errors='ignore')
                for line in self.file_obj:
                    if not self.running: break
                    self._parse_and_push(line.strip())
                
                self._cleanup()
            
            # --- 連線失敗 ---
            except (socket.timeout, socket.error, ConnectionRefusedError):
                if not self.running: break
                current_time = time.time()
                # 如果是連續失敗的第一筆，紀錄開始時間
                if first_failure_time is None:
                    first_failure_time = current_time

                elapsed = current_time - first_failure_time       
                if elapsed >= self.timeout_limit:
                    logger.error(f"❌ 已超過 {self.timeout_limit} 秒無法連線，停止嘗試。")
                    self.running = False # 關閉主迴圈標記
                    break
                else:
                    logger.warning(f"⚠️ GPS 連線失敗，5 秒後重試...")
                    self._cleanup()
                    time.sleep(5)       # 等待 5 秒後再嘗試

        if self.running:
            logger.error("🏁 逾時連線，GPS 追蹤執行緒已停止。")
        self.gps_queue.put(None)

    def _parse_and_push(self, line):
        """解析 NMEA 並確保一秒一筆放入 Queue"""
        try:
            msg = pynmea2.parse(line)
            if isinstance(msg, pynmea2.types.talker.RMC):
                self.latest_data.update({
                    "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "lat": msg.latitude, 
                    "lon": msg.longitude, 
                    "status": msg.status        # A=active, V=void
                })
            elif isinstance(msg, pynmea2.types.talker.GGA):     # 高度資訊 (GPS2IP Lite 目前沒有輸出 GGA)
                self.latest_data["alt"] = msg.altitude

            # 檢查秒數是否改變，決定是否塞入 Queue
            curr_t = self.latest_data["timestamp"]
            if self.latest_data["status"] == "A" and curr_t != self.last_yield_time:
                self.last_yield_time = curr_t
                self.gps_queue.put(self.latest_data.copy())
        except:
            pass

    def run(self):
        self.running = True
        # 啟動背景執行緒 (daemon=True 確保主程式關閉時執行緒也結束)
        logger.info(f"🚀 開始處理 GPS 數據...")
        threading.Thread(target=self._producer, daemon=True).start()