FROM postgres:18-alpine

# The archiver and backup sidecar must use the same pgBackRest build.
RUN apk add --no-cache pgbackrest
