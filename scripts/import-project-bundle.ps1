<#
.SYNOPSIS
  Import a single-project GlobalCRM deployment bundle on a local team machine (Windows PowerShell).
.DESCRIPTION
  Verifies SHA-256 checksums, installs the machine-local .env.production, restores MongoDB,
  uploads, knowledge index, and optional shared knowledge runtime into an isolated Docker Compose
  project, then builds and starts GlobalCRM.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$BundleDir = $PSScriptRoot,

  [Parameter(Mandatory = $false)]
  [string]$RepoDir = (Get-Location).Path,

  [Parameter(Mandatory = $false)]
  [string]$KnowledgeRuntimePath = "",

  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$BundleDir = (Resolve-Path $BundleDir).Path
$RepoDir = (Resolve-Path $RepoDir).Path

$manifestPath = Join-Path $BundleDir "bundle-manifest.json"
if (-not (Test-Path $manifestPath)) {
  throw "bundle-manifest.json not found in $BundleDir"
}
if (-not (Test-Path (Join-Path $RepoDir "compose.yaml"))) {
  throw "compose.yaml not found in RepoDir: $RepoDir. Run from the GlobalCRM repo root or pass -RepoDir."
}

$manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json
$composeProject = [string]$manifest.composeProjectName
$httpPort = [int]$manifest.httpPort
$projectName = [string]$manifest.project.name

Write-Host "=== GlobalCRM Single-Project Import: $projectName ($composeProject) ===" -ForegroundColor Cyan

# 1. Verify SHA-256 checksums
Write-Host "[1/7] Verifying bundle file checksums..."
foreach ($prop in $manifest.files.PSObject.Properties) {
  $fileName = $prop.Name
  $expectedSha = [string]$prop.Value.sha256
  $filePath = Join-Path $BundleDir $fileName
  if (-not (Test-Path $filePath)) {
    throw "Missing required bundle file: $filePath"
  }
  $actualSha = (Get-FileHash -Algorithm SHA256 -Path $filePath).Hash.ToLowerInvariant()
  if ($actualSha -ne $expectedSha.ToLowerInvariant()) {
    throw "Checksum mismatch for ${fileName}: expected $expectedSha, got $actualSha"
  }
}
Write-Host "  All bundle checksums verified." -ForegroundColor Green

# 2. Check Docker availability
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop is not running. Please start Docker Desktop and re-run."
}

# 3. Install .env.production
$targetEnv = Join-Path $RepoDir ".env.production"
if ((Test-Path $targetEnv) -and (-not $Force)) {
  throw ".env.production already exists at $targetEnv. Back it up or re-run with -Force to replace."
}
Write-Host "[2/7] Installing machine-local .env.production..."
Copy-Item -Force (Join-Path $BundleDir ".env.production") $targetEnv

