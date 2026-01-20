import pytest
import queue
import time
import threading
import webbrowser

from datetime import datetime
from unittest.mock import MagicMock, patch
from Procedure.FirebaseManager import FirebaseManager  

class TestFirebaseManager:

    @pytest.fixture
    def manager(self):
        """初始化測試用的 Manager 實例"""
        obj = FirebaseManager()
        obj.key_path = "firebase_key.json"
        obj.db_url = "https://real-time-gps-84c8a-default-rtdb.asia-southeast1.firebasedatabase.app"
        obj.project_name = "test_project"
        obj.db_id = "real-time-gps-84c8a"
        obj.api_key = "AIzaSyCjPnL5my8NsG7XYCbABGh45KtKM9s4SlI"
        obj.map_url = "http://localhost"
        obj.data_queue = queue.Queue()
        return obj

    # ==========================================================
    # 1. 邏輯測試 (使用 Mock 驗證狀態切換)
    # ==========================================================
    @patch('Procedure.FirebaseManager.db.reference')
    @patch('Procedure.FirebaseManager.firebase_admin.initialize_app')
    @patch('Procedure.FirebaseManager.firebase_admin.credentials.Certificate')
    @patch('Procedure.FirebaseManager.webbrowser.open')
    def test_status_transitions(self, mock_browser, mock_cert, mock_init, mock_ref, manager):
        """測試狀態轉換：正常接收 -> 暫時沒資料 -> 停止"""
        
        # 模擬三個 Firebase 引用點
        mock_latest = MagicMock()
        mock_history = MagicMock()
        mock_status = MagicMock()
        # 依照程式順序：latest, history, status
        mock_ref.side_effect = [mock_latest, mock_history, mock_status]

        # 模擬資料流程
        # 第一筆資料
        manager.data_queue.put({"lat": 25.0, "lon": 121.0, "alt": 10, "status": "A", "conc": 0.0, "conc_unit": "ppm"})
        # 放入 None 結束迴圈
        manager.data_queue.put(None)

        # 執行程式
        manager.run()

        # 驗證狀態更新呼叫
        # 1. 收到資料時應更新為 active
        mock_status.update.assert_any_call({
            'state': 'active',
            'message': '正在接收 GPS 數據...'
        })
        
        # 2. 結束時應該呼叫 _update_status 寫入 timeout (因為我們最後給 None)
        # 注意：你的程式碼邏輯中，data is None 會將 exit_state 設為 'timeout'
        mock_status.set.assert_called_with({
            'state': 'timeout',
            'message': '程式已停止運作 (GPS連線中斷)'
        })

    # ==========================================================
    # 2. 真實推送測試 (需配合實體金鑰檔案)
    # ==========================================================
    def test_run_simulation(self, manager):
        """真實環境測試：模擬移動並觀察狀態燈號與地圖"""
        
        # 填入真實路徑
        manager.key_path = "firebase_key.json" 
        manager.db_url = "https://real-time-gps-84c8a-default-rtdb.asia-southeast1.firebasedatabase.app"
        manager.map_url = "https://cloud5281.github.io/real-time-gps/"

        def feeder():
            # 模擬一筆資料後，等待一段時間產生連接中斷的感覺
            manager.data_queue.put({"timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "lat": 25.0336, "lon": 121.5644, "alt": 10, "status": "A", "conc": 50.0, "conc_unit": "ppm"})
            time.sleep(5) # 故意超過 grace_period (2秒)，此時網頁應變黃燈
            
            manager.data_queue.put({"timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "lat": 25.0340, "lon": 121.5650, "alt": 12, "status": "A", "conc": 100.0, "conc_unit": "ppm"})
            time.sleep(2)
            manager.data_queue.put(None)    # 連線逾時的訊號

        feeder_thread = threading.Thread(target=feeder, daemon=True)
        feeder_thread.start()

        manager.run()

    # ==========================================================
    # 3. 邊界測試：初始化失敗
    # ==========================================================
    @patch('Procedure.FirebaseManager.firebase_admin.initialize_app')
    def test_init_failure(self, mock_init, manager):
        """驗證當 Firebase 初始化失敗時，程式是否能安全結束"""
        mock_init.side_effect = Exception("Invalid URL")
        
        # 不應噴出異常，而是 log error 後 return
        manager._initialize_firebase()
        assert manager.running is True # 檢查狀態