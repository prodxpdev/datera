/**
 * The core's only route to the network.
 *
 * It exists because the core must not import `node:http` (invariant §1.7, enforced by the
 * purity guard), and because every outbound call in Datera is a transparency-relevant
 * event: talking to a model provider is a thing the user is entitled to see, not a
 * detail. Funnelling it through one port makes "what did Datera send, and where" a
 * question with a single answer.
 *
 * Note what it does not have: no streaming, no cookies, no redirects by default. Datera
 * makes a small number of well-defined JSON calls, and a richer client would mostly be
 * surface area for something to go wrong in.
 */
export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  /** Hard ceiling. Detection probes use a short one so a dead port cannot hang the UI. */
  readonly timeoutMs?: number | undefined;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpPort {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * The port a host installs when Datera must not reach the network at all.
 *
 * Used by the offline tests, and available to a host that wants to guarantee it: every
 * call fails fast and identifiably rather than hanging.
 */
export class OfflineHttp implements HttpPort {
  async send(request: HttpRequest): Promise<HttpResponse> {
    throw new Error(`Network access is disabled in this host (attempted ${request.method} ${request.url})`);
  }
}
