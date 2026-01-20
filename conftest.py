import logging
import pytest
import sys
import io

# ✨ 新增這段：強制 Windows 環境下的輸出使用 utf-8
if sys.platform.startswith('win'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

def pytest_configure(config):
    # 只要設定層級就好，不要加任何 Handler
    logging.getLogger().setLevel(logging.INFO)