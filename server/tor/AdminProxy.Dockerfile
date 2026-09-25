FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

ARG SOCAT_VERSION=1.7.4.4-2

RUN apt-get update \
    && apt-get install --yes --no-install-recommends "socat=${SOCAT_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 admin-proxy \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent \
        --no-create-home --shell /usr/sbin/nologin admin-proxy

USER 10001:10001

STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
    CMD ["socat", "-T2", "-u", "OPEN:/dev/null", "TCP:orderbook:8091,connect-timeout=2"]

ENTRYPOINT ["socat", "TCP-LISTEN:8091,reuseaddr,fork,backlog=128", "TCP:orderbook:8091,connect-timeout=5"]
