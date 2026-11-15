# Moon Studio Cloud Windows — Docker image
# Full-stack Node.js/Express + React/Vite + QEMU runtime

FROM node:22-bookworm

ENV NODE_ENV=production \
    PORT=3000 \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Runtime tools used by the VM / infrastructure modules.
# QEMU TCG works without /dev/kvm, but is much slower than KVM.
RUN apt-get update && apt-get install -y --no-install-recommends \
    qemu-system-x86 \
    qemu-utils \
    seabios \
    nasm \
    genisoimage \
    iproute2 \
    iptables \
    curl \
    procps \
    imagemagick \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install all package dependencies: tsx is required by the production start script.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Copy application source and build the React/Vite frontend.
COPY . .
RUN npm run build \
    && mkdir -p /app/data/iso /app/data/disks /app/data/logs \
    && chown -R node:node /app

# Keep app files writable for registry, VM disks, ISO images and generated secrets.
USER node

EXPOSE 3000

# Express listens on 0.0.0.0 and reads the platform-provided PORT.
CMD ["npm", "run", "start"]
