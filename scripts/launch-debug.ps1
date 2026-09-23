$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process -FilePath 'D:\ide\mdreader\desktop\bin\Release\net6.0-windows\mdreader.exe'
Write-Output 'launched'
