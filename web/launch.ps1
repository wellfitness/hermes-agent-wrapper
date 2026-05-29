# Lanzador de Hermes Web.
#
# 1) Si ya hay un servidor escuchando en el puerto, solo abre el navegador.
# 2) Si no, pide la carpeta de trabajo y arranca el servidor (que abre el
#    navegador al estar listo). La ventana queda abierta = el servidor vivo;
#    ciérrala (o Ctrl+C) para detener Hermes Web.
#
# El acceso directo del Escritorio invoca este script con:
#   powershell.exe -ExecutionPolicy Bypass -STA -File launch.ps1

$ErrorActionPreference = 'Stop'

$bindHost = '127.0.0.1'
$port = [int]($env:HERMES_WEB_PORT)
if (-not $port) { $port = 4790 }
$url = "http://${bindHost}:${port}"
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- 1) ¿Ya hay un servidor escuchando? ---
$alreadyUp = $false
try {
  $client = New-Object System.Net.Sockets.TcpClient
  $client.Connect($bindHost, $port)
  $alreadyUp = $client.Connected
  $client.Close()
} catch {
  $alreadyUp = $false
}

if ($alreadyUp) {
  Write-Host "Hermes Web ya esta en marcha. Abriendo $url ..."
  Start-Process $url
  Start-Sleep -Seconds 1
  return
}

# --- 2) Elegir la carpeta de trabajo de Hermes ---
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Elige la carpeta sobre la que trabajara Hermes (lee/escribe archivos ahi)'
$dialog.ShowNewFolderButton = $true
if (Test-Path $projectDir) { $dialog.SelectedPath = $projectDir }

$result = $dialog.ShowDialog()
if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
  Write-Host 'Cancelado. No se ha iniciado Hermes Web.'
  Start-Sleep -Seconds 1
  return
}
$cwd = $dialog.SelectedPath

# --- 3) Arrancar el servidor (abre el navegador al estar listo) ---
$env:HERMES_WEB_CWD = $cwd
$env:HERMES_WEB_OPEN = '1'
Set-Location $projectDir

Write-Host "Iniciando Hermes Web sobre: $cwd"
Write-Host "(Cierra esta ventana o pulsa Ctrl+C para detener el servidor.)`n"

try {
  pnpm start
} catch {
  Write-Host "`nError al iniciar Hermes Web: $_" -ForegroundColor Red
}

# Si el servidor se detiene (Ctrl+C o error), mantener la ventana para leer el mensaje.
Write-Host "`nEl servidor se ha detenido. Pulsa Enter para cerrar."
Read-Host | Out-Null
