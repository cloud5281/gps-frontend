import logging
import threading
import time
import firebase_admin
import webbrowser
import json
import sys

from firebase_admin import credentials, db
from Config import Config
from Process import RunProcess

class SystemController:
    def __init__(self, config_file="config.json"):
        self.config_file = config_file
        self.logger = self._setup_logger()
        self.process = None
        self.process_thread = None
        
        self.cmd_listener = None
        self.config_listener = None

        try:
            self.cfg = Config(self.config_file)
        except Exception as e:
            self.logger.error(f"❌ 設定檔讀取失敗: {e}")
            raise

        self._init_firebase()

    def _setup_logger(self):
        log_filename = "execution.log" 
        handlers = [
            logging.StreamHandler(),
            logging.FileHandler(log_filename, encoding='utf-8', mode='w') 
        ]
        logging.basicConfig(
            level=logging.INFO,
            format='[%(asctime)s] %(message)s',
            datefmt='%y/%m/%d %H:%M:%S',
            handlers=handlers,
            force=True  
        )
        return logging.getLogger("Controller")

    def _init_firebase(self):
        try:
            if not firebase_admin._apps:
                cred = credentials.Certificate(self.cfg.FIREBASE_KEY)
                firebase_admin.initialize_app(cred, {'databaseURL': self.cfg.DB_URL})
            self.logger.info("📡 Controller 已連線至 Firebase")
        except Exception as e:
            self.logger.error(f"❌ Firebase 連線失敗: {e}")

    def _push_current_config_to_firebase(self):
        """將目前參數推送到雲端，供前端讀取"""
        try:
            data = {
                "db_id": self.cfg.DB_ID,
                "project_name": self.cfg.PROJECT_NAME,
                "gps_ip": self.cfg.GPS_IP,
                "gps_port": self.cfg.GPS_PORT,
                "conc_unit": self.cfg.CONC_UNIT
            }
            db.reference(f'{self.cfg.PROJECT_NAME}/settings/current_config').set(data)
            self.logger.info(f"📤 已同步設定至專案: {self.cfg.PROJECT_NAME}")
        except Exception as e:
            self.logger.warning(f"同步參數失敗: {e}")

    def _setup_listeners(self):
        self._cleanup_listeners()
        self.logger.info(f"👂 開始監聽專案路徑: {self.cfg.PROJECT_NAME}")

        # 監聽指令
        cmd_ref = db.reference(f'{self.cfg.PROJECT_NAME}/control/command')
        cmd_ref.set("") 
        self.cmd_listener = cmd_ref.listen(self._command_handler)

        # 監聽參數修改
        config_ref = db.reference(f'{self.cfg.PROJECT_NAME}/control/config_update')
        config_ref.delete()
        self.config_listener = config_ref.listen(self._handle_config_update)

    def _cleanup_listeners(self):
        try:
            if self.cmd_listener:
                self.cmd_listener.close()
                self.cmd_listener = None
            if self.config_listener:
                self.config_listener.close()
                self.config_listener = None
        except Exception as e:
            self.logger.warning(f"關閉監聽器時發生錯誤 (可忽略): {e}")

    def _handle_config_update(self, event):
        if event.data is None or event.data == "": return
        new_settings = event.data
        self.logger.info(f"⚙️ 收到參數更新請求: {new_settings}")
        
        # 開新執行緒處理切換，避免卡死
        threading.Thread(target=self._perform_project_switch, args=(new_settings,)).start()

    def _perform_project_switch(self, new_settings):
        old_project_name = self.cfg.PROJECT_NAME
        new_project_name = new_settings.get('project_name', old_project_name)

        try:
            if old_project_name != new_project_name:
                self.logger.info(f"👋 正在將舊專案 ({old_project_name}) 標記為離線...")
                db.reference(f'{old_project_name}/status').set({
                    'state': 'offline',
                    'message': f'後端已切換至: {new_project_name}'
                })

            with open(self.config_file, 'r', encoding='utf-8') as f:
                config_data = json.load(f)

            if 'project_name' in new_settings:
                config_data['settings']['project_name'] = new_settings['project_name']
            if 'gps_ip' in new_settings:
                config_data['gps']['ip'] = new_settings['gps_ip']
            if 'gps_port' in new_settings:
                config_data['gps']['port'] = int(new_settings['gps_port'])
            if 'conc_unit' in new_settings:
                config_data['conc']['unit'] = new_settings['conc_unit']

            with open(self.config_file, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2, ensure_ascii=False)
            
            self.logger.info("✅ config.json 已更新")
            db.reference(f'{old_project_name}/control/config_update').delete()

            self.cfg = Config(self.config_file)

            if old_project_name != new_project_name:
                self.logger.info(f"🔄 專案變更，重啟監聽...")
                if self.process and self.process.running:
                    self.stop_process()
                db.reference(f'{new_project_name}/status').set({
                    'state': 'stopped',
                    'message': '後端已就緒 (等待指令)'
                })
                self._setup_listeners()
            
            self._push_current_config_to_firebase()

        except Exception as e:
            self.logger.error(f"❌ 更新設定檔失敗: {e}")

    def _command_handler(self, event):
        if event.data is None or event.data == "": return
        command = str(event.data).lower()
        
        # ⚠️ 清空指令，確保下次點擊有效
        if command in ['start', 'stop']:
            try:
                db.reference(f'{self.cfg.PROJECT_NAME}/control/command').set("")
            except: pass

        if command == "start":
            self.logger.info(f"📩 收到指令: {command}")
            self.start_process()
        elif command == "stop":
            self.logger.info(f"📩 收到指令: {command}")
            self.stop_process()

    def start_process(self):
        # 這裡會因為 Process.py 的修正，正確判斷是否正在執行
        if self.process is not None and self.process.running:
            return 
        
        try:
            current_cfg = Config(self.config_file)
            self.process = RunProcess(current_cfg)
            self.process_thread = threading.Thread(target=self.process.run)
            self.process_thread.start()

            # ⚠️ 修正：統一寫入到根目錄 status
            db.reference(f'{self.cfg.PROJECT_NAME}/status').update({
                'state': 'active',
                'message': '系統啟動中...'
            })
            
        except Exception as e:
            self.logger.error(f"❌ 啟動失敗: {e}")
            db.reference(f'{self.cfg.PROJECT_NAME}/status').update({
                'state': 'error',
                'message': f'啟動失敗: {str(e)}'
            })

    def stop_process(self):
        if self.process is None or not self.process.running:
            return

        self.logger.info("🛑 正在停止後端程序...")
        self.process.stop()
        if self.process_thread:
            self.process_thread.join()
        
        self.process = None
        
        # ⚠️ 修正：統一寫入到根目錄 status
        db.reference(f'{self.cfg.PROJECT_NAME}/status').update({
            'state': 'stopped',
            'message': '使用者手動停止'
        })
        self.logger.info("✅ 後端程序已停止")

    def run(self):
        url = (f"{self.cfg.MAP_URL}?"
               f"id={self.cfg.DB_ID}&"
               f"path={self.cfg.PROJECT_NAME}&"
               f"key={self.cfg.API_KEY}")
        
        webbrowser.open(url)
        
        # ⚠️ 修正：程式啟動時，強制重置狀態為 stopped (防殭屍狀態)
        self.logger.info("🧹 初始化狀態為 Stopped...")
        db.reference(f'{self.cfg.PROJECT_NAME}/status').set({
            'state': 'stopped',
            'message': '後端程式已就緒 (等待指令)'
        })

        self._push_current_config_to_firebase()
        self._setup_listeners()
        
        self.logger.info("🟢 後端程式運作中 (按 Ctrl+C 結束)")
        
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            self.logger.info("👋 正在關閉系統...")
            self._cleanup_listeners()
            if self.process and self.process.running:
                self.stop_process()
            
            # 確保最後狀態是 offline
            db.reference(f'{self.cfg.PROJECT_NAME}/status').update({
                'state': 'offline',
                'message': '後端程式已關閉'
            })
            sys.exit(0)

if __name__ == "__main__":
    ctrl = SystemController()
    ctrl.run()