Push-Location $RepoDir
try {
  # 4. Start MongoDB container first
  Write-Host "[3/7] Starting isolated MongoDB container ($composeProject)..."
  docker compose -p $composeProject --env-file .env.production up -d --wait mongo
  if ($LASTEXITCODE -ne 0) { throw "Failed to start mongo service." }

  $mongoContainer = (docker compose -p $composeProject --env-file .env.production ps -q mongo).Trim()
  if (-not $mongoContainer) { throw "Could not locate running mongo container." }

  # Guard against overwriting an already-populated database unless -Force
  $existingCount = (docker exec $mongoContainer bash -c 'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin cdlm --eval "db.getCollectionNames().length"').Trim()
  if ([int]$existingCount -gt 0 -and (-not $Force)) {
    throw "Target MongoDB database 'cdlm' already has $existingCount collections. Pass -Force to drop and restore."
  }

  # 5. Restore MongoDB BSON dump
  Write-Host "[4/7] Restoring MongoDB database (cdlm)..."
  $mongoDumpHost = Join-Path $BundleDir "mongo-dump.tar.gz"
  docker cp $mongoDumpHost "${mongoContainer}:/tmp/mongo-dump.tar.gz"
  $dropFlag = if ($Force) { "--drop" } else { "" }
  docker exec $mongoContainer bash -ec "rm -rf /tmp/gcrm_restore && mkdir -p /tmp/gcrm_restore && tar -xzf /tmp/mongo-dump.tar.gz -C /tmp/gcrm_restore && mongorestore --username `"`$MONGO_INITDB_ROOT_USERNAME`" --password `"`$MONGO_INITDB_ROOT_PASSWORD`" --authenticationDatabase admin --db cdlm $dropFlag /tmp/gcrm_restore/cdlm && rm -rf /tmp/gcrm_restore /tmp/mongo-dump.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw "mongorestore failed." }

  # 6. Restore uploads, knowledge_index, and optional knowledge_runtime volumes
  Write-Host "[5/7] Restoring Docker data volumes..."
  function Restore-DockerVolume {
    param([string]$VolumeName, [string]$ArchivePath, [string]$ChownSpec = "")
    docker volume create $VolumeName | Out-Null
    $absArchive = (Resolve-Path $ArchivePath).Path
    $archiveDir = Split-Path -Parent $absArchive
    $archiveName = Split-Path -Leaf $absArchive
    $chownCmd = if ($ChownSpec) { " && chown -R $ChownSpec /target" } else { "" }
    docker run --rm -v "${VolumeName}:/target" -v "${archiveDir}:/src:ro" alpine:3.20 sh -ec "rm -rf /target/* /target/.[!.]* 2>/dev/null || true; tar -xzf /src/${archiveName} -C /target${chownCmd}"
    if ($LASTEXITCODE -ne 0) { throw "Failed restoring volume $VolumeName from $ArchivePath" }
  }

  Restore-DockerVolume -VolumeName "${composeProject}_uploads" -ArchivePath (Join-Path $BundleDir "uploads.tar.gz") -ChownSpec "1000:1000"

  $kIndexArchive = Join-Path $BundleDir "knowledge-index.tar.gz"
  if (Test-Path $kIndexArchive) {
    Restore-DockerVolume -VolumeName "${composeProject}_knowledge_index" -ArchivePath $kIndexArchive -ChownSpec "1000:1000"
  }

  if (-not $KnowledgeRuntimePath) {
    $candidates = @(
      (Join-Path $BundleDir "knowledge-runtime.tar.gz"),
      (Join-Path (Split-Path -Parent $BundleDir) "shared\knowledge-runtime.tar.gz")
    )
    foreach ($c in $candidates) {
      if (Test-Path $c) { $KnowledgeRuntimePath = $c; break }
    }
  }
  if ($KnowledgeRuntimePath -and (Test-Path $KnowledgeRuntimePath)) {
    Write-Host "  Loading shared local knowledge runtime from $KnowledgeRuntimePath..."
    Restore-DockerVolume -VolumeName "${composeProject}_knowledge_runtime" -ArchivePath $KnowledgeRuntimePath
  } else {
    Write-Host "  Shared knowledge-runtime.tar.gz not provided; local semantic search will remain optional." -ForegroundColor Yellow
  }

  # 7. Build and start full stack
  Write-Host "[6/7] Building and starting GlobalCRM services..."
  docker compose -p $composeProject --env-file .env.production up -d --build --wait
  if ($LASTEXITCODE -ne 0) { throw "docker compose up failed." }

  Write-Host "[7/7] Verifying health endpoint..."
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:${httpPort}/api/health" -TimeoutSec 20
  if ($health.data.status -ne "ok") {
    throw "Health check returned non-ok status: $($health | ConvertTo-Json -Compress)"
  }

  Write-Host ""
  Write-Host "GlobalCRM ($projectName) is ready!" -ForegroundColor Green
  Write-Host "  Open in browser: http://localhost:${httpPort}" -ForegroundColor Green
  Write-Host "  Compose project: $composeProject"
} finally {
  Pop-Location
}
