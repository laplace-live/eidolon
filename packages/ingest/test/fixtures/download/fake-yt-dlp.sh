#!/bin/sh
# Stands in for yt-dlp in the download tests, for Python's download_urls and the TS port alike.
# Appends its argv to $FAKE_YTDLP_LOG (the count, then each argument, every one NUL-terminated),
# then acts out the scenario its last argument, the URL, names.
log=${FAKE_YTDLP_LOG:?}
printf '%s\0' "$#" "$@" >> "$log"

template=
prev=
url=
for arg in "$@"; do
  if [ "$prev" = "-o" ] && [ -z "$template" ]; then template=$arg; fi
  prev=$arg
  url=$arg
done
dir=${template%/*}

# The audio and its info.json, as yt-dlp names them.
make() {
  printf '{"id": "%s", "upload_date": "20260814"}\n' "$1" > "$dir/$1.info.json"
  printf 'audio %s\n' "$1" > "$dir/$1.m4a"
}

name=${url#https://example.invalid/}
case $name in
  ok/*) make "${name#ok/}" ;;
  exists/*) ;;
  fallback/*) make "${name#fallback/}" ;;
  parts/*)
    rest=${name#parts/}
    id=${rest%/*}
    i=1
    while [ "$i" -le "${rest##*/}" ]; do
      make "${id}_p$i"
      i=$((i + 1))
    done
    ;;
  warn) printf 'WARNING: [BiliBili] a warning\nWARNING: another one\n' >&2 ;;
  fail/*)
    i=1
    while [ "$i" -le "${name#fail/}" ]; do
      printf 'WARNING: line %s\n' "$i" >&2
      i=$((i + 1))
    done
    exit 1
    ;;
  quiet) exit 2 ;;
  412)
    cat >&2 <<'EOF'
WARNING: Your yt-dlp version (2026.06.09) is older than 90 days!
         It is strongly recommended to always use the latest version.
         You installed yt-dlp with pip or using the wheel from PyPi; Use that to update.
         To suppress this warning, add --no-update to your command/config.
ERROR: [BiliBili] 1c3YJ6VETN: Unable to download JSON metadata: HTTP Error 412: Precondition Failed (caused by <HTTPError 412: Precondition Failed>)
ERROR: [BiliBili] 1c3YJ6VETN: Unable to download JSON metadata: HTTP Error 412: Precondition Failed (caused by <HTTPError 412: Precondition Failed>)
EOF
    exit 1
    ;;
  crlf)
    printf '  WARNING: a  \r\n\r\nERROR: b\r\n \r\n' >&2
    exit 1
    ;;
  unicode)
    printf '警告：一\034二\342\200\250三\n' >&2
    exit 1
    ;;
  cookies)
    printf 'ERROR: could not find chrome cookies database in "/nonexistent"\n' >&2
    exit 1
    ;;
  kill)
    printf 'about to die\n' >&2
    kill -9 $$
    ;;
  progress/*)
    id=${name#progress/}
    printf '[download] Destination: %s\n' "$dir/$id.m4a"
    printf '[eidolon] ["%s",1024,4096,null]\n' "$id"
    printf '[eidolon] ["%s",4096,null,8192.5]\n' "$id"
    printf '[eidolon] not json\n'
    make "$id"
    ;;
  playlist/*)
    i=1
    while [ "$i" -le "${name#playlist/}" ]; do
      printf 'https://www.bilibili.com/video/BV1eeeeeeee%s\n' "$i"
      i=$((i + 1))
    done
    printf 'WARNING: a warning on stderr\n' >&2
    ;;
  hang) exec sleep 30 ;;
  *)
    printf "ERROR: [generic] '%s' is not a valid URL\n" "$url" >&2
    exit 1
    ;;
esac
exit 0
