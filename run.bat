@echo off
setlocal
python -m venv venv
call venv\Scripts\activate
pip install -r requirements.txt
python backend/app.py

