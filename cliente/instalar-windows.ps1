# Instala el respaldo local del llm-gateway en Windows y configura Claude Code.
# - Arranque oculto al iniciar sesión (carpeta Inicio) y vigilante cada 5 min (tarea programada del usuario):
#   si ya está corriendo, el script sale solo (puerto ocupado).
# Requiere en el mismo directorio: respaldo-local.mjs y configurar-claude.py.
# Uso: powershell -ExecutionPolicy Bypass -File instalar-windows.ps1
$ErrorActionPreference = 'Stop'
$origen = $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA 'llm-gw-respaldo'
$node = (Get-Command node).Source
New-Item -ItemType Directory -Force $dest | Out-Null
if ((Resolve-Path $origen).Path -ne (Resolve-Path $dest).Path) {
  Copy-Item (Join-Path $origen 'respaldo-local.mjs'), (Join-Path $origen 'configurar-claude.py') $dest -Force
}
$script = Join-Path $dest 'respaldo-local.mjs'

# Lanzador sin ventana
$vbs = Join-Path $dest 'iniciar.vbs'
$linea = 'CreateObject("WScript.Shell").Run """' + $node + '"" ""' + $script + '""", 0, False'
Set-Content -Path $vbs -Value $linea -Encoding ASCII

# Al iniciar sesión
$inicio = Join-Path ([Environment]::GetFolderPath('Startup')) 'llm-gw-respaldo.vbs'
Copy-Item $vbs $inicio -Force

# Vigilante cada 5 minutos
$accion = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$disparo = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'llm-gw-respaldo' -Action $accion -Trigger $disparo -Settings $ajustes -Force | Out-Null

# Reiniciar con la versión nueva
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*respaldo-local.mjs*' -and $_.CommandLine -notlike '*--aviso*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"')
$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
  Start-Sleep -Milliseconds 500
  try { $estado = Invoke-RestMethod http://127.0.0.1:8741/_estado -TimeoutSec 2; $ok = $true } catch { }
}
if (-not $ok) { throw 'el respaldo local no respondió en 10 s; no se cambió settings.json' }
"estado: modo=$($estado.modo)"
python (Join-Path $dest 'configurar-claude.py') --node $node --script $script
