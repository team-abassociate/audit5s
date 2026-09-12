/**
 * Which template rendered a snapshot (§5.8's `template_version`).
 *
 * Bump it when the layout changes in a way that would make a re-render differ from the
 * document already issued. It is recorded on every snapshot, so "why does v3 look unlike
 * v1" has an answer that does not require reading git history.
 *
 * It is also the byte-stability suite's canary: the fixed-payload fixture pins this value,
 * so changing the layout without acknowledging it fails there rather than in front of a
 * customer holding two reports that should have matched.
 */
export const TEMPLATE_VERSION = '1.0.0';

/** §10.5: the renderer selects by the payload's schema version, not by today's code. */
export const SUPPORTED_PAYLOAD_SCHEMA_VERSIONS = [1] as const;
