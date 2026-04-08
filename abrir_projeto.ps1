# Iniciar Servidor Local para APF Checklist (Sem Node.js)
$port = 8000
$hostAddress = "http://localhost:$port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($hostAddress)

try {
    $listener.Start()
    Write-Host "`n====================================================" -ForegroundColor Cyan
    Write-Host " SERVIDOR LOCAL ATIVO EM: $hostAddress" -ForegroundColor Green 
    Write-Host "====================================================`n" -ForegroundColor Cyan
    Write-Host "Instruções:" -ForegroundColor Yellow
    Write-Host "1. Copie e cole $hostAddress no seu navegador."
    Write-Host "2. No Dropbox Dashboard, adicione $hostAddress como 'Redirect URI'."
    Write-Host "3. Mantenha esta janela aberta enquanto usa o sistema.`n"
    Write-Host "Pressione CTRL+C para encerrar o servidor.`n"

    # Abrir o navegador automaticamente
    Start-Process $hostAddress

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $path = $request.Url.LocalPath
        if ($path -eq "/" -or $path -eq "") { $path = "/index.html" }
        
        # Resolve path relative to script location
        $scriptPath = Split-Path $MyInvocation.MyCommand.Path
        $localPath = [System.IO.Path]::Combine($scriptPath, $path.TrimStart('/'))

        if (Test-Path $localPath -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($localPath)
            
            # Content-Types basics
            $extension = [System.IO.Path]::GetExtension($localPath).ToLower()
            $contentType = switch ($extension) {
                ".html" { "text/html; charset=utf-8" }
                ".css"  { "text/css" }
                ".js"   { "application/javascript" }
                ".png"  { "image/png" }
                ".jpg"  { "image/jpeg" }
                ".pdf"  { "application/pdf" }
                default { "application/octet-stream" }
            }
            
            $response.ContentType = $contentType
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("Arquivo nao encontrado: $path")
            $response.OutputStream.Write($msg, 0, $msg.Length)
        }
        $response.Close()
    }
} catch {
    Write-Host "Erro ao iniciar o servidor: $_" -ForegroundColor Red
} finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
}
