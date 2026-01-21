import firebase_admin
import logging
import queue
import time

from firebase_admin import credentials, db
from geopy.distance import geodesic

logger = logging.getLogger(__name__)

class FirebaseManager:
    def __init__(self, key_path, db_url):
        # 給定
        self.key_path = key_path
        self.db_url = db_url
        self.project_name = None
        self.data_queue = None
        # 狀態
        self.running = False
        
        # 初始化 Firebase 連線
        self._initialize_firebase()  

    def _initialize_firebase(self):
        try:
            if not firebase_admin._apps:  
                cred = credentials.Certificate(self.key_path)
                firebase_admin.initialize_app(cred, {'databaseURL': self.db_url}) 
                logger.info("🔥 Firebase 初始化: 同步管理已就緒")
        except Exception as e:
            logger.error(f"❌ Firebase 連線失敗: {e}")
            return
    
    def _update_status(self, ref_status, state, message=""):
        """輔助方法：更新連線狀態"""
        try:
            ref_status.update({
                'state': state,     # 狀態代碼: offline, timeout, connecting, active
                'message': message, # 狀態訊息
            })
        except Exception as e:
            logger.error(f"狀態更新失敗: {e}")

    def stop(self):
        self.running = False
        if self.data_queue:
            self.data_queue.put(None)

    def run(self):
        self.running = True

        ref_latest = db.reference(f'{self.project_name}/latest')
        ref_history = db.reference(f'{self.project_name}/history')
        ref_status = db.reference(f'{self.project_name}/status')
        logger.info(f"🚀 開始同步 Firebase ...")
        
        last_data_receive_time = 0
        # 設定寬限期 (秒)：超過幾秒沒資料才切回黃燈
        grace_period = 2.0
        # 預設停止原因為正常關機
        exit_state = 'offline'
        exit_msg = '程式已停止運作'
        try:
            while self.running:
                try:
                    data = self.data_queue.get(timeout=1)
                    
                    # 判斷是否更新最新資料
                    if data:
                        last_data_receive_time = time.time()
                        ref_latest.set(data)
                        ref_status.update({
                            'state': 'active',
                            'message': '正在接收 GPS 數據...'
                        })
                    if data is None: 
                        if self.running:
                            # 情況 A: 程式還在跑，卻收到 None -> 異常斷線 (Timeout)
                            exit_state = 'timeout'
                            exit_msg = '程式已停止運作 (GPS連線中斷)'
                        else:
                            # 情況 B: stop() 被呼叫過，收到 None -> 正常關閉
                            exit_state = 'offline'
                            exit_msg = '系統已手動關閉'
                        break

                    ref_history.push(data)
                    logger.info(f"座標: ({data['lat']:.6f}, {data['lon']:.6f}) || 濃度: {data.get('conc', 'N/A')} {data['conc_unit']} (狀態: {'Active' if data['status']=='A' else 'Void'})")
                
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

        except Exception as e:
            exit_state = 'error'
            exit_msg = f'程式錯誤: {str(e)}'
            logger.error(f"❌ 錯誤: {e}")

        finally:
            # ✨ 這裡會根據上面的邏輯，寫入正確的停止原因
            # 如果是 timeout，這裡就會寫入 state: 'timeout'
            self._update_status(ref_status, exit_state, exit_msg)
            logger.info(f"🏁 服務停止，原因: {exit_state}")