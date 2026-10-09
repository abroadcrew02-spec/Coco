$ErrorActionPreference = 'Stop'
$p = Join-Path $PSScriptRoot 'xlm.xls'
if (Test-Path $p) { Remove-Item $p -Force }
$xl = New-Object -ComObject Excel.Application
try {
  $xl.Visible = $false; $xl.DisplayAlerts = $false
  $wb = $xl.Workbooks.Add()
  while ($wb.Worksheets.Count -gt 1) { $wb.Worksheets.Item($wb.Worksheets.Count).Delete() }
  $wb.Worksheets.Item(1).Name = 'S'
  $wb.Worksheets.Item(1).Range('A1').Value2 = 5
  $m = $wb.Excel4MacroSheets.Add()
  $m.Name = 'Macro1'
  $m.Range('A1').Formula = 'Demo'
  $m.Range('A2').Formula = '=FILE.CLOSE()'
  $m.Range('A3').Formula = '=BEEP()'
  $m.Range('A4').Formula = '=RETURN()'
  $wb.SaveAs($p, 56); $wb.Close($false)
} finally {
  $xl.Quit(); [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}
Get-Item $p | Select-Object Name, Length
