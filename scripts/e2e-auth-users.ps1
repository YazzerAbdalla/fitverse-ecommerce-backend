#Requires -Version 5.1
<#
.SYNOPSIS
  API-level flow test for the Auth + Users refactor (specs/015-auth-user-refactor).
.DESCRIPTION
  Exercises the live API (default http://localhost:3000) end-to-end with unique
  test users and asserts status codes / body keys / cookies / headers per
  specs/015-auth-user-refactor/contracts/auth-user-parity.md.
  Fails (exit 1) on the first mismatch; prints a step summary at the end.
  Windows PowerShell 5.1 compatible (no PS7-only flags).
.PARAMETER BaseUrl
  API base URL (default http://localhost:3000).
.PARAMETER EnforceRevocation
  S-1 mode: access tokens revoked via logout-all/reset MUST be denied (401).
  Omit for baseline (pre-refactor) runs where JwtGuard lets revoked tokens through.
.PARAMETER StripPasswordHash
  D3 mode: register 201 body MUST NOT contain a password/hash key.
  Omit for baseline runs (where the leak is still present and only recorded).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/e2e-auth-users.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/e2e-auth-users.ps1 -EnforceRevocation -StripPasswordHash
#>
param(
  [string]$BaseUrl = 'http://localhost:3000',
  [switch]$EnforceRevocation,
  [switch]$StripPasswordHash
)

$ErrorActionPreference = 'Stop'
$script:Passed = 0
$script:Failed = 0
$script:Steps = @()

function Step([string]$Name, [scriptblock]$Body) {
  try {
    &$Body
    $script:Passed++
    $script:Steps += "PASS  $Name"
  } catch {
    $script:Failed++
    $script:Steps += "FAIL  $Name :: $($_.Exception.Message)"
    throw
  }
}

function Assert([bool]$Cond, [string]$Msg) {
  if (-not $Cond) { throw $Msg }
}

# Low-level call: returns @{ Status=int; Body=obj; Headers=hashtable; Cookies=string }
function CallApi([string]$Method, [string]$Path, $Payload = $null, [hashtable]$ExtraHeaders = @{}) {
  $url = "$BaseUrl$Path"
  $params = @{
    Uri         = $url
    Method      = $Method
    Headers     = $ExtraHeaders
    ContentType = 'application/json'
  }
  if ($null -ne $Payload) { $params['Body'] = ($Payload | ConvertTo-Json -Depth 6) }
  try {
    $r = Invoke-WebRequest @params -UseBasicParsing
    $status = [int]$r.StatusCode
    $body = $null
    if ($r.Content) { $body = ($r.Content | ConvertFrom-Json) }
    return @{ Status = $status; Body = $body; Headers = $r.Headers; RawCookies = ($r.Headers['Set-Cookie']) }
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { throw "no HTTP response for $Method $Path :: $($_.Exception.Message)" }
    $status = [int]$resp.StatusCode
    $body = $null
    try {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $text = $sr.ReadToEnd()
      if ($text) { $body = ($text | ConvertFrom-Json) }
    } catch { }
    return @{ Status = $status; Body = $body; Headers = @{}; RawCookies = $null }
  }
}

function GetBodyMessage($Body) {
  if ($null -eq $Body) { return '' }
  if ($Body.message) { return [string]$Body.message }
  return ''
}

$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$email = "e2e-$ts@test.com"
$pass = 'Password123!'
$access = $null
$refresh = $null

Step 'register 201 (+ D3 password-key check)' {
  $r = CallApi 'POST' '/auth/register' @{ firstName = 'E2E'; lastName = 'User'; email = $email; password = $pass }
  Assert ($r.Status -eq 201) "expected 201, got $($r.Status)"
  Assert ($null -ne $r.Body.data) 'expected data object'
  $hasPw = ($null -ne $r.Body.data.password) -or ($null -ne $r.Body.data.passwordHash)
  if ($StripPasswordHash) {
    Assert (-not $hasPw) 'D3: register data must not contain password/hash key'
  } else {
    $script:Steps += "INFO  baseline: register data.password present = $hasPw"
  }
}

Step 'register duplicate 400' {
  $r = CallApi 'POST' '/auth/register' @{ firstName = 'E2E'; lastName = 'User'; email = $email; password = $pass }
  Assert ($r.Status -eq 400) "expected 400, got $($r.Status)"
}

Step 'login 200 + pair + cookie' {
  $r = CallApi 'POST' '/auth/login' @{ email = $email; password = $pass }
  Assert ($r.Status -eq 200) "expected 200, got $($r.Status)"
  Assert ($r.Body.accessToken.Length -gt 20) 'expected accessToken'
  Assert ($r.Body.refreshToken.Length -eq 64) 'expected 64-hex refreshToken'
  Assert ($null -ne $r.RawCookies -and "$r.RawCookies" -like '*refresh_token*') 'expected refresh_token Set-Cookie'
  $script:access = $r.Body.accessToken
  $script:refresh = $r.Body.refreshToken
}

Step 'login wrong password 401' {
  $r = CallApi 'POST' '/auth/login' @{ email = $email; password = 'Wrong123!' }
  Assert ($r.Status -eq 401) "expected 401, got $($r.Status)"
}

Step 'GET /users/me 200' {
  $r = CallApi 'GET' '/users/me' $null @{ Authorization = "Bearer $script:access" }
  Assert ($r.Status -eq 200) "expected 200, got $($r.Status)"
  Assert ($r.Body.email -eq $email) 'expected own email'
}

Step 'PATCH /users/me/preferences 200' {
  $r = CallApi 'PATCH' '/users/me/preferences' @{ marketingOptIn = $true } @{ Authorization = "Bearer $script:access" }
  Assert ($r.Status -eq 200) "expected 200, got $($r.Status)"
  Assert ($r.Body.marketingOptIn -eq $true) 'expected flag persisted'
  $r2 = CallApi 'PATCH' '/users/me/preferences' @{ marketingOptIn = $false } @{ Authorization = "Bearer $script:access" }
  Assert ($r2.Status -eq 200) 'expected 200 on revert'
}

Step 'refresh rotation 200 + old-token reuse 401 (theft nuke)' {
  $r = CallApi 'POST' '/auth/refresh' @{ refreshToken = $script:refresh }
  Assert ($r.Status -eq 200) "expected 200, got $($r.Status)"
  Assert ($r.Body.refreshToken.Length -eq 64) 'expected rotated 64-hex'
  $newRefresh = $r.Body.refreshToken
  $script:access = $r.Body.accessToken
  $r2 = CallApi 'POST' '/auth/refresh' @{ refreshToken = $script:refresh }
  Assert ($r2.Status -eq 401) "expected 401 theft, got $($r2.Status)"
  $script:refresh = $newRefresh
}

Step 'forgot-password anti-enum 200 (known + unknown identical)' {
  $a = CallApi 'POST' '/auth/forgot-password' @{ email = $email }
  $b = CallApi 'POST' '/auth/forgot-password' @{ email = "nobody-$ts@test.com" }
  Assert ($a.Status -eq 200 -and $b.Status -eq 200) "expected 200/200, got $($a.Status)/$($b.Status)"
  Assert ((GetBodyMessage $a.Body) -eq (GetBodyMessage $b.Body)) 'anti-enum: messages must match'
}

Step 'validate-reset garbage 400' {
  $r = CallApi 'POST' '/auth/validate-reset-token' @{ email = $email; token = ('a' * 64) }
  Assert ($r.Status -eq 400) "expected 400, got $($r.Status)"
}

Step 'verify-email garbage 400' {
  $r = CallApi 'POST' '/auth/verify-email' @{ email = $email; token = ('b' * 64) }
  Assert ($r.Status -eq 400) "expected 400, got $($r.Status)"
}

Step 'resend-verification 200 then cooldown 429' {
  $r = CallApi 'POST' '/auth/resend-verification' @{ email = $email }
  Assert ($r.Status -eq 200) "expected 200, got $($r.Status)"
  $r2 = CallApi 'POST' '/auth/resend-verification' @{ email = $email }
  Assert ($r2.Status -eq 429) "expected 429 cooldown, got $($r2.Status)"
}

Step 'OTP endpoints 501' {
  $r = CallApi 'POST' '/auth/otp/request' @{ phoneNumber = '+201000000001' }
  Assert ($r.Status -eq 501) "expected 501, got $($r.Status)"
}

Step 'logout 200 idempotent (twice)' {
  $r = CallApi 'POST' '/auth/logout' @{ refreshToken = $script:refresh }
  Assert ($r.Status -eq 200) "expected 200, got $($r.Status)"
  $r2 = CallApi 'POST' '/auth/logout' @{ refreshToken = $script:refresh }
  Assert ($r2.Status -eq 200) "expected 200 idempotent, got $($r2.Status)"
}

Step 'logout-all kills sessions (S-1 revocation check)' {
  $lr = CallApi 'POST' '/auth/login' @{ email = $email; password = $pass }
  Assert ($lr.Status -eq 200) 're-login failed'
  $a2 = $lr.Body.accessToken
  $f2 = $lr.Body.refreshToken
  $lo = CallApi 'POST' '/auth/logout-all' $null @{ Authorization = "Bearer $a2" }
  Assert ($lo.Status -eq 200) "expected 200, got $($lo.Status)"
  $rf = CallApi 'POST' '/auth/refresh' @{ refreshToken = $f2 }
  Assert ($rf.Status -eq 401) "expected 401 refresh-after-nuke, got $($rf.Status)"
  $me = CallApi 'GET' '/users/me' $null @{ Authorization = "Bearer $a2" }
  if ($EnforceRevocation) {
    Assert ($me.Status -eq 401) "S-1: expected 401 access-after-nuke, got $($me.Status)"
  } else {
    $script:Steps += "INFO  baseline: access-after-nuke status = $($me.Status) (S-1 will flip to 401)"
  }
}

Step 'rate-limit headers present on success' {
  $r = CallApi 'GET' '/users/me' $null @{ Authorization = "Bearer $script:access" }
  Assert ($r.Status -eq 200) 'expected 200'
  $hasLimit = ($null -ne $r.Headers['X-RateLimit-Limit']) -or ($null -ne $r.Headers['x-ratelimit-limit'])
  Assert ($hasLimit) 'expected X-RateLimit-Limit header'
}

Write-Host ''
Write-Host '==== e2e-auth-users summary ===='
$script:Steps | ForEach-Object { Write-Host $_ }
Write-Host "passed=$($script:Passed) failed=$($script:Failed)"
if ($script:Failed -gt 0) { exit 1 }
