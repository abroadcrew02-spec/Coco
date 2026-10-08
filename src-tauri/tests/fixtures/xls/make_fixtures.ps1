# Regenerates the .xls fixtures used by tests/xls_import.rs.
#
# Requires desktop Excel (COM automation). Files are saved with
# SaveAs FileFormat 56 (xlExcel8 = Excel 97-2003 workbook).
#
#   powershell -ExecutionPolicy Bypass -File tests\fixtures\xls\make_fixtures.ps1
#
# Outputs (next to this script):
#   basic.xls           values, formulas, dates, defined name, hidden sheet, sheet "R5"
#   password.xls        basic content, password "secret"
#   shared_formula.xls  a FillDown range (stored by Excel as a shared formula)
#   external_ref.xls    formulas and a defined name pointing at another workbook
$ErrorActionPreference = 'Stop'
$out = $PSScriptRoot
$basic = Join-Path $out 'basic.xls'
$pw = Join-Path $out 'password.xls'
$shared = Join-Path $out 'shared_formula.xls'
$external = Join-Path $out 'external_ref.xls'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("nicel-xls-fixtures-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $tmp | Out-Null
$other = Join-Path $tmp 'other.xls'
foreach ($p in @($basic, $pw, $shared, $external)) { if (Test-Path $p) { Remove-Item $p -Force } }

$xl = New-Object -ComObject Excel.Application
try {
  $xl.Visible = $false
  $xl.DisplayAlerts = $false

  # basic.xls / password.xls
  $wb = $xl.Workbooks.Add()
  while ($wb.Worksheets.Count -lt 4) { [void]$wb.Worksheets.Add([Type]::Missing, $wb.Worksheets.Item($wb.Worksheets.Count)) }
  $s1 = $wb.Worksheets.Item(1); $s1.Name = '売上'
  $s2 = $wb.Worksheets.Item(2); $s2.Name = '集計'
  $s3 = $wb.Worksheets.Item(3); $s3.Name = '隠し'
  $s4 = $wb.Worksheets.Item(4); $s4.Name = 'R5'

  $s1.Range('A1').Value2 = '品名'
  $s1.Range('B1').Value2 = '数量'
  $s1.Range('C1').Value2 = '単価'
  $s1.Range('D1').Value2 = $true
  $s1.Range('A2').Value2 = 'りんご'
  $s1.Range('B2').Value2 = 10
  $s1.Range('C2').Value2 = 120.5
  $s1.Range('A3').Value2 = 'みかん'
  $s1.Range('B3').Value2 = 5
  $s1.Range('C3').Value2 = 80
  $s1.Range('B4').Formula = '=SUM(B2:B3)'
  $s1.Range('C4').Formula = '=SUM($C$2:$C$3)'
  $s1.Range('E2').Formula = '=IF(B2>5,"多い","少ない")'
  $s1.Range('F2').Formula = '=$B$2*C2'
  $s1.Range('G2').Formula = '=B2+C2'
  $s1.Range('H2').Formula = '=$B2+B$2'
  # Dates typed the way a ja-JP user types them
  $s1.Range('A6').Formula = '2024/1/15'
  $s1.Range('A7').Formula = '12:30'
  $s1.Range('A8').Formula = '2024/1/15 9:05'
  $s1.Range('A9').Formula = '=A6+1'
  $s1.Range('A10').Value2 = 1.0
  $s1.Range('A10').NumberFormat = '[h]:mm:ss'

  $s2.Range('A1').Formula = '=売上!B4'
  $s2.Range('A2').Formula = '=SUM(売上!B2:B3)'
  $s2.Range('A3').Formula = '=売上!$C$2'
  $s2.Range('A5').Formula = '=1/0'
  $s2.Range('A6').Formula = '=売上!A2&"です"'
  $s2.Range('A7').Formula = '=SUM(売上!$B$2:$B$3)'
  $s2.Range('A8').Formula = "='R5'!A1*2"

  [void]$wb.Names.Add('合計数量', '=売上!$B$4')
  $s2.Range('A4').Formula = '=合計数量'

  $s3.Range('C5').Value2 = 'offset'
  $s3.Range('D6').Value2 = 42
  $s3.Visible = 0  # xlSheetHidden

  $s4.Range('A1').Value2 = 3

  $s1.Activate()
  $wb.SaveAs($basic, 56)
  $wb.SaveAs($pw, 56, 'secret')
  $wb.Close($false)

  # shared_formula.xls
  $wb = $xl.Workbooks.Add()
  $s = $wb.Worksheets.Item(1); $s.Name = '共有'
  for ($i = 2; $i -le 12; $i++) { $s.Range("B$i").Value2 = $i - 1 }
  $s.Range('C2').Formula = '=B2*3'
  [void]$s.Range('C2:C12').FillDown()
  $wb.SaveAs($shared, 56)
  $wb.Close($false)

  # external_ref.xls: refers to other.xls, which is not shipped
  $wb = $xl.Workbooks.Add()
  $s = $wb.Worksheets.Item(1); $s.Name = 'Data'
  $s.Range('A1').Value2 = 5
  $s.Range('A2').Value2 = 7
  $wb.SaveAs($other, 56)
  $otherBook = $wb

  $wb = $xl.Workbooks.Add()
  while ($wb.Worksheets.Count -lt 2) { [void]$wb.Worksheets.Add([Type]::Missing, $wb.Worksheets.Item($wb.Worksheets.Count)) }
  $s1 = $wb.Worksheets.Item(1); $s1.Name = '参照'
  $s2 = $wb.Worksheets.Item(2); $s2.Name = '内部'
  $s2.Range('A1').Value2 = 11
  $s1.Range('A1').Formula = '=[other.xls]Data!A1'
  $s1.Range('A2').Formula = '=内部!A1'
  $s1.Range('A3').Formula = '=SUM([other.xls]Data!A1:A2)'
  [void]$wb.Names.Add('外部名', '=[other.xls]Data!$A$1')
  [void]$wb.Names.Add('内部名', '=内部!$A$1')
  $s1.Activate()
  $wb.SaveAs($external, 56)
  $wb.Close($false)
  $otherBook.Close($false)
}
finally {
  $xl.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Get-ChildItem $out -Filter *.xls | Select-Object Name, Length | Format-Table -AutoSize
