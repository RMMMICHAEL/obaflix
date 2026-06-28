@echo off
echo === Obaflix Desktop - Build para Windows ===
cd /d "%~dp0"

echo Instalando dependencias...
call npm install

echo Gerando instalador (.exe)...
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=
call npm run build:win

echo.
if exist "dist\Obaflix Setup*.exe" (
    echo SUCESSO! Instalador gerado em: dist\
    dir dist\*.exe
) else (
    echo ATENCAO: Verifique a pasta dist\
)
pause
