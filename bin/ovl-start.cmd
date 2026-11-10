@echo off
rem Drop-in for `start "title" [/D dir] cmd /k "command"`: opens the command as a tab in Overlord's
rem Terminals pane, or, when Overlord isn't running, as the usual console window. Title is required.
rem Overlord copies this file to %USERPROFILE%\.overlord\bin on every launch.
node "%~dp0ovl-start.js" %* 2>nul && exit /b 0
start %*
