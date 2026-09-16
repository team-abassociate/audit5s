@echo off
REM Lets phones on the same Wi-Fi reach this laptop during testing.
REM
REM   3000  the API the field app talks to
REM   5173  the web app, which serves the corrective-action links over HTTPS
REM
REM Right-click this file and choose "Run as administrator". Windows blocks incoming
REM connections by default, more strictly on a network marked Public, so without these
REM rules a phone gets "could not reach the server" however correct its address is.
REM
REM To undo, run these two lines in an Administrator prompt:
REM   netsh advfirewall firewall delete rule name=audit5sAPI3000
REM   netsh advfirewall firewall delete rule name=audit5sWeb5173

echo Adding firewall rules for audit5s testing...
echo.

netsh advfirewall firewall delete rule name=audit5sAPI3000 >nul 2>&1
netsh advfirewall firewall delete rule name=audit5sWeb5173 >nul 2>&1

netsh advfirewall firewall add rule name=audit5sAPI3000 dir=in action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name=audit5sWeb5173 dir=in action=allow protocol=TCP localport=5173

echo.
echo If both lines above say Ok. you are done.
echo If they say "requested operation requires elevation", close this window and
echo right-click the file again, choosing "Run as administrator".
echo.
pause
