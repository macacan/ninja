@echo off
rem Startar Lootninjas butiksbevakning (varannan minut). Stäng fönstret eller tryck Ctrl+C för att stoppa.
cd /d "%~dp0"
node scripts\scraper\daemon.mjs
