@echo off
set PORT=8080
echo.
echo ===========================================
echo    Servidor Local para Checklist APF
echo ===========================================
echo.
echo Iniciando o servidor...
echo Abrindo o navegador em instantes...
echo.

:: Abre o navegador com um pequeno atraso para dar tempo ao servidor de iniciar
start /b cmd /c "timeout /t 2 >nul && start http://localhost:%PORT%"

echo Para encerrar o servidor, feche esta janela ou pressione Ctrl+C.
echo.

powershell -NoProfile -Command "$p=%PORT%; $l=[System.Net.HttpListener]::new(); $l.Prefixes.Add('http://localhost:'+$p+'/'); $l.Start(); while($l.IsListening){ $c=$l.GetContext(); $q=$c.Request.Url.LocalPath; if($q -eq '/'){$q='/index.html'}; $f=Join-Path (Get-Location) $q.Replace('/','\').TrimStart('\'); if(Test-Path $f -PathType Leaf){ $ext=[System.IO.Path]::GetExtension($f).ToLower(); if($ext -eq '.js'){$c.Response.ContentType='application/javascript'} elseif($ext -eq '.css'){$c.Response.ContentType='text/css'} elseif($ext -eq '.html'){$c.Response.ContentType='text/html'} elseif($ext -eq '.png'){$c.Response.ContentType='image/png'} elseif($ext -eq '.jpg' -or $ext -eq '.jpeg'){$c.Response.ContentType='image/jpeg'} elseif($ext -eq '.svg'){$c.Response.ContentType='image/svg+xml'} $b=[System.IO.File]::ReadAllBytes($f); $c.Response.OutputStream.Write($b,0,$b.Length); } else { $c.Response.StatusCode=404; } $c.Response.Close(); }"
