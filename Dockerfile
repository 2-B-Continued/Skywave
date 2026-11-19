# Skywave: a self-contained web radio for an RTL-SDR dongle.
# Builds the RTL-SDR Blog driver (needed for the V4 / R828D tuner) and runs the app.
FROM debian:bookworm-slim

# Optional extras, switched on at build time:  docker compose build --build-arg WITH_RTLAMR=1
ARG WITH_RTLAMR=0

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        python3 python3-numpy python3-scipy python3-pip python3-sgp4 python3-pil python3-reportlab \
        rtl-433 multimon-ng openssl libusb-1.0-0 libpng16-16 libsndfile1 ffmpeg ca-certificates tzdata \
        build-essential cmake pkg-config git libusb-1.0-0-dev libpng-dev; \
    pip3 install --no-cache-dir --break-system-packages aprslib; \
    pip3 install --no-cache-dir --break-system-packages faster-whisper || echo 'optional caption engine not installed'; \
    pip3 install --no-cache-dir --break-system-packages git+https://github.com/colaclanth/sstv || echo 'optional SSTV package not installed'; \
    git clone --depth 1 https://github.com/dbdexter-dev/meteor_demod /tmp/md; \
    (cd /tmp/md && mkdir -p build && cd build && cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local && make -j"$(nproc)" && make install) || echo 'meteor_demod build failed'; \
    git clone --depth 1 https://github.com/dbdexter-dev/meteor_decode /tmp/mdec; \
    (cd /tmp/mdec && mkdir -p build && cd build && cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local && make -j"$(nproc)" && make install) || echo 'meteor_decode build failed'; \
    rm -rf /tmp/md /tmp/mdec; \
    git clone --depth 1 https://github.com/rtlsdrblog/rtl-sdr-blog /tmp/blog; \
    cmake -S /tmp/blog -B /tmp/blog/build -DCMAKE_INSTALL_PREFIX=/usr/local -DINSTALL_UDEV_RULES=OFF -DDETACH_KERNEL_DRIVER=ON; \
    cmake --build /tmp/blog/build -j"$(nproc)"; \
    cmake --install /tmp/blog/build; \
    ldconfig; \
    rm -rf /tmp/blog; \
    if [ "$WITH_RTLAMR" = "1" ]; then \
        apt-get install -y --no-install-recommends golang-go; \
        (GOPATH=/tmp/go GOBIN=/usr/local/bin go install github.com/bemasher/rtlamr@latest || echo 'rtlamr build failed'); \
        rm -rf /tmp/go /root/.cache/go-build; apt-get purge -y golang-go; \
    fi; \
    apt-get purge -y build-essential cmake pkg-config git libusb-1.0-0-dev libpng-dev; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY *.py /app/
COPY static /app/static

ENV DATA_DIR=/data PORT=8073
VOLUME /data
EXPOSE 8073 8074
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD python3 -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/healthz'%os.environ.get('PORT','8073'),timeout=4)" || exit 1
CMD ["python3", "-u", "server.py"]
