$ErrorActionPreference = "Stop"
$files = @(Get-ChildItem frontend/release/*.exe)
if ($files.Count -lt 2) { throw "Expected both a desktop installer and a standalone CLI." }
$results = foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature $file.FullName
    if ($signature.Status -ne "Valid") { throw "Invalid signature for $($file.Name): $($signature.Status)" }
    if (-not $signature.TimeStamperCertificate) { throw "Missing signing timestamp for $($file.Name)" }
    [pscustomobject]@{ file = $file.Name; status = "$($signature.Status)"; signer = $signature.SignerCertificate.Subject; thumbprint = $signature.SignerCertificate.Thumbprint }
}
$results | ConvertTo-Json | Set-Content frontend/release/signatures-windows.json
