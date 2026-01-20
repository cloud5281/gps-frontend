import logging
import threading
import time
import firebase_admin
import webbrowser
import json

from firebase_admin import credentials, db
from Config import Config
from Process import RunProcess

class SystemController:
    def __init__(self, config_file="config.json"):
        self.config_file = config_file
        self.logger = self._setup_logger()
        self.process = None
        self.process_thread = None
        # 先讀取設定檔以獲取 Firebase 資訊
        try:
            self.cfg = Config(self.config_file)
        except Exception as e:
            self.logger.error(f"❌ 設定檔讀取失敗: {e}")
            raise

        # 初始化 Firebase (用於監聽指令)
        self._init_firebase_listener()

    def _setup_logger(self):
        """設定日誌系統：同時輸出到螢幕與檔案"""
        log_filename = "execution.log" 

        # 設定 Handlers
        handlers = [
            logging.StreamHandler(),  # 輸出到控制台
            logging.FileHandler(log_filename, encoding='utf-8', mode='w') 
        ]

        # 套用設定
        logging.basicConfig(
            level=logging.INFO,
            format='[%(asctime)s] %(message)s',
            datefmt='%y/%m/%d %H:%M:%S',
            handlers=handlers,
            force=True  
        )
        
        return logging.getLogger("Controller")

    def _init_firebase_listener(self):
        """初始化 Firebase 連線並準備監聽"""
        try:
            if not firebase_admin._apps:
                cred = credentials.Certificate(self.cfg.FIREBASE_KEY)
                firebase_admin.initialize_app(cred, {'databaseURL': self.cfg.DB_URL})
            self.logger.info("📡 Controller 已連線至 Firebase，等待前端指令...")
        except Exception as e:
            self.logger.error(f"❌ Firebase 連線失敗: {e}")

    def _push_current_config_to_firebase(self):
        try:
            data = {
                "project_id": self.cfg.PROJECT_NAME,
                "gps_ip": self.cfg.GPS_IP,
                "gps_port": self.cfg.GPS_PORT,
                "conc_unit": self.cfg.CONC_UNIT
            }
            # 寫入到 settings/current_config 節點
            db.reference(f'{self.cfg.PROJECT_NAME}/settings/current_config').set(data)
            # self.logger.info("📤 已將目前參數同步至 Firebase，前端可自動讀取")
        except Exception as e:
            self.logger.warning(f"同步參數失敗: {e}")

    def _handle_config_update(self, event):
        if event.data is None or event.data == "": return
        
        new_settings = event.data
        self.logger.info(f"⚙️ 收到參數更新請求: {new_settings}")
        
        try:
            # 1. 讀取原始 json 檔 (保持其他欄位不變)
            with open(self.config_file, 'r', encoding='utf-8') as f:
                config_data = json.load(f)

            # 2. 更新數值
            if 'project_id' in new_settings:
                config_data['settings']['project_name'] = new_settings['project_id']
            if 'gps_ip' in new_settings:
                config_data['gps']['ip'] = new_settings['gps_ip']
            if 'gps_port' in new_settings:
                config_data['gps']['port'] = int(new_settings['gps_port'])
            if 'conc_unit' in new_settings:
                config_data['conc']['unit'] = new_settings['conc_unit']

            # 3. 寫回 config.json
            with open(self.config_file, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2, ensure_ascii=False)
            
            self.logger.info("✅ config.json 已更新！")

            # 4. 如果專案名稱改了，必須重啟程式才能監聽新頻道
            # 這裡我們先做簡單處理：更新記憶體內的 cfg
            self.cfg = Config(self.config_file) 
            db.reference(f'{self.cfg.PROJECT_NAME}/control/config_update').delete()
            # 再推一次新的設定上去確認
            self._push_current_config_to_firebase()

        except Exception as e:
            self.logger.error(f"❌ 更新設定檔失敗: {e}")

    def _command_handler(self, event):
        """當 Firebase 上的 'control/command' 數值改變時，會觸發此函式"""
        if event.data is None or event.data == "": return
        
        command = str(event.data).lower()
        if not command: return      # 再次確認有沒有指令 (防呆)
        self.logger.info(f"📩 收到前端指令: {command}")

        if command == "start":
            self.start_process()
        elif command == "stop":
            self.stop_process()
        else:
            self.logger.warning(f"⚠️ 未知指令: {command}")
    
    def start_process(self):
        """讀取 Config 並啟動 Process"""
        if self.process is not None and self.process.running:
            self.logger.warning("程式已經在執行中！")
            return
        # self.logger.info("啟動系統...")
    
        # 讀取最新設定 (每次 Start 都重新讀取，方便參數更新)
        try:
            current_cfg = Config(self.config_file)
            self.process = RunProcess(current_cfg)
            self.process_thread = threading.Thread(target=self.process.run)
            self.process_thread.start()
            # 回報狀態給 Firebase (讓前端知道後端真的動了)
            db.reference(f'{self.cfg.PROJECT_NAME}/control/status').set('running')
            
        except Exception as e:
            self.logger.error(f"❌ 啟動失敗: {e}")

    def stop_process(self):
        """停止 Process"""
        if self.process is None or not self.process.running:
            self.logger.warning("系統尚未執行")
            return

        self.logger.info("正在停止系統...")
        self.process.stop()
        if self.process_thread:
            self.process_thread.join()
        
        self.process = None
        # 回報狀態
        db.reference(f'{self.cfg.PROJECT_NAME}/control/status').set('stopped')
        self.logger.info("系統已完全停止")
        self.logger.info("---程式結束---")
        logging.shutdown()

    def run(self):
        """主程式進入無窮迴圈，持續監聽 Firebase"""
        webbrowser.open(f'{self.cfg.MAP_URL}?id={self.cfg.DB_ID}&key={self.cfg.API_KEY}&path={self.cfg.PROJECT_NAME}')
        cmd_ref = db.reference(f'{self.cfg.PROJECT_NAME}/control/command')
        
        # 第一次啟動先歸零指令，避免上次殘留的 start 導致意外啟動
        cmd_ref.set("") 
        
        # 開始監聽 (listen 是非阻塞的，所以下面需要一個 while loop 讓程式不結束)
        cmd_listener = cmd_ref.listen(self._command_handler)

        config_ref = db.reference(f'{self.cfg.PROJECT_NAME}/control/config_update')
        config_ref.delete() # 清空舊請求
        config_listener = config_ref.listen(self._handle_config_update)
        
        self.logger.info("🟢 後端程式已開始運作")
        self.logger.info("按 Ctrl+C 可關閉後端程式。")
        
        try:
            while True:
                time.sleep(1) 
        except KeyboardInterrupt:
            self.logger.info("👋 正在關閉後端程式...")
            if self.process and self.process.running:
                self.stop_process()
            cmd_listener.close()
            config_listener.close()

if __name__ == "__main__":
    ctrl = SystemController()
    ctrl.run()