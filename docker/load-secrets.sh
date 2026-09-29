# shellcheck shell=bash
# Sourced by the entrypoint and by the `genie` wrapper: NAME_FILE=/run/secrets/x  →  NAME=<contents>.
#
# Docker/Compose secrets are files; provider keys and tokens are read from environment variables.
# Only names ending in _API_KEY, _TOKEN, _PASSWORD or _SECRET are converted. An explicitly set NAME wins
# over NAME_FILE. Everything the server exports reaches the agents it starts.
#
#   load_secrets strict   an unreadable file is an error (start-up)
#   load_secrets          an unreadable file is skipped (`docker exec` as a user who cannot read it)
load_secrets() {
  local var base file
  for var in $(compgen -e); do
    case "$var" in
      AWS_WEB_IDENTITY_TOKEN_FILE) continue ;; # a standard AWS variable that already means "a file"
      [A-Z]*_API_KEY_FILE | [A-Z]*_TOKEN_FILE | [A-Z]*_PASSWORD_FILE | [A-Z]*_SECRET_FILE) ;;
      *) continue ;;
    esac
    base="${var%_FILE}"
    [ -z "${!base:-}" ] || continue
    file="${!var}"
    if [ -f "$file" ] && [ -r "$file" ]; then
      export "$base=$(<"$file")"
    elif [ "${1:-}" = strict ]; then
      echo "genie-entrypoint: error: $var points to '$file', which is not a readable file" >&2
      return 1
    fi
  done
}
