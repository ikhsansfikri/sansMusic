# GANTI: Gunakan Alpine Linux (Jauh lebih kecil & cepat)
FROM node:20-alpine

# Set folder kerja
WORKDIR /usr/src/app

# INSTALASI PAKET SISTEM (OPTIMALISASI)
# 1. python3: Wajib untuk yt-dlp
# 2. ffmpeg: Wajib untuk pemrosesan audio (apk add ffmpeg di alpine sangat cepat)
# 3. build-base & python3-dev: Diperlukan HANYA saat 'npm install' untuk compile library sodium/opus
#    (Kita gunakan trik --virtual agar bisa dihapus setelah npm install selesai untuk menghemat size)
RUN apk add --no-cache python3 ffmpeg \
    && apk add --no-cache --virtual .build-deps build-base python3-dev

# Copy package.json dulu (Memanfaatkan Docker Layer Caching)
COPY package*.json ./

# Install dependency Node.js
# Jika ada error 'gyp', build-deps di atas akan menanganinya
RUN npm install

# HAPUS build-deps agar image tetap kecil (Cleanup)
RUN apk del .build-deps

# Copy sisa kode
COPY . .

# Jalankan bot
CMD ["node", "index.js"]