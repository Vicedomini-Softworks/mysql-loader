#!/usr/bin/env bash

FILE="$1"
USER="admin"
PASS="secret"
URL="http://localhost:3000/api/upload"

if [ -z "$FILE" ]; then
  echo "Usage: $0 <file>"
  exit 1
fi

FILESIZE=$(stat -c%s "$FILE")

echo "Uploading $FILE"
echo ""

pv -p -t -e -r -a -b -s "$FILESIZE" "$FILE" | \
curl -u "$USER:$PASS" \
     -X POST \
     --upload-file - \
     "$URL"

echo ""
echo "Upload completed."
