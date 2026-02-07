FROM node:20-alpine

WORKDIR /usr/src/app

# 1. Install FFmpeg (Fix error: FFmpeg not found)
# 2. Install Python3 & PIP (Agar bisa install yt-dlp terbaru)
RUN apk add --no-cache ffmpeg python3 py3-pip

# 3. Install yt-dlp lewat PIP (Fix error: 403 Forbidden)
# Kita gunakan flag --break-system-packages karena di Alpine terbaru aturan pip diperketat
RUN pip3 install yt-dlp --break-system-packages

# Copy package
COPY package.json ./

# Install dependency Node.js
RUN npm install --omit=dev

# Copy sisa kode
COPY . .

# Jalankan bot
CMD ["node", "src/index.js"]