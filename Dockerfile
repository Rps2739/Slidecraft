# Slidecraft — HTML/PDF/PPTX/image -> editable PowerPoint converter (web UI).
#
#   docker build -t slidecraft .
#   docker run -p 4599:4599 slidecraft        ->  http://localhost:4599
#
# Cloud/Linux notes:
#  - HOST=0.0.0.0 is REQUIRED in a container (the server binds loopback by default).
#  - Render/Railway/Fly inject PORT automatically; the server honors it.
#  - PowerPoint COM verification is Windows-only, so conversions automatically run in
#    quick mode here (Layer-1 validation still runs). PPTX ingest & PDF export need
#    PowerPoint too and are unavailable on Linux hosts.
FROM ghcr.io/puppeteer/puppeteer:latest

USER root

# Python + libs for the CV/PDF helpers (PDF ingest, decomposition, image diff)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    fonts-liberation \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir pymupdf pillow numpy opencv-python-headless --break-system-packages || \
    pip3 install --no-cache-dir pymupdf pillow numpy opencv-python-headless

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# vendor Tailwind / Font Awesome / fonts / chart libs / OCR data during build,
# so the running container converts fully offline
COPY . .
RUN npm run assets

# bind all interfaces inside the container (loopback would be unreachable)
ENV HOST=0.0.0.0 \
    PORT=4599 \
    NODE_ENV=production

EXPOSE 4599
CMD ["node", "src/server.js"]
