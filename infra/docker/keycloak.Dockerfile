# Keycloak for the self-hosted install (T-0094, RQ-0041, ADR-0037): an optimized build for
# PostgreSQL with health endpoints, the `ledgerforce` realm (placeholders only, no secret) and an
# entrypoint that reads its secrets from compose file secrets. Pinned by digest (Docker Hub copy
# of the official image; quay.io is not reachable from agent sandboxes, RQ-0041 S2).
FROM keycloak/keycloak:26.8.1@sha256:a78d6b79572168cb25886b80a8b5b8d4ed4390743e3eecb810538683e209dd6b AS builder
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM keycloak/keycloak:26.8.1@sha256:a78d6b79572168cb25886b80a8b5b8d4ed4390743e3eecb810538683e209dd6b
COPY --from=builder /opt/keycloak/ /opt/keycloak/
COPY infra/compose/keycloak/ledgerforce-realm.json /opt/keycloak/data/import/ledgerforce-realm.json
COPY infra/docker/keycloak-entrypoint.sh /opt/keycloak/bin/lf-entrypoint.sh
USER 1000
ENTRYPOINT ["/opt/keycloak/bin/lf-entrypoint.sh"]
