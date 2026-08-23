#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
# Sertifikat HTTPS dev kedaluwarsa tiap ~30 hari dan membuat Office memblokir
# panel. Periksa dulu; perbarui otomatis bila tidak valid (mungkin diminta
# password Mac).
if ! npx office-addin-dev-certs verify >/dev/null 2>&1; then
  echo "Sertifikat HTTPS tidak valid atau kedaluwarsa. Memperbarui..."
  npm run cert:office
fi
echo "Menjalankan Tantular Companion di https://localhost:3000"
echo "Biarkan jendela ini tetap terbuka selama workshop."
TANTULAR_ALLOWED_ORIGINS="https://office.tantular.ai" npm start
