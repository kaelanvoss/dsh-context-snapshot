param(
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime = 'win-x64',
    [switch]$SkipSelfTest
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path $PSScriptRoot -Parent
$projectPath = Join-Path $pluginRoot 'native/windows/ContextSnapshot.csproj'
$publishPath = Join-Path $pluginRoot "native/windows/publish/$Runtime"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'Install the .NET 8 SDK before building the Windows snapshot helper.'
}

dotnet build $projectPath --configuration Release
if ($LASTEXITCODE -ne 0) { throw 'Windows helper compilation failed.' }

dotnet run --project (Join-Path $pluginRoot 'native/windows/tests/PolicyTests.csproj') --configuration Release
if ($LASTEXITCODE -ne 0) { throw 'Windows gesture/target policy checks failed.' }

if (-not $SkipSelfTest) {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'The self-test executable requires Windows. Use -SkipSelfTest only for cross-compilation.'
    }
    dotnet run --project $projectPath --configuration Release --no-build -- --self-test
    if ($LASTEXITCODE -ne 0) { throw 'Windows helper self-test failed.' }
}

dotnet publish $projectPath --configuration Release --runtime $Runtime --self-contained true --output $publishPath
if ($LASTEXITCODE -ne 0) { throw "Windows helper publication failed for $Runtime." }

# Query the packs resolved for this publication. Do not guess the runtime
# version from the SDK version, a global NuGet directory, or a latest tag.
$packOutput = & dotnet msbuild $projectPath -nologo -target:ResolveFrameworkReferences `
    -property:Configuration=Release "-property:RuntimeIdentifier=$Runtime" `
    -property:SelfContained=true -getItem:ResolvedRuntimePack
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve runtime packs for license collection.' }
$packMetadata = ($packOutput -join "`n") | ConvertFrom-Json
$corePacks = @($packMetadata.Items.ResolvedRuntimePack | Where-Object {
    $_.FrameworkName -eq 'Microsoft.NETCore.App' -and $_.RuntimeIdentifier -eq $Runtime
})
$desktopPacks = @($packMetadata.Items.ResolvedRuntimePack | Where-Object {
    $_.FrameworkName -eq 'Microsoft.WindowsDesktop.App' -and $_.RuntimeIdentifier -eq $Runtime
})
if ($corePacks.Count -ne 1 -or $desktopPacks.Count -ne 1) {
    throw 'Expected one .NET runtime pack and one Windows Desktop runtime pack.'
}
$corePack = $corePacks[0]
$desktopPack = $desktopPacks[0]
foreach ($pack in @($corePack, $desktopPack)) {
    if ($pack.NuGetPackageVersion -notmatch '^\d+\.\d+\.\d+$' -or
        -not (Test-Path -LiteralPath $pack.PackageDirectory -PathType Container)) {
        throw 'Resolved runtime pack metadata is incomplete; license collection stopped.'
    }
}

$noticePath = Join-Path $publishPath 'third-party'
New-Item -ItemType Directory -Path $noticePath -Force | Out-Null
function Get-NoticeSha256([string]$Path) {
    # Hash directly through .NET so nested Windows PowerShell / pwsh sessions
    # do not depend on a compatible Microsoft.PowerShell.Utility module path.
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        $hash = $algorithm.ComputeHash($stream)
        return [BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $algorithm.Dispose()
    }
}
function Copy-RequiredNotice([string]$Source, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required third-party notice was not found: $Name"
    }
    Copy-Item -LiteralPath $Source -Destination (Join-Path $noticePath $Name) -Force
}
Copy-RequiredNotice (Join-Path $corePack.PackageDirectory 'LICENSE.TXT') 'DOTNET-LICENSE.txt'
Copy-RequiredNotice (Join-Path $corePack.PackageDirectory 'THIRD-PARTY-NOTICES.TXT') 'DOTNET-THIRD-PARTY-NOTICES.txt'
Copy-RequiredNotice (Join-Path $desktopPack.PackageDirectory 'LICENSE') 'WINDOWSDESKTOP-LICENSE.txt'

$desktopVersion = $desktopPack.NuGetPackageVersion
$wpfSource = "https://raw.githubusercontent.com/dotnet/wpf/v$desktopVersion/THIRD-PARTY-NOTICES.TXT"
$wpfTarget = Join-Path $noticePath 'WPF-THIRD-PARTY-NOTICES.txt'
$bundledNotices = Join-Path $pluginRoot 'native/windows/third-party'
$bundledManifest = Get-Content -LiteralPath (Join-Path $bundledNotices 'manifest.json') -Raw | ConvertFrom-Json
if ($bundledManifest.windowsDesktopVersion -eq $desktopVersion -and
    $bundledManifest.sources.wpf -eq $wpfSource) {
    $bundledWpf = Join-Path $bundledNotices 'WPF-THIRD-PARTY-NOTICES.txt'
    $bundledHash = Get-NoticeSha256 $bundledWpf
    if ($bundledHash -ne $bundledManifest.sha256.'WPF-THIRD-PARTY-NOTICES.txt') {
        throw 'The bundled version-matched WPF notice failed its integrity check.'
    }
    Copy-RequiredNotice $bundledWpf 'WPF-THIRD-PARTY-NOTICES.txt'
} else {
    # An SDK/runtime update must fetch the corresponding official release tag.
    # A missing tag or network error fails publication instead of omitting rights.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $wpfSource -UseBasicParsing -OutFile $wpfTarget
}
$wpfContent = Get-Content -LiteralPath $wpfTarget -Raw
if ($wpfContent.Length -lt 100 -or -not $wpfContent.StartsWith('.NET Core uses third-party')) {
    throw 'The version-matched WPF response is not a third-party notice.'
}

$noticeHashes = [ordered]@{}
foreach ($name in @('DOTNET-LICENSE.txt', 'DOTNET-THIRD-PARTY-NOTICES.txt', 'WINDOWSDESKTOP-LICENSE.txt', 'WPF-THIRD-PARTY-NOTICES.txt')) {
    $noticeHashes[$name] = Get-NoticeSha256 (Join-Path $noticePath $name)
}
$noticeManifest = [ordered]@{
    schemaVersion = 1
    runtimeIdentifier = $Runtime
    runtimeVersion = $corePack.NuGetPackageVersion
    windowsDesktopVersion = $desktopVersion
    sources = [ordered]@{
        runtime = "https://www.nuget.org/packages/$($corePack.NuGetPackageId)/$($corePack.NuGetPackageVersion)"
        windowsDesktop = "https://www.nuget.org/packages/$($desktopPack.NuGetPackageId)/$desktopVersion"
        wpf = $wpfSource
    }
    sha256 = $noticeHashes
}
$manifestText = ($noticeManifest | ConvertTo-Json -Depth 5) + "`n"
[IO.File]::WriteAllText((Join-Path $noticePath 'manifest.json'), $manifestText, [Text.UTF8Encoding]::new($false))
Write-Host "Collected .NET $($corePack.NuGetPackageVersion) / Windows Desktop $desktopVersion licenses and notices."
Write-Host "Built $publishPath/ContextSnapshot.exe"
