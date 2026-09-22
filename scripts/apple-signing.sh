#!/usr/bin/env bash
# Create the key and certificate request Apple needs, then assemble the .p12 for CI.
#
# The usual route is Keychain Access -> Certificate Assistant, which puts the private key
# in the login keychain and then asks you to export it again. This does the same thing with
# openssl: the key is a file from the start, which is the shape CI needs, and every step is
# inspectable rather than a dialog.
#
#   scripts/apple-signing.sh csr       -> makes the key and the request to upload to Apple
#   scripts/apple-signing.sh p12 <cer> -> combines the key with Apple's certificate
#
# The key lives in ~/Datera-signing, never in the repository. Losing it means revoking the
# certificate and starting again; leaking it means someone else can sign software as you.

set -euo pipefail

DIR="$HOME/Datera-signing"
KEY="$DIR/developer-id.key"
CSR="$DIR/developer-id.csr"
P12="$DIR/developer-id.p12"
PW="$DIR/developer-id.p12.password"

case "${1:-}" in
csr)
  mkdir -p "$DIR"
  chmod 700 "$DIR"

  if [ -f "$KEY" ]; then
    echo "A key already exists at $KEY."
    echo "Reusing it would only make sense if you are replacing a revoked certificate."
    echo "Move it aside first if you really want a new one."
    exit 1
  fi

  # 2048-bit RSA: what Apple's Developer ID certificates use. The key is written with no
  # passphrase because CI cannot type one; the .p12 built later is what carries a password.
  umask 077
  openssl req -new -newkey rsa:2048 -nodes \
    -keyout "$KEY" \
    -out "$CSR" \
    -subj "/CN=Datera Developer ID/O=Datera/C=US" >/dev/null 2>&1

  chmod 600 "$KEY"

  echo "Created:"
  echo "  private key  $KEY   (keep this; it never leaves your machine except as the .p12)"
  echo "  request      $CSR"
  echo
  echo "Next, at https://developer.apple.com/account/resources/certificates/add"
  echo "  1. Choose 'Developer ID Application'."
  echo "  2. Under profile type choose 'G2 Sub-CA' if offered — it is the current one."
  echo "  3. Upload $CSR"
  echo "  4. Download the certificate it produces (developerID_application.cer)."
  echo
  echo "Then run: scripts/apple-signing.sh p12 ~/Downloads/developerID_application.cer"
  ;;

p12)
  cer="${2:-}"
  [ -n "$cer" ] && [ -f "$cer" ] || { echo "Usage: $0 p12 <developerID_application.cer>" >&2; exit 1; }

  # macOS restricts Downloads, Desktop and Documents per application. The file is visible
  # to stat and unopenable, so an existence check passes and openssl then fails with
  # "Operation not permitted" — which reads like a permissions bug in the script rather
  # than a privacy prompt that was never granted.
  if ! head -c 1 "$cer" >/dev/null 2>&1; then
    echo "macOS will not let this terminal read $cer." >&2
    echo >&2
    echo "Either move the file somewhere unrestricted — in Finder, drag it to your home" >&2
    echo "folder — or grant access: System Settings -> Privacy & Security -> Files and" >&2
    echo "Folders -> Terminal, and enable Downloads." >&2
    exit 1
  fi
  [ -f "$KEY" ] || { echo "No key at $KEY — run '$0 csr' first." >&2; exit 1; }

  # Apple hands back DER; openssl wants PEM to bundle it.
  pem="$DIR/developer-id.pem"
  openssl x509 -inform DER -in "$cer" -out "$pem"

  subject=$(openssl x509 -in "$pem" -noout -subject)
  echo "Certificate: $subject"
  echo "Expires:     $(openssl x509 -in "$pem" -noout -enddate | cut -d= -f2)"
  echo

  # Refuses early if the certificate does not belong to this key: a .p12 assembled from a
  # mismatched pair builds fine and fails at signing time, which is a long way from here.
  key_mod=$(openssl rsa -in "$KEY" -noout -modulus | openssl md5)
  cer_mod=$(openssl x509 -in "$pem" -noout -modulus | openssl md5)
  if [ "$key_mod" != "$cer_mod" ]; then
    echo "That certificate does not match $KEY. It was issued for a different request." >&2
    rm -f "$pem"
    exit 1
  fi

  # Generated, not chosen. This password only wraps the .p12 between here and GitHub —
  # nobody types it, and CI reads it from a secret. A human-chosen one would be weaker for
  # no benefit, and prompting made the script unusable anywhere without a terminal.
  #
  # It sits beside the key in a directory only you can read. That is not extra exposure:
  # anyone who can read the password file can already read the private key itself.
  pw=$(openssl rand -base64 24)
  printf '%s' "$pw" > "$PW"
  chmod 600 "$PW"

  # Apple's intermediate is included so the chain verifies on a machine that has never
  # seen it — which is every CI runner.
  intermediate="$DIR/apple-intermediate.pem"
  if ! curl -fsSL "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer" \
       | openssl x509 -inform DER -out "$intermediate" 2>/dev/null; then
    echo "Could not fetch Apple's intermediate certificate; building without it." >&2
    rm -f "$intermediate"
  fi

  # 3DES and a SHA-1 MAC, explicitly. OpenSSL 3 defaults to AES-256 with a SHA-256 MAC,
  # which macOS's `security import` cannot read at all — so the bundle builds, opens
  # correctly under openssl, and then fails with an opaque import error the first time
  # anything tries to sign with it. Named algorithms rather than -legacy, which also needs
  # the legacy provider loaded for RC2.
  openssl pkcs12 -export \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -inkey "$KEY" -in "$pem" \
    ${intermediate:+-certfile "$intermediate"} \
    -out "$P12" -passout "fd:3" 3<<<"$pw"

  chmod 600 "$P12" "$pem"
  unset pw

  # Proves the bundle opens with the password just written, before it is relied on. A .p12
  # that CI cannot unwrap fails minutes into a build, with an error about signing rather
  # than about this file.
  #
  # And proves macOS itself will import it — openssl opening the file is not the same
  # question, and was the one that gave a false pass.
  if ! openssl pkcs12 -in "$P12" -passin "file:$PW" -noout 2>/dev/null \
     && ! openssl pkcs12 -legacy -in "$P12" -passin "file:$PW" -noout 2>/dev/null; then
    echo "The .p12 was written but will not open with its own password." >&2
    exit 1
  fi

  # The check that matters: a throwaway keychain, the same call electron-builder makes.
  probe_keychain="$DIR/.import-probe.keychain"
  rm -f "$probe_keychain"
  security create-keychain -p probe "$probe_keychain" >/dev/null 2>&1
  if ! security import "$P12" -k "$probe_keychain" -P "$(cat "$PW")" -T /usr/bin/codesign >/dev/null 2>&1; then
    security delete-keychain "$probe_keychain" >/dev/null 2>&1 || true
    echo "macOS will not import $P12 — signing would fail wherever it is used." >&2
    exit 1
  fi
  security delete-keychain "$probe_keychain" >/dev/null 2>&1 || true

  echo
  echo "Built $P12 (verified openssl opens it and macOS imports it)"
  echo "Password stored at $PW — set-signing-secrets.sh reads it from there."
  echo
  echo "Next: scripts/set-signing-secrets.sh $P12 <AuthKey_XXXXXXXXXX.p8> <issuer-id>"
  ;;

*)
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
