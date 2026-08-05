/**
 * Normalization of accessory port mappings.
 *
 * Docker publishes ports by writing rules into iptables' `nat` chain, which is
 * evaluated BEFORE ufw's rules. In other words: `-p 5432:5432` leaves Postgres
 * reachable from the internet even with ufw enabled and that port closed. The
 * firewall does not protect what Docker publishes.
 *
 * So unless the user explicitly names an interface, the binding is pinned to
 * 127.0.0.1. Accessories share a network with the services and resolve by name,
 * so publishing the port is not needed for the app to use them: it only helps
 * connecting from outside, and an SSH tunnel covers that.
 */

export interface PortBinding {
  /** Specification ready for `docker run -p`. */
  spec: string;
  /** true when exposed on every interface (because the user asked for it). */
  isPublic: boolean;
}

const LOOPBACK = '127.0.0.1';

/** IPv4, bracketed IPv6, or the wildcard. */
function looksLikeHost(part: string): boolean {
  return part === '' || /^\d{1,3}(\.\d{1,3}){3}$/.test(part) || part.startsWith('[');
}

export function normalizePortBinding(spec: string): PortBinding {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error('The port mapping is empty.');
  }

  // The protocol (/tcp, /udp) is split off and appended back at the end.
  const slash = trimmed.lastIndexOf('/');
  const proto = slash > -1 ? trimmed.slice(slash) : '';
  const body = slash > -1 ? trimmed.slice(0, slash) : trimmed;

  const parts = body.split(':');

  // ip:host:container — the user already picked an interface, so respect it.
  if (parts.length >= 3 && looksLikeHost(parts[0]!)) {
    const host = parts[0]!;
    return {
      spec: trimmed,
      isPublic: host === '0.0.0.0' || host === '' || host === '[::]',
    };
  }

  // host:container — no interface given, so pin it to the loopback.
  if (parts.length === 2) {
    return { spec: `${LOOPBACK}:${body}${proto}`, isPublic: false };
  }

  // Container port only: Docker would pick a random port on EVERY interface.
  // Pin it to the loopback as well.
  if (parts.length === 1) {
    return { spec: `${LOOPBACK}::${body}${proto}`, isPublic: false };
  }

  throw new Error(`Cannot parse the port mapping: ${spec}`);
}
