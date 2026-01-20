import firebase_admin
import logging
import queue
import time
import webbrowser

from firebase_admin import credentials, db
from geopy.distance import geodesic

logger = logging.getLogger(__name__)

class FirebaseManager:
    def __init__(self):
        # 給定
        self.key_path = None
        self.db_url = None
        self.db_id = None
        self.api_key = None
        self.project_name = None
        self.data_queue = None
        self.map_url = None
        # 狀態
        self.last_saved_coord = None
        self.running = True
        self.current_gps_state = False

    def _initialize_firebase(self):
        try:
            if not firebase_admin._apps:  
                cred = credentials.Certificate(self.key_path)
                firebase_admin.initialize_app(cred, {'databaseURL': self.db_url}) 
                logger.info("🔥 Firebase 同步管理已就緒。")
                if self.map_url:
                    webbrowser.open(f'{self.map_url}?id={self.db_id}&key={self.api_key}&path={self.project_name}')                             # 自動開啟地圖連結                                                           
        except Exception as e:
            logger.error(f"❌ Firebase 連線失敗: {e}")
            return
    
    def _update_status(self, ref_status, state, message=""):
        """
        輔助方法：更新連線狀態
        """
        try:
            ref_status.set({
                'state': state,                         # 狀態代碼: offline, timeout, connecting, active
                'message': message,                     # 狀態訊息
            })
        except Exception as e:
            logger.error(f"狀態更新失敗: {e}")

    def run(self):
        # 初始化 Firebase 連線，並開啟地圖
        self._initialize_firebase()  
        ref_latest = db.reference(f'{self.project_name}/latest')
        ref_history = db.reference(f'{self.project_name}/history')
        ref_status = db.reference(f'{self.project_name}/status')
        logger.info(f"🚀 Firebase 同步服務開始運行...")
        
        last_data_receive_time = 0
        # 設定寬限期 (秒)：超過幾秒沒資料才切回黃燈
        grace_period = 2.0
        # 預設停止原因為正常關機
        exit_state = 'offline'
        exit_msg = '程式已停止運作'
        try:
            while True:
                try:
                    data = self.data_queue.get(timeout=1)
                    
                    # 1. 判斷是否更新最新資料
                    if data:
                        # 正常運作中
                        last_data_receive_time = time.time()
                        ref_latest.set(data)
                        ref_status.update({
                            'state': 'active',
                            'message': '正在接收 GPS 數據...'
                        })
                    if data is None: 
                        exit_state = 'timeout'
                        exit_msg = '程式已停止運作 (GPS連線中斷)'
                        break

                    ref_history.push(data)
                    logger.info(f"緯度: {data['lat']:.6f}, 經度: {data['lon']:.6f}, 高度: {data['alt']} m, 濃度: {data['conc']} {data['conc_unit']} (狀態: {'Active' if data['status']=='A' else 'Void'})")
                except queue.Empty:
                    # Queue 空的但還沒結束，繼續回報 connecting
                    time_diff = time.time() - last_data_receive_time
                    if time_diff < grace_period:
                        exit_state = 'active'
                        exit_msg = '正在接收 GPS 數據'    
                    else:     
                        ref_status.update({
                            'state': 'connecting', 
                            'message': '等待 GPS 訊號...'
                     })
                    continue
        except KeyboardInterrupt:
            # ✨ 如果是手動按 Ctrl+C，這裡會被捕捉
            exit_state = 'offline'
            exit_msg = '程式已停止運作 (手動終止)'
            logger.info("👋 偵測到中斷指令...")
            raise
        except Exception as e:
            exit_state = 'error'
            exit_msg = f'程式錯誤: {str(e)}'
            logger.error(f"❌ 錯誤: {e}")
        finally:
            # ✨ 這裡會根據上面的邏輯，寫入正確的停止原因
            # 如果是 timeout，這裡就會寫入 state: 'timeout'
            self._update_status(ref_status, exit_state, exit_msg)
            logger.info(f"🏁 服務停止，原因: {exit_state}")