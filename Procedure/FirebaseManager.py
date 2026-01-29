import firebase_admin
import logging
import queue
import time

from firebase_admin import credentials, db
from geopy.distance import geodesic

logger = logging.getLogger(__name__)

class FirebaseManager:
    def __init__(self, key_path, db_url):
        self.key_path = key_path
        self.db_url = db_url
        self.project_name = None
        self.data_queue = None
        self.running = False
        
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
        try:
            ref_status.update({
                'state': state,
                'message': message,
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
        grace_period = 2.0
        exit_state = 'offline'
        exit_msg = '程式已停止運作'
        
        try:
            while self.running:
                try:
                    data = self.data_queue.get(timeout=1)
                    
                    if data:
                        last_data_receive_time = time.time()
                        ref_latest.set(data)
                        
                        # 🔥🔥🔥 紅綠燈判斷邏輯開始 🔥🔥🔥
                        d_status = data.get('status')
                        
                        # 預設：🟢 綠燈 (Active)
                        current_state = 'active'
                        current_msg = 'GPS 和濃度連線成功'

                        # 情況 A: 🟡 黃燈 - GPS 斷線 (但濃度正常)
                        if d_status == 'GPS Lost':
                            current_state = 'connecting'
                            current_msg = '⚠️ GPS 斷線 (濃度正常)'
                        
                        # 情況 B: 🟡 黃燈 - 濃度斷線 (但 GPS 正常)
                        elif d_status == 'Sensor Timeout':
                            current_state = 'connecting'
                            current_msg = '⚠️ 濃度斷線 (GPS 正常)'
                        
                        # 情況 C: 🟡 黃燈 - GPS 硬體有連但無定位 (Void)
                        elif d_status == 'V':
                            current_state = 'connecting'
                            current_msg = 'GPS 定位中...'

                        # 情況 D: 🔴 紅燈 - 雙重斷線
                        elif d_status == 'All Lost':
                            current_state = 'timeout'
                            current_msg = '❌ GPS 和濃度皆斷線'
                        
                        # 更新到 Firebase (網頁會根據 state 變色)
                        ref_status.update({
                            'state': current_state,
                            'message': current_msg
                        })
                        # 🔥🔥🔥 紅綠燈判斷邏輯結束 🔥🔥🔥

                    if data is None: 
                        if self.running:
                            exit_state = 'timeout'
                            exit_msg = '程式已停止運作 (GPS連線中斷)'
                        else:
                            exit_state = 'offline'
                            exit_msg = '系統已手動關閉'
                        break

                    ref_history.push(data)
                    
                    if data['lat'] is not None and data['lon'] is not None:
                        coord_str = f"({data['lat']:.6f}, {data['lon']:.6f})"
                    else:
                        coord_str = "(No GPS)"

                    # 這裡的狀態顯示也跟著更新一下
                    status_log = current_msg if data else 'N/A'
                    logger.info(f"座標: {coord_str} || 濃度: {data.get('conc', 'N/A')} {data['conc_unit']} ({status_log})")
                
                except queue.Empty:
                    # Queue 空的但還沒結束
                    time_diff = time.time() - last_data_receive_time
                    if time_diff < grace_period:
                        pass # 還在寬限期內，維持原燈號
                    else:     
                        # 超過寬限期沒資料 -> 黃燈等待中
                        ref_status.update({
                            'state': 'connecting', 
                            'message': '等待訊號...'
                        })
                    continue

        except Exception as e:
            exit_state = 'error'
            exit_msg = f'程式錯誤: {str(e)}'
            logger.error(f"❌ 錯誤: {e}")

        finally:
            self._update_status(ref_status, exit_state, exit_msg)
            logger.info(f"🏁 服務停止，原因: {exit_state}")