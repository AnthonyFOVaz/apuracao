# Publica server.js e public/ no servidor Oracle e reinicia o serviço.
#   .\deploy.ps1
# Chave SSH: $env:ORACLE_SSH_KEY ou o caminho padrão abaixo.
$ErrorActionPreference = "Stop"

$key = if ($env:ORACLE_SSH_KEY) { $env:ORACLE_SSH_KEY } else { "D:\Dados\antho\Downloads\Oracle-Server-Access\oracle-ubuntu.key" }
$server = "ubuntu@204.216.184.199"
$dest = "/home/ubuntu/projects/apuracao"
$ssh = @("-i", $key, "-o", "BatchMode=yes")

ssh @ssh $server "mkdir -p $dest/public"
scp @ssh -q "$PSScriptRoot\server.js" "${server}:$dest/server.js"
scp @ssh -q "$PSScriptRoot\public\index.html" "$PSScriptRoot\public\favicon.svg" "${server}:$dest/public/"
ssh @ssh $server "sudo systemctl restart apuracao && sleep 3 && systemctl is-active apuracao && curl -fsS 127.0.0.1:3100/health"
