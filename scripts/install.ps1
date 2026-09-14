# Installs the Hotlap CLI from a GitHub Release archive on Windows. Needs
# only PowerShell 5.1+; no Node, npm, or compiler.
#
#   irm https://raw.githubusercontent.com/shwarmadev/hotlap/main/scripts/install.ps1 | iex
#
# Environment:
#   HOTLAP_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   HOTLAP_VERSION           exact version to install (overrides HOTLAP_CHANNEL)
#   HOTLAP_HOME              Hotlap home directory (default: ~\.hotlap)
#   HOTLAP_INSTALL_BIN_DIR   where hotlap.cmd is written (default: ~\.local\bin)
#   HOTLAP_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $HOTLAP_HOME\runtime\versions\<version>, the
# same layout `hotlap service install` uses, so the service reuses this download.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "shwarmadev/hotlap"
$baseUrl = if ($env:HOTLAP_RELEASE_BASE_URL) { $env:HOTLAP_RELEASE_BASE_URL.TrimEnd("/") } else { "https://github.com/$repo/releases/download" }
$hotlapHome = if ($env:HOTLAP_HOME) { $env:HOTLAP_HOME } else { Join-Path $HOME ".hotlap" }
$binDir = if ($env:HOTLAP_INSTALL_BIN_DIR) { $env:HOTLAP_INSTALL_BIN_DIR } else { Join-Path $HOME ".local\bin" }

function Fail([string] $message) {
  Write-Error "hotlap install: $message"
  exit 1
}

# PROCESSOR_ARCHITEW6432 reports the real machine when a 32-bit PowerShell
# runs under WOW64; RuntimeInformation needs .NET 4.7.1+, which 5.1 hosts
# may lack.
$rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($rawArch) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { Fail "unsupported architecture $rawArch" }
}

$channel = if ($env:HOTLAP_CHANNEL) { $env:HOTLAP_CHANNEL } else { "stable" }
$version = $env:HOTLAP_VERSION
function Assert-Version([string] $value) {
  $core = '(0|[1-9][0-9]*)'
  $identifier = '(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
  if ($value -cnotmatch "\A$core\.$core\.$core(-$identifier(\.$identifier)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?\z") {
    Fail "HOTLAP_VERSION must be a valid semantic version"
  }
}
if ($version) { Assert-Version $version }
if (-not $version) {
  # Tags are v<semver>; the channel is the prerelease identifier, or none for
  # stable. Only tags of the requested train are considered, so a stable
  # install can never pick up a nightly or preview build by accident.
  $tagPattern = switch ($channel) {
    "stable" { '^v\d+\.\d+\.\d+$' }
    "nightly" { '^v\d+\.\d+\.\d+-nightly\.\d+\.\d+$' }
    "preview" { '^v\d+\.\d+\.\d+-preview\.\d+\.\d+$' }
    default { Fail "HOTLAP_CHANNEL must be stable, nightly, or preview" }
  }
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -Headers @{ "User-Agent" = "hotlap-install" }
  $tag = ($releases | Where-Object { -not $_.draft -and $_.tag_name -match $tagPattern } | Select-Object -First 1).tag_name
  if (-not $tag) { Fail "could not find a $channel release; set HOTLAP_VERSION" }
  $version = $tag.Substring(1)
}
Assert-Version $version
if ($version -match '-preview\.') {
  Write-Warning "hotlap $version is a preview build. Preview builds are cut by maintainers from unreleased branches to exercise the release pipeline. They can be broken, receive no fixes, and are never offered as updates. Set HOTLAP_CHANNEL=stable (the default) for a supported build."
  if ($channel -ne "preview" -and -not $env:HOTLAP_VERSION) {
    Fail "refusing a preview build that was not explicitly requested"
  }
}

$stem = "hotlap-$version-win32-$arch"
$archive = "$stem.zip"
$versionsDir = Join-Path $hotlapHome "runtime\versions"
$targetDir = Join-Path $versionsDir $version
$marker = Join-Path $targetDir ".install-complete"

if ((Test-Path $marker -PathType Leaf) -and ((Get-Content $marker -Raw).Trim() -eq $version) -and (Test-Path (Join-Path $targetDir "t3.exe") -PathType Leaf)) {
  Write-Host "hotlap $version is already installed at $targetDir"
} else {
  if (Test-Path $targetDir) {
    Fail "$targetDir already exists with another or incomplete runtime layout; leave it intact and use the existing Hotlap installation"
  }
  New-Item -ItemType Directory -Force -Path $versionsDir | Out-Null
  $staging = Join-Path $versionsDir (".staging-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    Write-Host "Downloading $archive..."
    try {
      Invoke-WebRequest -Uri "$baseUrl/v$version/SHA256SUMS" -OutFile (Join-Path $staging "SHA256SUMS") -UseBasicParsing
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      if ($status -eq 404) {
        Fail "hotlap $version has no release archive for win32-$arch; releases before the self-contained CLI can only be installed with 'npm install -g hotlap@$version'"
      }
      throw
    }
    Invoke-WebRequest -Uri "$baseUrl/v$version/$archive" -OutFile (Join-Path $staging $archive) -UseBasicParsing

    $expected = (Get-Content (Join-Path $staging "SHA256SUMS") | Where-Object { $_ -match "\s\*?$([regex]::Escape($archive))$" } | Select-Object -First 1)
    if (-not $expected) { Fail "$archive is not listed in SHA256SUMS" }
    $expected = ($expected -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $staging $archive)).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Fail "checksum mismatch for $archive" }

    Expand-Archive -Path (Join-Path $staging $archive) -DestinationPath $staging -Force
    # The archive wraps everything in one directory named after its stem.
    Get-ChildItem (Join-Path $staging $stem) | Move-Item -Destination $staging
    Remove-Item (Join-Path $staging $stem), (Join-Path $staging $archive), (Join-Path $staging "SHA256SUMS") -Recurse -Force

    & (Join-Path $staging "t3.exe") --version | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "the downloaded executable does not run" }
    Set-Content -Path (Join-Path $staging ".install-complete") -Value $version -NoNewline

    # Directory.Move fails if another installer created this destination;
    # unlike Move-Item it never nests inside or replaces an existing runtime.
    [System.IO.Directory]::Move($staging, $targetDir)
  } catch {
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    throw
  }
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir "hotlap.cmd"
# UTF-8 without a BOM: cmd.exe reads the shim as-is, and ASCII would corrupt
# non-ASCII characters in the user's home path.
[System.IO.File]::WriteAllText($shim, "@echo off`r`n`"$(Join-Path $targetDir 't3.exe')`" %*", (New-Object System.Text.UTF8Encoding $false))
Write-Host "Installed hotlap $version"
Write-Host "  $shim -> $(Join-Path $targetDir 't3.exe')"
if (($env:PATH -split ";") -notcontains $binDir) {
  Write-Host "Add $binDir to your PATH to run hotlap."
}
