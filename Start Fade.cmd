@echo off
title Fade
node "%~dp0scripts\windows-launch.mjs" %*
if errorlevel 1 pause
