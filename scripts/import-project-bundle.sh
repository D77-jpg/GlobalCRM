#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(pwd)"
KNOWLEDGE_RUNTIME=""
FORCE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-dir) BUNDLE_DIR="$(cd "$2" && pwd)"; shift 2 ;;
    --repo-dir) REPO_DIR="$(cd "$2" && pwd)"; shift 2 ;;
    --knowledge-runtime) KNOWLEDGE_RUNTIME="$2"; shift 2 ;;
    --force) FORCE="true"; shift ;;
    -h|--help)
      echo "Usage: bash import-project-bundle.sh --bundle-dir <bundle> --repo-dir <repo> [--knowledge-runtime <tar.gz>] [--force]"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

MANIFEST="${BUNDLE_DIR}/bundle-manifest.json"
[[ -f "$MANIFEST" ]] || { echo "Missing bundle-manifest.json in ${BUNDLE_DIR}" >&2; exit 1; }
[[ -f "${REPO_DIR}/compose.yaml" ]] || { echo "Missing compose.yaml in ${REPO_DIR}" >&2; exit 1; }

COMPOSE_PROJECT="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).composeProjectName)" "$MANIFEST")"
HTTP_PORT="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).httpPort)" "$MANIFEST")"
PROJECT_NAME="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).project.name)" "$MANIFEST")"

echo "=== GlobalCRM Single-Project Import: ${PROJECT_NAME} (${COMPOSE_PROJECT}) ==="

echo "[1/7] Verifying bundle checksums..."
node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const dir = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "bundle-manifest.json"), "utf8"));
for (const [name, info] of Object.entries(manifest.files)) {
  const fp = path.join(dir, name);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
  if (hash !== info.sha256) throw new Error(`Checksum mismatch for ${name}`);
}
' "$BUNDLE_DIR"

docker info >/dev/null 2>&1 || { echo "Docker daemon is not running." >&2; exit 1; }

TARGET_ENV="${REPO_DIR}/.env.production"
if [[ -f "$TARGET_ENV" && "$FORCE" != "true" ]]; then
  echo ".env.production already exists at ${TARGET_ENV}. Pass --force to replace." >&2
  exit 1
fi

echo "[2/7] Installing machine-local .env.production..."
cp "${BUNDLE_DIR}/.env.production" "$TARGET_ENV"
chmod 600 "$TARGET_ENV" || true

cd "$REPO_DIR"

echo "[3/7] Starting isolated MongoDB container (${COMPOSE_PROJECT})..."
docker compose -p "$COMPOSE_PROJECT" --env-file .env.production up -d --wait mongo
MONGO_CONTAINER="$(docker compose -p "$COMPOSE_PROJECT" --env-file .env.production ps -q mongo)"

EXISTING_COLLS="$(docker exec "$MONGO_CONTAINER" bash -c 'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin cdlm --eval "db.getCollectionNames().length"')"
if [[ "${EXISTING_COLLS}" -gt 0 && "$FORCE" != "true" ]]; then
  echo "Target database 'cdlm' already has ${EXISTING_COLLS} collections. Pass --force to drop and restore." >&2
  exit 1
fi

echo "[4/7] Restoring MongoDB database (cdlm)..."
docker cp "${BUNDLE_DIR}/mongo-dump.tar.gz" "${MONGO_CONTAINER}:/tmp/mongo-dump.tar.gz"
DROP_FLAG=""
[[ "$FORCE" == "true" ]] && DROP_FLAG="--drop"
docker exec "$MONGO_CONTAINER" bash -ec "rm -rf /tmp/gcrm_restore && mkdir -p /tmp/gcrm_restore && tar -xzf /tmp/mongo-dump.tar.gz -C /tmp/gcrm_restore && mongorestore --username \"\$MONGO_INITDB_ROOT_USERNAME\" --password \"\$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin --db cdlm ${DROP_FLAG} /tmp/gcrm_restore/cdlm && rm -rf /tmp/gcrm_restore /tmp/mongo-dump.tar.gz"

echo "[5/7] Restoring Docker data volumes..."
restore_volume() {
  local vol="$1"
  local archive="$2"
  local chown_spec="${3:-}"
  docker volume create "$vol" >/dev/null
  local adir aname
  adir="$(cd "$(dirname "$archive")" && pwd)"
  aname="$(basename "$archive")"
  local chown_cmd=""
  [[ -n "$chown_spec" ]] && chown_cmd=" && chown -R ${chown_spec} /target"
  docker run --rm -v "${vol}:/target" -v "${adir}:/src:ro" alpine:3.20 sh -ec "rm -rf /target/* /target/.[!.]* 2>/dev/null || true; tar -xzf /src/${aname} -C /target${chown_cmd}"
}

restore_volume "${COMPOSE_PROJECT}_uploads" "${BUNDLE_DIR}/uploads.tar.gz" "1000:1000"

if [[ -f "${BUNDLE_DIR}/knowledge-index.tar.gz" ]]; then
  restore_volume "${COMPOSE_PROJECT}_knowledge_index" "${BUNDLE_DIR}/knowledge-index.tar.gz" "1000:1000"
fi

if [[ -z "$KNOWLEDGE_RUNTIME" ]]; then
  if [[ -f "${BUNDLE_DIR}/knowledge-runtime.tar.gz" ]]; then
    KNOWLEDGE_RUNTIME="${BUNDLE_DIR}/knowledge-runtime.tar.gz"
  elif [[ -f "$(dirname "$BUNDLE_DIR")/shared/knowledge-runtime.tar.gz" ]]; then
    KNOWLEDGE_RUNTIME="$(dirname "$BUNDLE_DIR")/shared/knowledge-runtime.tar.gz"
  fi
fi

if [[ -n "$KNOWLEDGE_RUNTIME" && -f "$KNOWLEDGE_RUNTIME" ]]; then
  echo "  Loading shared local knowledge runtime from ${KNOWLEDGE_RUNTIME}..."
  restore_volume "${COMPOSE_PROJECT}_knowledge_runtime" "$KNOWLEDGE_RUNTIME"
fi

echo "[6/7] Building and starting GlobalCRM services..."
docker compose -p "$COMPOSE_PROJECT" --env-file .env.production up -d --build --wait

echo "[7/7] Verifying health endpoint..."
curl -fsS "http://127.0.0.1:${HTTP_PORT}/api/health" >/dev/null

echo ""
echo "GlobalCRM (${PROJECT_NAME}) is ready!"
echo "  Open in browser: http://localhost:${HTTP_PORT}"
echo "  Compose project: ${COMPOSE_PROJECT}"
