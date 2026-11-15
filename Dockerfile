
# Moon Studio Cloud Windows
# Full-stack React + Express + QEMU + XRDP

FROM node:22-bookworm

ENV NODE_ENV=production \
    PORT=3000 \
    DEBIAN_FRONTEND=noninteractive \
    HOME=/root

WORKDIR /app

# System dependencies and desktop environment
RUN apt-get update && apt-get install -y --no-install-recommends \
    qemu-system-x86 \
    qemu-utils \
    seabios \
    nasm \
    genisoimage \
    xrdp \
    xorgxrdp \
    xfce4-session \
    xfwm4 \
    xfce4-panel \
    xfdesktop4 \
    thunar \
    chromium \
    falkon \
    dbus \
    dbus-x11 \
    ssl-cert \
    xfce4-terminal \
    desktop-base \
    iproute2 \
    iptables \
    curl \
    wget \
    procps \
    sudo \
    ca-certificates \
    imagemagick \
    && rm -rf /var/lib/apt/lists/*

# Install bore tunnel binary
RUN ARCH="$(dpkg --print-architecture)" && \
    if [ "$ARCH" = "amd64" ]; then \
      curl -fsSL https://github.com/ekzhang/bore/releases/download/v0.5.2/bore-v0.5.2-x86_64-unknown-linux-musl.tar.gz \
      -o /tmp/bore.tar.gz && \
      tar -xzf /tmp/bore.tar.gz -C /usr/local/bin && \
      chmod +x /usr/local/bin/bore && \
      rm /tmp/bore.tar.gz; \
    fi

# Install Node dependencies
COPY package.json ./
RUN npm install --no-audit --no-fund

# Copy source code
COPY . .

# Build frontend
RUN npm run build

# Prepare runtime directories
RUN mkdir -p \
    /app/data/iso \
    /app/data/disks \
    /app/data/logs \
    /run/dbus \
    /run/xrdp \
    /var/run/xrdp \
    /home/Administrator \
    /var/lib/apt/lists/partial \
    && chmod 755 /run/dbus /run/xrdp /var/run/xrdp \
    && chmod 755 /home/Administrator \
    && chown -R root:root /app

# Root is required by the current runtime implementation
# for apt, user management, XRDP and QEMU operations.
USER root

EXPOSE 3000

CMD ["npm", "run", "start"]
