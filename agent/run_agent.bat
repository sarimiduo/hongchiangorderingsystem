@echo off
rem Hong Chiang -> ESB POS bridge agent launcher (restarts on crash)
cd /d %~dp0
:loop
python hc_bridge_agent.py --config agent.ini --run
echo agent exited with %errorlevel%, restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
