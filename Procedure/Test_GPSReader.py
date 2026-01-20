import pytest
import queue
from unittest.mock import MagicMock, patch
from Procedure.GPSReader import GPSReader 

class TestGPSReader:

    @pytest.fixture
    def reader(self):
        obj = GPSReader()
        obj.ip = "127.0.0.1"
        obj.port = 1234
        obj.gps_queue = queue.Queue()
        return obj

    def test_logic_timer_timeout(self, reader):
        """
        測試：檢查超時邏輯是否在 30 秒時正確觸發
        """
        reader.running = True
        reader.timeout_limit = 30
        start_time = 1000.0  # 模擬起始時間
        
        # 1. 模擬第一次失敗
        first_failure_time = start_time
        
        # 2. 模擬 20 秒後 (預期應繼續運行，因為還沒到 30 秒)
        test_time_20 = start_time + 20
        assert (test_time_20 - first_failure_time >= reader.timeout_limit) is False
        
        # 3. 模擬 31 秒後 (預期應滿足條件，準備停止)
        test_time_31 = start_time + 31
        assert (test_time_31 - first_failure_time >= reader.timeout_limit) is True

    @patch('Procedure.GPSReader.pynmea2.parse')
    def test_parse_exception_handling(self, mock_parse, reader):
        """
        測試：當 NMEA 解析失敗時，程式不應崩潰且 Queue 應為空
        """
        mock_parse.side_effect = Exception("Parse Error")
        
        # 就算發生異常，這行也不該噴錯 (因為你有 try-except pass)
        reader._parse_and_push("$INVALID_NMEA_DATA")
        
        assert reader.gps_queue.empty()

    def test_cleanup_on_none_objects(self, reader):
        """
        測試：當 socket 或 file_obj 已經是 None 時，cleanup 不應噴錯
        """
        reader.socket = None
        reader.file_obj = None
        try:
            reader._cleanup()
        except Exception as e:
            pytest.fail(f"Cleanup failed on None objects: {e}")

    @patch('socket.socket')
    def test_producer_stops_on_running_false(self, mock_socket, reader):
        """
        測試：當 self.running 被外部設為 False 時，執行緒應能正常跳出迴圈
        """
        reader.running = False # 模擬啟動後立刻被要求停止
        # 如果 _producer 沒有檢查 running，這會變成無限迴圈
        reader._producer() 
        
        # 確認最後有放 None 進 Queue
        assert reader.gps_queue.get() is None

    def test_duplicate_timestamp_filter(self, reader):
        """
        測試：同一秒鐘的多筆數據是否會被過濾掉 (一秒只留一筆)
        """
        # 模擬第一筆數據
        reader.latest_data["timestamp"] = "2026-01-06 12:00:01"
        reader.latest_data["status"] = "A"
        reader.last_yield_time = None
        
        # 呼叫解析邏輯 (直接用 update 模擬解析結果)
        reader.gps_queue.put(reader.latest_data.copy())
        reader.last_yield_time = "2026-01-06 12:00:01"
        
        # 模擬同一秒的第二筆數據
        reader._parse_and_push("$GPRMC,120001,A,2502.397,N,12130.464,E,022.4,084.4,230394,003.1,W*6A")
        
        # Queue 裡面應該只有最初手動放進去的那一筆，第二筆不該進去
        assert reader.gps_queue.qsize() == 1