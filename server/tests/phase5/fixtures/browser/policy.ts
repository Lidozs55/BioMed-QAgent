/**
 * Test-mode browser egress policy for P5-07 fixture servers.
 *
 * The strict production policy enforces HTTPS + port 443 + global DNS; local
 * fixture servers run on ``http://127.0.0.1:<port>``, so tests inject this
 * policy instead. It permits only the configured hosts (loopback by default)
 * and can record validations or deny specific URLs, which lets tests prove
 * the route interception layer validates each hop.
 */

import { UnsafeUrlError } from "../../../../src/external/network/errors.js";
import type { BrowserEgressPolicy } from "../../../../src/external/browser/egress.js";

export interface FixturePolicyOptions {
  /** Hosts the policy permits (default: 127.0.0.1 only). */
  allowedHosts?: ReadonlySet<string>;
  /** Called with every validated URL (both layers). */
  onValidate?: (url: string) => void;
  /** Predicate returning true rejects the URL (UnsafeUrlError). */
  deny?: (url: string) => boolean;
}

export function fixtureEgressPolicy(options: FixturePolicyOptions = {}): BrowserEgressPolicy {
  const allowedHosts = options.allowedHosts ?? new Set(["127.0.0.1"]);
  const onValidate = options.onValidate ?? (() => undefined);
  const deny = options.deny ?? (() => false);
  return {
    validateUrl: async (url, authorizedHosts) => {
      const parsed = new URL(url);
      const host = parsed.hostname;
      onValidate(url);
      if (!allowedHosts.has(host)) {
        throw new UnsafeUrlError(`browser host is not authorized for this context: ${host}`);
      }
      if (deny(url)) {
        throw new UnsafeUrlError(`fixture policy denied URL: ${url}`);
      }
      authorizedHosts.add(host);
      return host;
    },
  };
}
