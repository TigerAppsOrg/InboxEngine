#!/bin/bash
# Executed as root by the InboxEngineDeploy SSM document on the-forum-web.
# Layout: /opt/inbox-engine/{releases/<sha>,current,shared/environment}; systemd inbox-engine.service.
set -euo pipefail
release=${1:?Commit SHA required}
[[ "$release" =~ ^[a-f0-9]{40}$ ]] || exit 2
root=/opt/inbox-engine
dir="$root/releases/$release"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
export AWS_DEFAULT_REGION=us-east-1

id -u inbox-engine >/dev/null 2>&1 || useradd --system --home "$root" --shell /usr/sbin/nologin inbox-engine
mkdir -p "$root/shared"
# Secrets come from one encrypted parameter; never echo them.
umask 077
aws ssm get-parameter --name /inbox-engine/production/environment --with-decryption \
  --query Parameter.Value --output text > "$root/shared/environment.next"
mv -f "$root/shared/environment.next" "$root/shared/environment"
chown root:inbox-engine "$root/shared/environment"; chmod 0640 "$root/shared/environment"
umask 022

cd "$dir"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root "$dir"
# Migrations run before traffic moves; they are additive and idempotent.
# Node parses the env file itself; shell-sourcing breaks on secrets with $, ! or spaces.
node --env-file="$root/shared/environment" --import tsx src/store/migrate.ts
# Relabel stored messages once per classifier version (no-op otherwise).
node --env-file="$root/shared/environment" --import tsx scripts/reclassify.ts

previous=$(readlink -f "$root/current" || true)
ln -sfn "$dir" "$root/current.next" && mv -Tf "$root/current.next" "$root/current"
install -m 0644 deploy/inbox-engine.service /etc/systemd/system/inbox-engine.service
systemctl daemon-reload
systemctl enable inbox-engine.service >/dev/null
systemctl restart inbox-engine.service

healthy=false
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8300/healthz >/dev/null 2>&1; then healthy=true; break; fi
  sleep 2
done
if [ "$healthy" != true ]; then
  echo 'Health check failed; rolling back.'
  journalctl -u inbox-engine.service -n 40 --no-pager || true
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    ln -sfn "$previous" "$root/current.next" && mv -Tf "$root/current.next" "$root/current"
    systemctl restart inbox-engine.service
  fi
  exit 1
fi
# Unauthenticated API access must be refused.
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8300/v1/status)
[ "$code" = 401 ] || { echo "Expected 401 from /v1/status without a token, got $code"; exit 1; }

install -m 0644 deploy/nginx.conf /etc/nginx/sites-available/inbox-engine
ln -sfn /etc/nginx/sites-available/inbox-engine /etc/nginx/sites-enabled/inbox-engine
nginx -t && systemctl reload nginx
printf '%s\n' "$release" > "$root/shared/deployed-sha"
# Keep the five newest releases.
ls -1dt "$root"/releases/*/ | tail -n +6 | xargs -r rm -rf --
echo "InboxEngine $release deployed."
