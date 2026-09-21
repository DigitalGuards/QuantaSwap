FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

ARG TOR_VERSION=0.4.9.11-0+deb12u1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends "tor=${TOR_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 tor-runtime \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent \
        --no-create-home --shell /usr/sbin/nologin tor-runtime \
    && install --directory --owner=10001 --group=10001 --mode=0700 \
        /var/lib/quantaswap-tor/data \
        /var/lib/quantaswap-tor/hidden-service

COPY --chown=0:0 --chmod=0644 torrc /etc/tor/torrc
COPY --chown=0:0 --chmod=0755 entrypoint.sh /usr/local/bin/quantaswap-tor

USER 10001:10001

STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
    CMD ["sh", "-ec", "test -s /var/lib/quantaswap-tor/hidden-service/hostname && test -s /var/lib/quantaswap-tor/hidden-service/hs_ed25519_secret_key && grep -q 'Bootstrapped 100% (done)' /var/lib/quantaswap-tor/data/notices.log"]

ENTRYPOINT ["/usr/local/bin/quantaswap-tor"]
