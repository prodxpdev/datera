#!/usr/bin/env bash
# Store macOS signing and notarization credentials as GitHub Actions secrets.
#
# Every value is read from a file or a hidden prompt and piped straight into `gh secret
# set`. Nothing is echoed, logged, or passed as a command-line argument — arguments show
# up in `ps` and in shell history, and a private key that has been in either is a key you
# have to revoke.
#
# Usage:
#   scripts/set-signing-secrets.sh <certificate.p12> <AuthKey_XXXXXXXXXX.p8> <issuer-id>
#
# Where each comes from:
#   certificate.p12   Keychain Access -> your "Developer ID Application" certificate ->
#                     right-click -> Export, as .p12, with a password you choose.
#   AuthKey_*.p8      App Store Connect -> Users and Access -> Integrations -> App Store
#                     Connect API -> generate a key with the Developer role. Apple lets you
#                     download it exactly once. The key ID is the part of the file name
#                     between "AuthKey_" and ".p8".
#   issuer-id         Shown at the top of that same App Store Connect API page.

set -euo pipefail

REPO="prodxpdev/datera"

if [ "$#" -ne 3 ]; then
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

p12="$1"
p8="$2"
issuer="$3"

for f in "$p12" "$p8"; do
  [ -f "$f" ] || { echo "Not found: $f" >&2; exit 1; }
done

key_id=$(basename "$p8" | sed -n 's/^AuthKey_\(.*\)\.p8$/\1/p')
if [ -z "$key_id" ]; then
  echo "Expected the key file to be named AuthKey_<KEYID>.p8, as Apple names it." >&2
  exit 1
fi

# Written beside the .p12 by apple-signing.sh. Prompted for only when that file is not
# there — a .p12 exported by hand from Keychain Access has a password only you know.
if [ -f "$p12.password" ]; then
  cert_password=$(cat "$p12.password")
else
  read -r -s -p "Password for $p12: " cert_password
  echo
fi

# Checked before anything is stored: a wrong password would otherwise surface only as a
# failed CI run, long after this script reported success.
if ! openssl pkcs12 -in "$p12" -passin "fd:3" -noout 3<<<"$cert_password" 2>/dev/null \
   && ! openssl pkcs12 -legacy -in "$p12" -passin "fd:3" -noout 3<<<"$cert_password" 2>/dev/null; then
  echo "That password does not open $p12 — nothing was stored." >&2
  exit 1
fi

base64 < "$p12" | tr -d '\n' | gh secret set MAC_CERT_P12_BASE64 --repo "$REPO"
printf '%s' "$cert_password" | gh secret set MAC_CERT_PASSWORD --repo "$REPO"
gh secret set APPLE_API_KEY_P8 --repo "$REPO" < "$p8"
printf '%s' "$key_id" | gh secret set APPLE_API_KEY_ID --repo "$REPO"
printf '%s' "$issuer" | gh secret set APPLE_API_ISSUER --repo "$REPO"

unset cert_password

echo
echo "Stored five secrets on $REPO:"
gh secret list --repo "$REPO" | grep -E 'MAC_CERT|APPLE_API' || true
echo
echo "The next packaging run will sign and notarize. Keep the .p8 somewhere safe or"
echo "delete it — Apple will not let you download it again, and GitHub now has a copy."
