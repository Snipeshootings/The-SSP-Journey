$f='c:\Users\laklytto\Documents\GitHub\The-SSP-Journey\SSP_Util_1.6.73.user.js'
$text=Get-Content $f -Raw
$names=[regex]::Matches($text,'function\\s+([A-Za-z0-9_]+)') | ForEach-Object {$_.Groups[1].Value} | Sort-Object | Get-Unique
foreach($name in $names){
    $cnt=([regex]::Matches($text,'\\b'+[regex]::Escape($name)+'\\b')).Count
    if($cnt -eq 1){ Write-Output "UNUSED: $name" }
}
