# Regenerates the second set of .xls fixtures used by tests/xls_import.rs
# (the first set comes from make_fixtures.ps1).
#
# Requires desktop Excel (COM automation). Files are saved with
# SaveAs FileFormat 56 (xlExcel8 = Excel 97-2003 workbook).
#
#   pwsh -ExecutionPolicy Bypass -File tests\fixtures\xls\make_more_fixtures.ps1
#
# Outputs (next to this script):
#   columns.xls        references to columns past Z (AA, AB, IV), absolute and
#                      in a range, string literals that contain quotes, and
#                      one fixed-argument function (ABS)
#   span3d.xls         a 3D reference over a sheet span ('1月:3月'!B2) in a
#                      formula and in a defined name, next to a plain one
#   new_functions.xls  functions added after Excel 2003 (IFERROR, SUMIFS,
#                      COUNTIFS) and one Nicel does not support (FILTERXML)
#   corner.xls         sheet "Big" with values in A1 and IV65536 (a full-size
#                      used range), plus two one-cell sheets
#   corners3.xls       three sheets, each with values in A1 and IV65536
$ErrorActionPreference = 'Stop'
$out = $PSScriptRoot
$columns = Join-Path $out 'columns.xls'
$span3d = Join-Path $out 'span3d.xls'
$newfn = Join-Path $out 'new_functions.xls'
$corner = Join-Path $out 'corner.xls'
$corners3 = Join-Path $out 'corners3.xls'
foreach ($p in @($columns, $span3d, $newfn, $corner, $corners3)) { if (Test-Path $p) { Remove-Item $p -Force } }

function Add-Sheets($wb, [int]$count) {
  while ($wb.Worksheets.Count -lt $count) { [void]$wb.Worksheets.Add([Type]::Missing, $wb.Worksheets.Item($wb.Worksheets.Count)) }
  while ($wb.Worksheets.Count -gt $count) { $wb.Worksheets.Item($wb.Worksheets.Count).Delete() }
}

$xl = New-Object -ComObject Excel.Application
try {
  $xl.Visible = $false
  $xl.DisplayAlerts = $false

  # columns.xls
  $wb = $xl.Workbooks.Add()
  Add-Sheets $wb 1
  $s = $wb.Worksheets.Item(1); $s.Name = 'Data'
  $s.Range('Z1').Value2 = 1
  $s.Range('AA1').Value2 = 2
  $s.Range('AB1').Value2 = 3
  $s.Range('IV1').Value2 = 5
  $s.Range('A3').Formula = '=AA1'
  $s.Range('A4').Formula = '=IV1'
  $s.Range('A5').Formula = '=$AA$1'
  $s.Range('A6').Formula = '=SUM(Z1:AB1)'
  $s.Range('A7').Formula = '=Z1'
  $s.Range('A8').Formula = '="say ""hi"""'
  $s.Range('A9').Formula = '=A8&""""'
  $s.Range('A10').Formula = '=ABS(-Z1)'
  $wb.SaveAs($columns, 56); $wb.Close($false)

  # span3d.xls
  $wb = $xl.Workbooks.Add()
  Add-Sheets $wb 4
  $wb.Worksheets.Item(1).Name = '1月'
  $wb.Worksheets.Item(2).Name = '2月'
  $wb.Worksheets.Item(3).Name = '3月'
  $wb.Worksheets.Item(4).Name = '集計'
  for ($i = 1; $i -le 3; $i++) {
    $wb.Worksheets.Item($i).Range('B2').Value2 = $i * 10
    $wb.Worksheets.Item($i).Range('B3').Value2 = $i
  }
  $t = $wb.Worksheets.Item(4)
  $t.Range('A1').Formula = "=SUM('1月:3月'!B2)"
  $t.Range('A2').Formula = "='2月'!B2"
  [void]$wb.Names.Add('Span', "='1月:3月'!`$B`$2")
  [void]$wb.Names.Add('Feb', "='2月'!`$B`$2")
  $wb.SaveAs($span3d, 56); $wb.Close($false)

  # new_functions.xls
  $wb = $xl.Workbooks.Add()
  Add-Sheets $wb 1
  $s = $wb.Worksheets.Item(1); $s.Name = 'S'
  $s.Range('A1').Value2 = 1
  $s.Range('A2').Value2 = 2
  $s.Range('B1').Value2 = 'a'
  $s.Range('B2').Value2 = 'b'
  $s.Range('C1').Formula = '=IFERROR(1/0,"x")'
  $s.Range('C2').Formula = '=SUMIFS(A1:A2,B1:B2,"a")'
  $s.Range('C3').Formula = '=COUNTIFS(B1:B2,"b")'
  $s.Range('C4').Formula = '=IFERROR(A1/A2,0)+1'
  $s.Range('C5').Formula = '=FILTERXML("<a>7</a>","//a")'
  $wb.SaveAs($newfn, 56); $wb.Close($false)

  # corner.xls
  $wb = $xl.Workbooks.Add()
  Add-Sheets $wb 3
  $wb.Worksheets.Item(1).Name = 'Big'
  $wb.Worksheets.Item(2).Name = 'S2'
  $wb.Worksheets.Item(3).Name = 'S3'
  $wb.Worksheets.Item(1).Range('A1').Value2 = 1
  $wb.Worksheets.Item(1).Range('IV65536').Value2 = 2
  $wb.Worksheets.Item(2).Range('A1').Value2 = 3
  $wb.Worksheets.Item(3).Range('A1').Value2 = 4
  $wb.SaveAs($corner, 56); $wb.Close($false)

  # corners3.xls
  $wb = $xl.Workbooks.Add()
  Add-Sheets $wb 3
  for ($i = 1; $i -le 3; $i++) {
    $wb.Worksheets.Item($i).Name = @("Alpha", "Beta", "Gamma")[$i - 1]
    $wb.Worksheets.Item($i).Range('A1').Value2 = $i
    $wb.Worksheets.Item($i).Range('IV65536').Value2 = $i * 10
  }
  $wb.SaveAs($corners3, 56); $wb.Close($false)
} finally {
  $xl.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}
Get-ChildItem $out -Filter *.xls | Select-Object Name, Length | Format-Table -AutoSize
