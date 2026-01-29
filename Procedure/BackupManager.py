import csv
import os
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

class BackupManager:
    def __init__(self, project_name):
        self.project_name = project_name
        self.backup_dir = "backups"
        self.file = None
        self.writer = None
        # 定義 CSV 欄位順序
        self.fieldnames = ['timestamp', 'lat', 'lon', 'alt', 'conc', 'conc_unit', 'status']

    def start(self):
        """初始化並開啟備份檔案"""
        try:
            # 1. 確保資料夾存在
            if not os.path.exists(self.backup_dir):
                os.makedirs(self.backup_dir)
            
            # 2. 產生檔名 (專案名_日期_時間.csv)
            now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"{self.backup_dir}/{self.project_name}_{now_str}.csv"
            
            # 3. 開啟檔案 (utf-8-sig 讓 Excel 開啟不亂碼)
            self.file = open(filename, mode='w', newline='', encoding='utf-8-sig')
            
            # 4. 初始化寫入器 (extrasaction='ignore' 會自動忽略不在 fieldnames 裡的雜訊欄位)
            self.writer = csv.DictWriter(self.file, fieldnames=self.fieldnames, extrasaction='ignore')
            self.writer.writeheader()
            self.file.flush() # 強制寫入硬碟
            
            logger.info(f"💾 本地備份已啟動: {filename}")
            
        except Exception as e:
            logger.error(f"❌ 無法建立備份檔案: {e}")

    def write(self, data):
        """寫入一筆資料並立即存檔"""
        if self.file and self.writer and data:
            try:
                self.writer.writerow(data)
                self.file.flush() # 🔥 關鍵：每寫一筆就存檔，防當機資料遺失
            except Exception as e:
                logger.error(f"⚠️ 寫入備份失敗: {e}")

    def stop(self):
        """關閉檔案"""
        if self.file:
            try:
                self.file.close()
                logger.info("💾 備份檔案已存檔關閉。")
            except Exception as e:
                logger.error(f"❌ 關閉備份檔案錯誤: {e}")
            finally:
                self.file = None
                self.writer = None