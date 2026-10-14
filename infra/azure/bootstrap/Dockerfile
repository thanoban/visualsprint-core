# Mirror the approved PostgreSQL image into the existing private registry after building.
# Release tooling must provide a digest-pinned PostgreSQL 17 image, not a floating tag.
ARG POSTGRES_IMAGE
FROM ${POSTGRES_IMAGE}
COPY --chmod=0444 bootstrap.sql /bootstrap.sql
COPY --chmod=0444 openfga-grants.sql /openfga-grants.sql
COPY --chmod=0444 vector.sql /vector.sql
USER postgres
ENTRYPOINT []
CMD ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-f", "/bootstrap.sql"]
