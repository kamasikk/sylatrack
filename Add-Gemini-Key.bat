@echo off
title FitMind - Gemini key
echo.
echo Встав свій Gemini API key і натисни Enter.
echo Він буде збережений лише в локальному файлі .env.
set /p FITMIND_GEMINI_KEY=API key: 
if "%FITMIND_GEMINI_KEY%"=="" (
  echo Ключ не введено. Нічого не змінено.
  pause
  exit /b 1
)
> .env echo GEMINI_API_KEY=%FITMIND_GEMINI_KEY%
echo.
echo Готово. Тепер запускай Start-FitMind.bat як завжди.
pause
