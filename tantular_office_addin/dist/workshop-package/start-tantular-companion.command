#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
echo "Menjalankan Tantular Companion di https://localhost:3000"
echo "Biarkan jendela ini tetap terbuka selama workshop."
TANTULAR_ALLOWED_ORIGINS="https://workshop-web-gamma.vercel.app" npm run dev
